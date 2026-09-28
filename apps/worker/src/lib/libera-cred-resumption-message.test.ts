import { describe, it, expect, vi, afterEach } from "vitest";

const { embed, generateObject, createModel, resolveApiKey, searchKnowledgeChunks, getKnowledgeChunksWithDocumentMeta } =
  vi.hoisted(() => ({
    embed: vi.fn(),
    generateObject: vi.fn(),
    createModel: vi.fn(),
    resolveApiKey: vi.fn(),
    searchKnowledgeChunks: vi.fn(),
    getKnowledgeChunksWithDocumentMeta: vi.fn(),
  }));

vi.mock("ai", () => ({ embed, generateObject }));
vi.mock("@aula-agente/agent-runtime", () => ({ createModel, resolveApiKey }));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  searchKnowledgeChunks,
  getKnowledgeChunksWithDocumentMeta,
}));

import { buildOutdatedWarning, generateLiberaCredResumptionSuggestion } from "./libera-cred-resumption-message.js";

const baseParams = {
  organizationId: "org-1",
  agentId: "agent-1",
  provider: "anthropic" as const,
  model: "claude-sonnet-5",
  apiKey: "chat-key",
  tableMaxAgeDays: 30,
  todayISODate: "2026-09-28",
};

const freshChunk = {
  id: "chunk-1",
  content: "Plano 60 meses, taxa 1,2% a.m. Tabela vigente a partir de 2026-09-01.",
  document_id: "doc-1",
  document_title: "Tabela LiberaCred Setembro",
  document_updated_at: "2026-09-01T00:00:00Z",
};

afterEach(() => {
  vi.resetAllMocks();
});

describe("generateLiberaCredResumptionSuggestion", () => {
  it("returns a ready message with the table date when the knowledge base has a fresh, explicit table", async () => {
    resolveApiKey.mockResolvedValue("openai-key");
    embed.mockResolvedValue({ embedding: [0.1, 0.2] });
    searchKnowledgeChunks.mockResolvedValue([{ id: "chunk-1", content: freshChunk.content, similarity: 0.9 }]);
    getKnowledgeChunksWithDocumentMeta.mockResolvedValue([freshChunk]);
    createModel.mockReturnValue("mock-model");
    generateObject.mockResolvedValue({
      object: {
        message: "Oi! Vi que seu plano de 60 meses a 1,2% a.m. ainda está de pé, quer que eu explique melhor?",
        table_date_found_in_text: "2026-09-01",
        table_found: true,
      },
    });

    const result = await generateLiberaCredResumptionSuggestion(baseParams);

    expect(result.outdated).toBe(false);
    expect(result.description).toContain("60 meses");
    expect(result.description).toContain("2026-09-01");
  });

  it("falls back to the outdated warning when no knowledge base hits are found", async () => {
    resolveApiKey.mockResolvedValue("openai-key");
    embed.mockResolvedValue({ embedding: [0.1] });
    searchKnowledgeChunks.mockResolvedValue([]);
    getKnowledgeChunksWithDocumentMeta.mockResolvedValue([]);

    const result = await generateLiberaCredResumptionSuggestion(baseParams);

    expect(result).toEqual({ description: buildOutdatedWarning(), outdated: true });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("falls back to the outdated warning when the model says the table wasn't found", async () => {
    resolveApiKey.mockResolvedValue("openai-key");
    embed.mockResolvedValue({ embedding: [0.1] });
    searchKnowledgeChunks.mockResolvedValue([{ id: "chunk-1", content: "irrelevant", similarity: 0.3 }]);
    getKnowledgeChunksWithDocumentMeta.mockResolvedValue([{ ...freshChunk, content: "irrelevant" }]);
    createModel.mockReturnValue("mock-model");
    generateObject.mockResolvedValue({
      object: { message: null, table_date_found_in_text: null, table_found: false },
    });

    const result = await generateLiberaCredResumptionSuggestion(baseParams);

    expect(result).toEqual({ description: buildOutdatedWarning(), outdated: true });
  });

  it("falls back to the outdated warning when the table's own date is older than the age cap", async () => {
    resolveApiKey.mockResolvedValue("openai-key");
    embed.mockResolvedValue({ embedding: [0.1] });
    searchKnowledgeChunks.mockResolvedValue([{ id: "chunk-1", content: freshChunk.content, similarity: 0.9 }]);
    getKnowledgeChunksWithDocumentMeta.mockResolvedValue([{ ...freshChunk, document_updated_at: "2026-01-01T00:00:00Z" }]);
    createModel.mockReturnValue("mock-model");
    generateObject.mockResolvedValue({
      object: { message: "Mensagem qualquer.", table_date_found_in_text: "2026-01-15", table_found: true },
    });

    const result = await generateLiberaCredResumptionSuggestion(baseParams);

    expect(result).toEqual({ description: buildOutdatedWarning(), outdated: true });
  });

  it("falls back to the outdated warning when generation itself throws", async () => {
    resolveApiKey.mockResolvedValue("openai-key");
    embed.mockResolvedValue({ embedding: [0.1] });
    searchKnowledgeChunks.mockResolvedValue([{ id: "chunk-1", content: freshChunk.content, similarity: 0.9 }]);
    getKnowledgeChunksWithDocumentMeta.mockResolvedValue([freshChunk]);
    createModel.mockReturnValue("mock-model");
    generateObject.mockRejectedValue(new Error("model timeout"));

    const result = await generateLiberaCredResumptionSuggestion(baseParams);

    expect(result).toEqual({ description: buildOutdatedWarning(), outdated: true });
  });

  it("falls back to the outdated warning when the knowledge search itself throws (e.g. no OpenAI key configured)", async () => {
    resolveApiKey.mockRejectedValue(new Error("no key configured"));

    const result = await generateLiberaCredResumptionSuggestion(baseParams);

    expect(result).toEqual({ description: buildOutdatedWarning(), outdated: true });
    expect(generateObject).not.toHaveBeenCalled();
  });
});
