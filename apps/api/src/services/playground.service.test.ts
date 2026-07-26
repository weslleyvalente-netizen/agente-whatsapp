import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAgentById, getOrCreateAgentConfig, addPlaygroundMessage, getPlaygroundMessages, resolveApiKey, runAgent } = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getOrCreateAgentConfig: vi.fn(),
  addPlaygroundMessage: vi.fn(),
  getPlaygroundMessages: vi.fn(),
  resolveApiKey: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ getAgentById, getOrCreateAgentConfig, addPlaygroundMessage, getPlaygroundMessages }));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey, runAgent }));

import { sendPlaygroundMessage } from "./playground.service.js";

const baseAgent = {
  id: "agent-1", organization_id: "org-1", name: "Helena", description: "",
  system_prompt: "publicado", model: "gpt-4o-mini", provider: "openai" as const,
  temperature: 0.7, max_tokens: 1024,
  tools_config: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true },
  is_active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

const baseDraft = {
  id: "config-1", agent_id: "agent-1", organization_id: "org-1", base_version_id: null,
  identity: { nome: "Helena", funcao: "", missao: "" },
  personality: {
    tom_de_voz: "equilibrado" as const, tom_de_voz_personalizado: "", tamanho_resposta: "curta" as const,
    emojis: { ativo: true, maximo: 1, instrucao: "" }, perguntas_por_vez: { maximo: 1 },
    postura_comercial: { tipo: "", instrucao: "" }, girias_proibidas: [], proatividade: "",
  },
  rules: {
    transferencia_para_humano: [], promessas_proibidas: [], regras_por_tipo: [],
    preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" }, objecoes: [],
  },
  knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
  playbook: { script_atendimento: "" },
  tools_config: baseAgent.tools_config,
  model_settings: { provider: "openai" as const, model: "gpt-4o-mini", temperature: 0.7, max_tokens: 1024 },
  updated_at: "2026-01-01T00:00:00Z", updated_by: null,
};

describe("sendPlaygroundMessage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue(baseAgent);
    getOrCreateAgentConfig.mockResolvedValue(baseDraft);
    getPlaygroundMessages.mockResolvedValue([]);
    resolveApiKey.mockResolvedValue("test-key");
    runAgent.mockResolvedValue({
      text: "Olá! Como posso ajudar?", model: "gpt-4o-mini", inputTokens: 10, outputTokens: 5,
      latencyMs: 100, toolCalls: [], toolCallTrace: [],
    });
    addPlaygroundMessage.mockImplementation((_db: unknown, params: any) =>
      Promise.resolve({ id: "msg-1", session_id: params.sessionId, organization_id: params.organizationId, role: params.role, content: params.content, tool_calls: params.toolCalls ?? [], created_at: "2026-01-01T00:00:00Z" })
    );
  });

  it("always calls runAgent with sandbox: true, never false or omitted", async () => {
    await sendPlaygroundMessage({} as any, {
      agentId: "agent-1", organizationId: "org-1", sessionId: "session-1", content: "Oi",
    });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ sandbox: true }));
  });

  it("compiles the draft (not the published system_prompt) as the system prompt for the run", async () => {
    await sendPlaygroundMessage({} as any, {
      agentId: "agent-1", organizationId: "org-1", sessionId: "session-1", content: "Oi",
    });

    const callArg = runAgent.mock.calls[0][0];
    expect(callArg.agent.system_prompt).not.toBe("publicado");
  });

  it("saves both the user message and the assistant reply, with the tool trace on the assistant message", async () => {
    runAgent.mockResolvedValue({
      text: "Resposta", model: "gpt-4o-mini", inputTokens: 1, outputTokens: 1, latencyMs: 1,
      toolCalls: ["searchKnowledge"],
      toolCallTrace: [{ tool_name: "searchKnowledge", input: {}, output: "ok", mode: "real", executed_at: "2026-01-01T00:00:00Z" }],
    });

    const result = await sendPlaygroundMessage({} as any, {
      agentId: "agent-1", organizationId: "org-1", sessionId: "session-1", content: "Oi",
    });

    expect(addPlaygroundMessage).toHaveBeenCalledWith({}, expect.objectContaining({ role: "user", content: "Oi" }));
    expect(addPlaygroundMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        role: "assistant",
        content: "Resposta",
        toolCalls: [expect.objectContaining({ tool_name: "searchKnowledge", mode: "real" })],
      })
    );
    expect(result.content).toBe("Resposta");
  });
});
