import { generateText, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Agent, LLMProvider, Message } from "@aula-agente/shared";
import { buildToolsForAgent } from "./tools/registry";

interface RunAgentParams {
  agent: Agent;
  messages: Message[];
  currentMessage: Message;
  apiKey: string;
  organizationId: string;
}

interface RunAgentResult {
  text: string;
  model: string;
  tokensUsed: number;
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

function formatHistoryForLLM(messages: Message[]) {
  return messages.map((msg) => ({
    role: msg.role === "contact" ? "user" as const : "assistant" as const,
    content: msg.content,
  }));
}

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const { agent, messages, currentMessage, apiKey, organizationId } = params;

  const startTime = Date.now();

  const model = createModel(agent.provider, agent.model, apiKey);

  const tools = buildToolsForAgent({
    organizationId,
    agentId: agent.id,
    toolsConfig: agent.tools_config,
    apiKey,
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
    tokensUsed: result.usage?.totalTokens || 0,
    latencyMs,
    toolCalls,
  };
}
