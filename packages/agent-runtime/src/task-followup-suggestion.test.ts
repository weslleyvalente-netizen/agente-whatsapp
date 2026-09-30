import { describe, it, expect, vi, beforeEach } from "vitest";

const { generateObject, createModel, extractTokenUsage, recordAiUsageEvent, getAdminClient } = vi.hoisted(() => ({
  generateObject: vi.fn(),
  createModel: vi.fn(() => "fake-model"),
  extractTokenUsage: vi.fn((usage: any) => ({
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
  })),
  recordAiUsageEvent: vi.fn().mockResolvedValue(undefined),
  getAdminClient: vi.fn(() => ({})),
}));

vi.mock("ai", () => ({ generateObject }));
vi.mock("./agent-runner.js", () => ({ createModel }));
vi.mock("./token-usage.js", () => ({ extractTokenUsage }));
vi.mock("@aula-agente/database", () => ({ recordAiUsageEvent, getAdminClient }));

import {
  generateTaskFollowupSuggestion,
  buildTaskFollowupSystemPrompt,
} from "./task-followup-suggestion.js";

const baseParams = {
  organizationId: "org-1",
  agentId: "agent-1",
  provider: "anthropic" as const,
  model: "claude-sonnet-5",
  apiKey: "key-1",
  task: { type: "proposal_followup" as const, description: "Cliente sumiu depois da proposta" },
  reuseTaskDescriptionIfLiberaCred: false,
  context: {
    recentMessages: [{ role: "contact", content: "vou pensar" }],
    qualificationSummary: "Interessado na Factor 150, 12x",
    opportunity: { stage: "proposal_sent", creditAmount: null, saleAmount: 22000, bidAmount: null },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  recordAiUsageEvent.mockResolvedValue(undefined);
});

describe("generateTaskFollowupSuggestion", () => {
  it("reuses the task description as-is for a libera_cred_resumption task on first generation, without calling generateObject", async () => {
    const result = await generateTaskFollowupSuggestion({
      ...baseParams,
      task: { type: "libera_cred_resumption", description: "Já apresentada: 12x de R$706,27 na Factor 150" },
      reuseTaskDescriptionIfLiberaCred: true,
    });

    expect(result.message).toBe("Já apresentada: 12x de R$706,27 na Factor 150");
    expect(generateObject).not.toHaveBeenCalled();
    expect(recordAiUsageEvent).not.toHaveBeenCalled();
  });

  it("generates a fresh suggestion via generateObject and records ai usage", async () => {
    generateObject.mockResolvedValue({
      object: { message: "Oi! Ainda ficou alguma dúvida sobre a Factor 150 no plano de 12x?" },
      usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    const result = await generateTaskFollowupSuggestion(baseParams);

    expect(result.message).toBe("Oi! Ainda ficou alguma dúvida sobre a Factor 150 no plano de 12x?");
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(recordAiUsageEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-1",
        agentId: "agent-1",
        source: "task_followup_suggestion",
        inputTokens: 500,
        outputTokens: 40,
      })
    );
  });

  it("also generates fresh (does not reuse description) for libera_cred_resumption when regenerating", async () => {
    generateObject.mockResolvedValue({
      object: { message: "Nova sugestão regenerada" },
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    const result = await generateTaskFollowupSuggestion({
      ...baseParams,
      task: { type: "libera_cred_resumption", description: "Sugestão antiga" },
      reuseTaskDescriptionIfLiberaCred: false, // "Gerar outra" was clicked
    });

    expect(result.message).toBe("Nova sugestão regenerada");
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("falls back to a safe generic message when generateObject fails, without throwing", async () => {
    generateObject.mockRejectedValue(new Error("model timeout"));

    const result = await generateTaskFollowupSuggestion(baseParams);

    expect(result.message).toContain("Oi!");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("reports a cost recording failure instead of pretending the generic message was generated", async () => {
    generateObject.mockResolvedValue({ object: { message: "Mensagem personalizada" }, usage: { inputTokens: 10, outputTokens: 5 } });
    recordAiUsageEvent.mockRejectedValue(new Error("source check constraint"));
    const result = await generateTaskFollowupSuggestion(baseParams);
    expect(result.generated).toBe(false);
  });

  it("includes the prior suggestion and asks for a different approach", async () => {
    generateObject.mockResolvedValue({ object: { message: "Outra abordagem" }, usage: {} });
    await generateTaskFollowupSuggestion({ ...baseParams, previousMessage: "Texto anterior" });
    expect(generateObject.mock.calls[0][0].prompt).toContain("Texto anterior");
    expect(generateObject.mock.calls[0][0].prompt).toContain("abordagem diferente");
  });

  it("falls back to a safe generic message when the model returns an empty message", async () => {
    generateObject.mockResolvedValue({
      object: { message: "" },
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    const result = await generateTaskFollowupSuggestion(baseParams);

    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("buildTaskFollowupSystemPrompt", () => {
  it("instructs the model to never invent facts not present in the given context", () => {
    const prompt = buildTaskFollowupSystemPrompt();
    expect(prompt.toLowerCase()).toContain("nunca invente");
    expect(prompt.toLowerCase()).toContain("atendente");
  });
});
