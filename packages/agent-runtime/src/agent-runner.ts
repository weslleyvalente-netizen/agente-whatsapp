import { generateText, stepCountIs } from "ai";
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

interface RunAgentResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
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

function createModel(provider: LLMProvider, modelName: string, apiKey: string) {
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

export function buildSystemPrompt(basePrompt: string, now: Date): string {
  return `${basePrompt}\n\nData e hora atual: ${formatDateTimeForPrompt(now)}`;
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
    system: buildSystemPrompt(agent.system_prompt, new Date()),
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

  return {
    text: result.text,
    model: agent.model,
    inputTokens: result.usage?.inputTokens || 0,
    outputTokens: result.usage?.outputTokens || 0,
    latencyMs,
    toolCalls,
    toolCallTrace: extractToolCallTrace(result.steps, params.sandbox ?? false),
  };
}
