import { generateText, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage, SystemModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Agent, LLMProvider, Message, PlaygroundToolCall } from "@aula-agente/shared";
import { formatDateTimeForPrompt, DEFAULT_FOLLOWUP_AUTOMATICO } from "@aula-agente/shared";
import { buildToolsForAgent } from "./tools/registry.js";
import { ATTENDANCE_CONTEXT, RECOVERY_INSTRUCTION, needsAttendanceAnswer, isGenericWaiting } from "./attendance-continuity.js";
import { extractTokenUsage } from "./token-usage.js";

interface RunAgentParams {
  agent: Agent;
  messages: Message[];
  currentMessage: Message;
  apiKey: string;
  organizationId: string;
  conversationId: string;
  instanceId: string;
  phone: string;
  contactId: string;
  contactName?: string | null;
  sandbox?: boolean;
}

// "write" = this call had to (re)populate the cache (first message of a
// conversation, or the previous cache entry expired after 5 min idle).
// "hit" = the static system+tools block was served from cache. "none" =
// caching had no effect (e.g. cache_control wasn't sent, or the model
// response didn't report any cache activity).
export type CacheStatus = "hit" | "write" | "none";

interface RunAgentResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheStatus: CacheStatus;
  latencyMs: number;
  toolCalls: string[];
  toolCallTrace: PlaygroundToolCall[];
}

// Keep this aligned with the mutation tools isolated by registry.ts in sandbox.
const SANDBOXED_TOOL_NAMES = new Set([
  "createTask", "sendVehiclePhoto", "updateQualification", "requestHuman", "sendRegisteredImage",
]);

export function extractToolCallTrace(
  steps: Array<{
    toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
    toolResults?: Array<{ toolCallId: string; output: unknown }>;
  }>,
  sandbox: boolean
): PlaygroundToolCall[] {
  const trace: PlaygroundToolCall[] = [];
  const executedAt = new Date().toISOString();
  for (const step of steps) {
    const outputsByCallId = new Map((step.toolResults || []).map((r) => [r.toolCallId, r.output]));
    for (const call of step.toolCalls || []) {
      trace.push({
        tool_name: call.toolName,
        input: call.input,
        output: outputsByCallId.get(call.toolCallId) ?? null,
        mode: sandbox && SANDBOXED_TOOL_NAMES.has(call.toolName) ? "simulated" : "real",
        executed_at: executedAt,
      });
    }
  }
  return trace;
}

export function createModel(provider: LLMProvider, modelName: string, apiKey: string): LanguageModel {
  switch (provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(modelName);
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelName);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelName);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Isolated so the ever-changing timestamp never lands in the same block as
// the static prompt text — concatenating them (as buildSystemPrompt does)
// would force a cache rewrite on literally every call, since Anthropic's
// prompt cache matches on exact block content. contactName lives here too,
// for the same reason: it's constant within one conversation but different
// across conversations of the same agent, so it can never sit in the
// agent-level cached block without corrupting the cache across contacts.
//
// The raw WhatsApp display name is handed to the model as-is rather than
// parsed in code — it's arbitrary user-set text ("Dauanaguimaraes23", but
// also plausibly "Moto e Trilha Yamaha" or a group name), and judging
// whether it's actually a person's name is exactly the kind of ambiguous
// call the model is already trusted to make throughout the rest of the
// prompt.
export function buildDynamicContextBlock(now: Date, contactName?: string | null): string {
  let block = `\n\nData e hora atual: ${formatDateTimeForPrompt(now)}`;
  if (contactName) {
    block +=
      `\n\nNome salvo deste contato no WhatsApp: "${contactName}". Se for claramente um nome de pessoa, ` +
      `use o primeiro nome dela(e) de forma natural ao longo da conversa (ex.: "Oi, {primeiro nome}!"). ` +
      `Se parecer nome de empresa, grupo, apelido genérico, ou não for claramente um nome de pessoa, ` +
      `não presuma e não use.`;
  }
  return block + ATTENDANCE_CONTEXT;
}

export function buildSystemPrompt(basePrompt: string, now: Date): string {
  return `${basePrompt}${buildDynamicContextBlock(now)}`;
}

