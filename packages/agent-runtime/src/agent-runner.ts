import { generateText, stepCountIs } from "ai";
import type { LanguageModel, SystemModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Agent, LLMProvider, Message, PlaygroundToolCall } from "@aula-agente/shared";
import { formatDateTimeForPrompt } from "@aula-agente/shared";
import { buildToolsForAgent } from "./tools/registry.js";

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

const SANDBOXED_TOOL_NAMES = new Set(["createTask", "sendVehiclePhoto"]);

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
// prompt cache matches on exact block content.
export function buildDynamicContextBlock(now: Date): string {
  return `\n\nData e hora atual: ${formatDateTimeForPrompt(now)}`;
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
export function buildCacheableSystemMessages(basePrompt: string, now: Date): SystemModelMessage[] {
  return [
    {
      role: "system",
      content: basePrompt,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    {
      role: "system",
      content: buildDynamicContextBlock(now),
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

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const { agent, messages, currentMessage, apiKey, organizationId, conversationId, instanceId, phone, contactId } =
    params;

  const startTime = Date.now();

  const model = createModel(agent.provider, agent.model, apiKey);

  const tools = buildToolsForAgent({
    organizationId,
    agentId: agent.id,
    toolsConfig: agent.tools_config,
    apiKey,
    conversationId,
    instanceId,
    phone,
    contactId,
    sandbox: params.sandbox,
  });

  const history = formatHistoryForLLM(messages);

  const result = await generateText({
    model,
    system: buildCacheableSystemMessages(agent.system_prompt, new Date()),
    messages: [
      ...history,
      { role: "user", content: currentMessage.content },
    ],
    tools,
    stopWhen: stepCountIs(5), // Max tool calling iterations
    temperature: agent.temperature,
    maxOutputTokens: agent.max_tokens,
  });

  const latencyMs = Date.now() - startTime;

  const toolCalls = result.steps
    .flatMap((step) => step.toolCalls || [])
    .map((tc) => tc.toolName);

  const inputTokens = result.usage?.inputTokens || 0;
  const outputTokens = result.usage?.outputTokens || 0;
  const cacheReadTokens = result.usage?.inputTokenDetails?.cacheReadTokens || 0;
  const cacheWriteTokens = result.usage?.inputTokenDetails?.cacheWriteTokens || 0;
  const cacheStatus = deriveCacheStatus(cacheReadTokens, cacheWriteTokens);

  console.log(
    `[agent-runtime] cache=${cacheStatus} agent=${agent.id} inputTokens=${inputTokens} ` +
      `cacheReadTokens=${cacheReadTokens} cacheWriteTokens=${cacheWriteTokens} outputTokens=${outputTokens}`
  );

  return {
    text: result.text,
    model: agent.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheStatus,
    latencyMs,
    toolCalls,
    toolCallTrace: extractToolCallTrace(result.steps, params.sandbox ?? false),
  };
}
