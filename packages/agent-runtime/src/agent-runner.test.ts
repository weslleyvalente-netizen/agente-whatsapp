import { describe, it, expect } from "vitest";
import { formatHistoryForLLM, buildSystemPrompt } from "./agent-runner.js";
import { buildDynamicContextBlock, buildCacheableSystemMessages, deriveCacheStatus } from "./agent-runner.js";
import { extractToolCallTrace } from "./agent-runner.js";
import type { Message } from "@aula-agente/shared";

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: "msg-1",
    conversation_id: "conv-1",
    organization_id: "org-1",
    evolution_message_id: null,
    role: "contact",
    content: "",
    media_url: null,
    media_type: null,
    metadata: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("formatHistoryForLLM", () => {
  it("maps contact messages to the user role and everything else to assistant", () => {
    const messages = [
      makeMessage({ role: "contact", content: "Oi" }),
      makeMessage({ role: "agent", content: "Olá! Como posso ajudar?" }),
      makeMessage({ role: "human_agent", content: "Um instante" }),
    ];
    expect(formatHistoryForLLM(messages)).toEqual([
      { role: "user", content: "Oi" },
      { role: "assistant", content: "Olá! Como posso ajudar?" },
      { role: "assistant", content: "Um instante" },
    ]);
  });

  // Unsupported WhatsApp events (reactions, protocol messages, etc.) are
  // saved with empty content. The Anthropic API rejects the entire request
  // if any message has empty content, so a single stray empty message
  // anywhere in history permanently blocked every future reply in that
  // conversation — verified live against a real conversation stuck this way.
  it("drops empty-content messages instead of passing them to the model", () => {
    const messages = [
      makeMessage({ role: "contact", content: "Oi" }),
      makeMessage({ role: "contact", content: "" }),
      makeMessage({ role: "human_agent", content: "   " }),
      makeMessage({ role: "agent", content: "Tudo bem?" }),
    ];
    expect(formatHistoryForLLM(messages)).toEqual([
      { role: "user", content: "Oi" },
      { role: "assistant", content: "Tudo bem?" },
    ]);
  });
});

describe("buildSystemPrompt", () => {
  it("appends the current date and time, in pt-BR, São Paulo time, after the base prompt", () => {
    const now = new Date("2026-07-24T17:32:00.000Z"); // 14:32 in São Paulo (UTC-3)
    const result = buildSystemPrompt("Você é a Helena.", now);
    expect(result).toBe("Você é a Helena.\n\nData e hora atual: sexta-feira, 24 de julho de 2026 às 14:32");
  });
});

describe("buildCacheableSystemMessages", () => {
  const now = new Date("2026-07-24T17:32:00.000Z");

  it("splits the prompt into a cached static block and an uncached dynamic block", () => {
    const messages = buildCacheableSystemMessages("Você é a Helena.", now);
    expect(messages).toEqual([
      {
        role: "system",
        content: "Você é a Helena.",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      {
        role: "system",
        content: buildDynamicContextBlock(now),
      },
    ]);
  });

  it("concatenates to exactly what buildSystemPrompt produces as a single string", () => {
    const messages = buildCacheableSystemMessages("Você é a Helena.", now);
    const concatenated = messages.map((m) => m.content).join("");
    expect(concatenated).toBe(buildSystemPrompt("Você é a Helena.", now));
  });

  it("never puts provider options on the dynamic (datetime) block", () => {
    const messages = buildCacheableSystemMessages("Você é a Helena.", now);
    expect(messages[1].providerOptions).toBeUndefined();
  });
});

describe("deriveCacheStatus", () => {
  it("reports write when cache tokens were written, regardless of reads", () => {
    expect(deriveCacheStatus(0, 1800)).toBe("write");
  });

  it("reports hit when tokens were read and nothing was written", () => {
    expect(deriveCacheStatus(1800, 0)).toBe("hit");
  });

  it("reports none when caching had no effect", () => {
    expect(deriveCacheStatus(0, 0)).toBe("none");
  });
});

describe("extractToolCallTrace", () => {
  it("marks every tool call as real when sandbox is false", () => {
    const steps = [
      {
        toolCalls: [{ toolCallId: "1", toolName: "searchKnowledge", input: { query: "preço" } }],
        toolResults: [{ toolCallId: "1", output: "resultado" }],
      },
    ];
    const trace = extractToolCallTrace(steps, false);
    expect(trace).toEqual([
      expect.objectContaining({ tool_name: "searchKnowledge", input: { query: "preço" }, output: "resultado", mode: "real" }),
    ]);
  });

  it("marks createTask and sendVehiclePhoto as simulated when sandbox is true, but leaves search tools real", () => {
    const steps = [
      {
        toolCalls: [
          { toolCallId: "1", toolName: "searchKnowledge", input: {} },
          { toolCallId: "2", toolName: "createTask", input: {} },
        ],
        toolResults: [
          { toolCallId: "1", output: "ok" },
          { toolCallId: "2", output: "[SIMULADO] ..." },
        ],
      },
    ];
    const trace = extractToolCallTrace(steps, true);
    expect(trace.find((t) => t.tool_name === "searchKnowledge")?.mode).toBe("real");
    expect(trace.find((t) => t.tool_name === "createTask")?.mode).toBe("simulated");
  });

  it("returns an empty array when no step made any tool call", () => {
    expect(extractToolCallTrace([{ toolCalls: [], toolResults: [] }], false)).toEqual([]);
  });
});
