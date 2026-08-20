import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAgentById, resolveApiKey, createModel, recordAiUsageEvent } = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  resolveApiKey: vi.fn(),
  createModel: vi.fn(),
  recordAiUsageEvent: vi.fn(),
}));
const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock("@aula-agente/database", () => ({ getAgentById, recordAiUsageEvent }));
vi.mock("@aula-agente/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aula-agente/agent-runtime")>();
  return { ...actual, resolveApiKey, createModel };
});
vi.mock("ai", () => ({ generateObject }));

import {
  suggestConfigFromSystemPrompt,
  identityGenSchema,
  personalityGenSchema,
  rulesGenSchema,
  knowledgeGenSchema,
  playbookGenSchema,
} from "./import-suggestion.service.js";

const baseAgent = {
  id: "agent-1", organization_id: "org-1", name: "Helena", description: "",
  system_prompt: "Você é Helena, consultora da Moto & Trilha. Faça no máximo uma pergunta por vez.",
  model: "gpt-4o-mini", provider: "openai" as const, temperature: 0.7, max_tokens: 1024,
  tools_config: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true },
  is_active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

const suggestedObject = {
  identity: { nome: "Helena", funcao: "Consultora da Moto & Trilha", missao: "" },
  personality: {
    tom_de_voz: "equilibrado", tom_de_voz_personalizado: "", tamanho_resposta: "curta",
    emojis: { ativo: true, maximo: 1, instrucao: "" }, perguntas_por_vez: { maximo: 1 },
    postura_comercial: { tipo: "", instrucao: "" }, girias_proibidas: [], proatividade: "",
  },
  rules: {
    transferencia_para_humano: [], promessas_proibidas: [], regras_por_tipo: [],
    preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" }, objecoes: [],
  },
  knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
  playbook: { script_atendimento: "" },
};

describe("suggestConfigFromSystemPrompt", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue(baseAgent);
    resolveApiKey.mockResolvedValue("test-key");
    createModel.mockReturnValue("mock-model" as any);
    recordAiUsageEvent.mockResolvedValue(undefined);
    // One generateObject call per section (identity, personality, rules,
    // knowledge, playbook — issued in that order by Promise.all), since
    // Anthropic rejects the combined 5-section schema in a single call
    // ("too many optional parameters", then "compiled grammar too large"
    // even with 0 optional fields).
    const usage = { inputTokens: 1000, outputTokens: 100, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 } };
    generateObject
      .mockResolvedValueOnce({ object: suggestedObject.identity, usage })
      .mockResolvedValueOnce({ object: suggestedObject.personality, usage })
      .mockResolvedValueOnce({ object: suggestedObject.rules, usage })
      .mockResolvedValueOnce({ object: suggestedObject.knowledge, usage })
      .mockResolvedValueOnce({ object: suggestedObject.playbook, usage });
  });

  it("never writes anything — it only returns the model's suggestion, assembled from 5 section calls", async () => {
    const result = await suggestConfigFromSystemPrompt({} as any, "agent-1");
    expect(result).toEqual(suggestedObject);
    expect(generateObject).toHaveBeenCalledTimes(5);
  });

  it("includes the agent's current system_prompt text in every section call's prompt", async () => {
    await suggestConfigFromSystemPrompt({} as any, "agent-1");
    expect(generateObject.mock.calls.length).toBe(5);
    for (const call of generateObject.mock.calls) {
      expect((call[0] as { prompt: string }).prompt).toContain(baseAgent.system_prompt);
    }
  });

  it("resolves the API key using the agent's own provider, not a hardcoded one", async () => {
    await suggestConfigFromSystemPrompt({} as any, "agent-1");
    expect(resolveApiKey).toHaveBeenCalledWith("org-1", "openai");
  });

  it("issues each of the 5 section calls with its own matching schema, in order", async () => {
    await suggestConfigFromSystemPrompt({} as any, "agent-1");
    const expectedSchemas = [identityGenSchema, personalityGenSchema, rulesGenSchema, knowledgeGenSchema, playbookGenSchema];
    generateObject.mock.calls.forEach((call, i) => {
      expect((call[0] as { schema: unknown }).schema).toBe(expectedSchemas[i]);
    });
  });

  it("records one ai_usage_event summing all 5 section calls' token usage", async () => {
    await suggestConfigFromSystemPrompt({} as any, "agent-1");

    expect(recordAiUsageEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        organizationId: "org-1",
        agentId: "agent-1",
        source: "import_suggestion",
        model: "gpt-4o-mini",
        inputTokens: 5000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    );
  });
});
