import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAgentById, resolveApiKey, createModel } = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  resolveApiKey: vi.fn(),
  createModel: vi.fn(),
}));
const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock("@aula-agente/database", () => ({ getAgentById }));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey, createModel }));
vi.mock("ai", () => ({ generateObject }));

import { suggestConfigFromSystemPrompt } from "./import-suggestion.service.js";

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
    generateObject.mockResolvedValue({ object: suggestedObject });
  });

  it("never writes anything — it only returns the model's suggestion", async () => {
    const result = await suggestConfigFromSystemPrompt({} as any, "agent-1");
    expect(result).toEqual(suggestedObject);
  });

  it("includes the agent's current system_prompt text in the prompt sent to the model", async () => {
    await suggestConfigFromSystemPrompt({} as any, "agent-1");
    const call = generateObject.mock.calls[0][0];
    expect(call.prompt).toContain(baseAgent.system_prompt);
  });

  it("resolves the API key using the agent's own provider, not a hardcoded one", async () => {
    await suggestConfigFromSystemPrompt({} as any, "agent-1");
    expect(resolveApiKey).toHaveBeenCalledWith("org-1", "openai");
  });
});
