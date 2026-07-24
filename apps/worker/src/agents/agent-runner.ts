import { generateText, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Agent, LLMProvider, Message } from "@aula-agente/shared";
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
}

interface RunAgentResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolCalls: string[];
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
  const { agent, messages, currentMessage, apiKey, organizationId, conversationId, instanceId, phone } = params;

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
  });

  const history = formatHistoryForLLM(messages);

  const result = await generateText({
    model,
    system: agent.system_prompt,
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
  };
}
