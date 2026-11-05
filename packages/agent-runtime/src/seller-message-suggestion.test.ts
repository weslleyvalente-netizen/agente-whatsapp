import { describe, it, expect, vi, beforeEach } from "vitest";

const { generateObject, createModel, extractTokenUsage, recordAiUsageEvent, getAdminClient } = vi.hoisted(() => ({
  generateObject: vi.fn(),
  createModel: vi.fn(() => "fake-model"),
  extractTokenUsage: vi.fn((usage: any) => ({ inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 })),
  recordAiUsageEvent: vi.fn().mockResolvedValue(undefined),
  getAdminClient: vi.fn(() => ({})),
}));

vi.mock("ai", () => ({ generateObject }));
vi.mock("./agent-runner.js", () => ({ createModel }));
vi.mock("./token-usage.js", () => ({ extractTokenUsage }));
vi.mock("@aula-agente/database", () => ({ recordAiUsageEvent, getAdminClient }));

import { buildSellerMessageSystemPrompt, buildSellerMessageUserPrompt, generateSellerMessageSuggestion } from "./seller-message-suggestion.js";

const context = {
  customerFirstName: "Ana",
  originLabel: "Instagram — anúncio",
  handoffSummary: "Quer uma Factor 150 com parcela até 700",
  qualificationSummary: "Primeira moto",
  opportunity: { stage: "qualified", operation: "consorcio_moto", product: "Factor 150", creditAmount: 15000, installmentAmount: 700, downPaymentAmount: null, bidAmount: null },
  nudgeCount: 2,
  recentMessages: [
    { role: "contact", content: "Quero uma Factor" },
    { role: "agent", content: "Posso te passar para a vendedora?" },
    { role: "human_agent", content: "Oi Ana!" },
    { role: "contact", content: "[audio]" },
  ],
};
const base = { organizationId: "org-1", agentId: "agent-1", provider: "anthropic" as const, model: "claude-sonnet-5", apiKey: "k", mode: "first_contact" as const, context };

beforeEach(() => { vi.clearAllMocks(); recordAiUsageEvent.mockResolvedValue(undefined); });

describe("prompt", () => {
  it("system traz as regras proibidas e o método", () => {
    const s = buildSellerMessageSystemPrompt();
    for (const t of ["Nunca invente", "UMA pergunta", "vamos fechar", "última chance", "promessa de contemplação", "placeholders", "até 4 linhas"]) expect(s).toContain(t);
  });
  it("primeiro atendimento: modo, nome, resumo, origem e roles mapeados", () => {
    const u = buildSellerMessageUserPrompt(base);
    expect(u).toContain("Modo: primeiro atendimento");
    expect(u).toContain("Primeiro nome do cliente: Ana");
    expect(u).toContain("Instagram — anúncio");
    expect(u).toContain("Quer uma Factor 150");
    expect(u).toContain("[cliente] Quero uma Factor");
    expect(u).toContain("[IA] Posso te passar");
    expect(u).toContain("[vendedora] Oi Ana!");
    expect(u).toContain("parcela confortável=");
    expect(u).not.toContain("Toques de 'Cutucar cliente'");
    expect(u).not.toContain("[contact]");
  });
  it("follow-up: modo, toques e áudio sem texto marcado como desconhecido", () => {
    const u = buildSellerMessageUserPrompt({ ...base, mode: "followup", previousMessage: "Oi de novo" });
    expect(u).toContain("Modo: follow-up");
    expect(u).toContain("Toques de 'Cutucar cliente' já feitos: 2");
    expect(u).toContain("Sugestão anterior: Oi de novo");
    expect(u).toContain("abordagem diferente");
    expect(u).toContain("[audio] (conteúdo desconhecido, não interprete)");
  });
  it("sem nome nem conversa não inventa", () => {
    const u = buildSellerMessageUserPrompt({ mode: "first_contact", context: { ...context, customerFirstName: null, originLabel: null, recentMessages: [] } });
    expect(u).toContain("não conhecido (não invente)");
    expect(u).toContain("Origem do lead: não identificada");
    expect(u).toContain("Ainda não há mensagens");
  });
});

describe("generateSellerMessageSuggestion", () => {
  it("gera, aplica trim e registra uso", async () => {
    generateObject.mockResolvedValue({ object: { message: "  Oi Ana, tudo bem?  " }, usage: { inputTokens: 10, outputTokens: 5 } });
    expect(await generateSellerMessageSuggestion(base)).toEqual({ ok: true, message: "Oi Ana, tudo bem?" });
    expect(recordAiUsageEvent).toHaveBeenCalledWith({}, expect.objectContaining({ source: "seller_message_suggestion", organizationId: "org-1", inputTokens: 10 }));
  });
  it("falha do modelo é explícita e não registra uso", async () => {
    generateObject.mockRejectedValue(new Error("timeout"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await generateSellerMessageSuggestion(base)).toEqual({ ok: false });
    expect(recordAiUsageEvent).not.toHaveBeenCalled();
  });
  it("texto vazio é falha, sem texto genérico", async () => {
    generateObject.mockResolvedValue({ object: { message: "   " }, usage: {} });
    expect(await generateSellerMessageSuggestion(base)).toEqual({ ok: false });
  });
  it("falha ao registrar uso não perde a sugestão", async () => {
    generateObject.mockResolvedValue({ object: { message: "Oi" }, usage: {} });
    recordAiUsageEvent.mockRejectedValue(new Error("constraint"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await generateSellerMessageSuggestion(base)).toEqual({ ok: true, message: "Oi" });
  });
});