// Two system blocks instead of one: the compiled agent prompt (identical
// across every message of every conversation until the org republishes)
// gets marked cache_control so Anthropic caches it; the timestamp — which
// changes on every single call — stays in a separate, uncached block right
// after it. Concatenating them into one string first (as buildSystemPrompt
// does) and only then trying to cache it would defeat the cache entirely.
export function buildCacheableSystemMessages(
  basePrompt: string,
  now: Date,
  contactName?: string | null
): SystemModelMessage[] {
  return [
    {
      role: "system",
      content: basePrompt,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    {
      role: "system",
      content: buildDynamicContextBlock(now, contactName),
    },
  ];
}

// "write" only ever happens together with 0 reads (a fresh/expired cache
// entry gets created, nothing to read yet); "hit" means the write from an
// earlier call in this conversation paid off.
export function deriveCacheStatus(cacheReadTokens: number, cacheWriteTokens: number): CacheStatus {
  if (cacheWriteTokens > 0) return "write";
  if (cacheReadTokens > 0) return "hit";
  return "none";
}

export function formatHistoryForLLM(messages: Message[]) {
  // Unsupported WhatsApp events (reactions, protocol messages, etc.) are
  // saved with empty content. The Anthropic API rejects the entire request
  // if any message has empty content, so a single stray empty message
  // anywhere in the last 20 permanently blocks every future reply in that
  // conversation — verified live against a real conversation stuck this way.
  return messages
    .filter((msg) => msg.content.trim())
    .map((msg) => ({
      role: msg.role === "contact" ? "user" as const : "assistant" as const,
      content: msg.content,
    }));
}

// Every final turn is sent as "user", including the stale-conversation
// follow-up worker's synthetic nudge (currentMessage.role === "system") —
// NOT as an actual ModelMessage system role. An earlier version special-cased
// role: "system" into a trailing {role: "system", ...} entry inside
// `messages`, reasoning the model should see an operational instruction
// rather than something that looks like the customer speaking. That broke
// any Google/Gemini-provider agent: @ai-sdk/google's message conversion
// stops allowing system messages once a user turn has been seen and throws
// UnsupportedFunctionalityError for a trailing one, silently killing every
// auto-followup send for those agents (swallowed by the worker's per-
// conversation try/catch). "Not the customer speaking" is instead conveyed
// by content alone — buildFollowupNudgeInstruction (apps/worker/src/lib/
// followup-nudge.ts) already writes the nudge in the third person as an
// instruction to Helena ("O cliente não respondeu..."), never as if the
// customer were typing it.
export function buildFinalTurnMessage(currentMessage: Pick<Message, "role" | "content">): ModelMessage {
  return { role: "user", content: currentMessage.content };
}

// Only acknowledge outcomes confirmed by the tool; never expose internal instructions.
function handoffFallbackText(output: unknown): string {
  if (typeof output === "string" && output.startsWith("Handoff registrado")) {
    return /reabrir|fora do hor[aá]rio/i.test(output)
      ? "Um consultor vai continuar o atendimento assim que o atendimento reabrir."
      : "Um consultor vai continuar o atendimento a partir de agora.";
  }
  if (typeof output === "string" && output.startsWith("[SIMULADO]")) {
    return "Na simulação, um consultor seria acionado para continuar o atendimento.";
  }
  return "Não consegui confirmar se foi possível acionar um consultor agora. Por favor, tente novamente em instantes.";
}

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const { agent, messages, currentMessage, apiKey, organizationId, conversationId, instanceId, phone, contactId } =
    params;

  const startTime = Date.now();

  const model = createModel(agent.provider, agent.model, apiKey);

  // requestHuman uses the same business-hours window as the automatic
  // follow-up feature to decide whether to tell the customer a consultant
  // continues right away or only once the store reopens — one config knob,
  // not a second one just for this tool.
  const businessHours = agent.tools_config.followup_automatico ?? DEFAULT_FOLLOWUP_AUTOMATICO;

  const tools = buildToolsForAgent({
    organizationId,
    agentId: agent.id,
    toolsConfig: agent.tools_config,
    apiKey,
    conversationId,
    instanceId,
    phone,
    contactId,
    businessHoursStartHour: businessHours.janela_inicio_hora ?? DEFAULT_FOLLOWUP_AUTOMATICO.janela_inicio_hora,
    businessHoursEndHour: businessHours.janela_fim_hora ?? DEFAULT_FOLLOWUP_AUTOMATICO.janela_fim_hora,
    sandbox: params.sandbox,
  });

  const history = formatHistoryForLLM(messages);

  const system = buildCacheableSystemMessages(agent.system_prompt, new Date(), params.contactName);
  const initialMessages = [...history, buildFinalTurnMessage(currentMessage)];
  const result = await generateText({
    model,
    system,
    messages: initialMessages,
    tools,
    stopWhen: stepCountIs(5), // Max tool calling iterations
    temperature: agent.temperature,
    maxOutputTokens: agent.max_tokens,
  });

  let text = result.text;
  const toolCallTrace = extractToolCallTrace(result.steps, params.sandbox ?? false);
  const totals = extractTokenUsage(result.totalUsage ?? result.usage);
  const originalHandoff = toolCallTrace.find((call) => call.tool_name === "requestHuman");
  const photoSent = toolCallTrace.some((call) => ["sendVehiclePhoto", "sendRegisteredImage"].includes(call.tool_name) &&
    typeof call.output === "string" && /^(?:(?:Foto|Imagem) enviada\.|\[SIMULADO\].*(?:foto|imagem))/i.test(call.output));
  const needsAnswer = currentMessage.role === "contact" && needsAttendanceAnswer(currentMessage.content);
  if (needsAnswer && (isGenericWaiting(text) || (!text.trim() && result.steps.length >= 5 && !photoSent))) {
    // Reuse SDK assistant/tool history, but never repeat tool mutations on recovery.
    let recoveryMessages: ModelMessage[] = [];
    try {
      const recovery = await generateText({
        model,
        system: [...system, { role: "system" as const, content: RECOVERY_INSTRUCTION }],
        messages: [...initialMessages, ...result.response.messages],
        temperature: agent.temperature,
        maxOutputTokens: agent.max_tokens,
      });
      text = recovery.text;
      recoveryMessages = recovery.response.messages;
      const extra = extractTokenUsage(recovery.totalUsage ?? recovery.usage);
      totals.inputTokens += extra.inputTokens;
      totals.outputTokens += extra.outputTokens;
      totals.cacheReadTokens += extra.cacheReadTokens;
      totals.cacheWriteTokens += extra.cacheWriteTokens;
    } catch {
      // Original mutations already ran. Fall back without repeating them, and
      // retain only reported usage: a failed generation supplies no token totals.
      text = "";
    }
    if (!text.trim() || isGenericWaiting(text)) {
      text = originalHandoff
        ? handoffFallbackText(originalHandoff.output)
        : "Não consegui esclarecer sua pergunta agora. Pode reformular o ponto que deseja esclarecer?";
      if (!params.sandbox && !originalHandoff && tools.requestHuman?.execute) {
        const input = { motivo: "fora_escopo", resumo: `Falha repetida em responder: ${currentMessage.content.slice(0, 500)}`, urgencia: "normal" };
        let output: unknown;
        try {
          output = await tools.requestHuman.execute(input, {
            toolCallId: "attendance-continuity-handoff",
            context: undefined,
            messages: [...initialMessages, ...result.response.messages, ...recoveryMessages],
          });
        } catch {
          // Retain the attempted call without leaking exception details to the customer.
          output = { error: "requestHuman execution failed" };
        }
        toolCallTrace.push({ tool_name: "requestHuman", input, output, mode: "real", executed_at: new Date().toISOString() });
        text = handoffFallbackText(output);
      }
    }
  }
  const latencyMs = Date.now() - startTime;
  const toolCalls = toolCallTrace.map((call) => call.tool_name);
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = totals;
  const cacheStatus = deriveCacheStatus(cacheReadTokens, cacheWriteTokens);

  console.log(
    `[agent-runtime] cache=${cacheStatus} agent=${agent.id} inputTokens=${inputTokens} ` +
      `cacheReadTokens=${cacheReadTokens} cacheWriteTokens=${cacheWriteTokens} outputTokens=${outputTokens}`
  );

  return {
    text,
    model: agent.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheStatus,
    latencyMs,
    toolCalls,
    toolCallTrace,
  };
}
