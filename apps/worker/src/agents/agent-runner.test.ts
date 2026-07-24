import { describe, it, expect } from "vitest";
import { formatHistoryForLLM } from "./agent-runner.js";
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
