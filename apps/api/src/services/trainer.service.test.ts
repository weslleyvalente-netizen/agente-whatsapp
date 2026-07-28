import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getAgentById,
  getAgentConfigIfExists,
  buildDefaultAgentConfigDraft,
  getOrCreateAgentConfig,
  patchAgentConfig,
  getTrainerMessages,
  getRecentMessagesForOrganization,
  resolveApiKey,
  createModel,
} = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getAgentConfigIfExists: vi.fn(),
  buildDefaultAgentConfigDraft: vi.fn(),
  // Mocked only so the "never writes" test can assert they were never
  // reached — trainer.service.ts must not import either of them.
  getOrCreateAgentConfig: vi.fn(),
  patchAgentConfig: vi.fn(),
  getTrainerMessages: vi.fn(),
  getRecentMessagesForOrganization: vi.fn(),
  resolveApiKey: vi.fn(),
  createModel: vi.fn(),
}));
const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock("@aula-agente/database", () => ({
  getAgentById,
  getAgentConfigIfExists,
  buildDefaultAgentConfigDraft,
  getOrCreateAgentConfig,
  patchAgentConfig,
  getTrainerMessages,
  getRecentMessagesForOrganization,
}));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey, createModel }));
vi.mock("ai", () => ({ generateObject }));

import { proposeConfigChange, buildConversationPatternContext, redactPii, diffSectionValues } from "./trainer.service.js";

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
    preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" },
    objecoes: [{ id: "a", nome: "Preço alto", como_identificar: "", orientacao: "", pergunta_diagnostico: "", quando_escalar: "", ativo: true }],
  },
  knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
  playbook: { script_atendimento: "" },
  tools_config: baseAgent.tools_config,
  model_settings: { provider: "openai" as const, model: "gpt-4o-mini", temperature: 0.7, max_tokens: 1024 },
  updated_at: "2026-01-01T00:00:00Z", updated_by: null,
};

describe("proposeConfigChange", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue(baseAgent);
    getAgentConfigIfExists.mockResolvedValue(baseDraft);
    buildDefaultAgentConfigDraft.mockReturnValue({ ...baseDraft, id: "", identity: { nome: "", funcao: "", missao: "" } });
    getTrainerMessages.mockResolvedValue([]);
    getRecentMessagesForOrganization.mockResolvedValue([]);
    resolveApiKey.mockResolvedValue("test-key");
    createModel.mockReturnValue("mock-model" as any);
  });

  it("no-conflict scenario: issues a stage-1 and a stage-2 call, and returns a proposal with a full-section patch and a computed diff", async () => {
    generateObject
      .mockResolvedValueOnce({
        object: {
          content: "Vou aumentar o limite de emojis.",
          candidates: [{ section: "personalidade", item: "emojis", summary: "Aumentar emojis de 1 para 3", rationale: "Pedido do usuário", conflicts: [] }],
        },
      })
      .mockResolvedValueOnce({ object: { ...baseDraft.personality, emojis: { ativo: true, maximo: 3, instrucao: "" } } });

    const result = await proposeConfigChange({} as any, "agent-1", "session-1", "deixa até 3 emojis");

    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].status).toBe("proposed");
    expect(result.proposals[0].conflicts).toEqual([]);
    expect(result.proposals[0].patch).toEqual({ personality: { ...baseDraft.personality, emojis: { ativo: true, maximo: 3, instrucao: "" } } });
    expect(result.proposals[0].diff).toEqual([{ field_path: "emojis.maximo", before: 1, after: 3 }]);
  });

  it("conflict scenario (perguntas_por_vez=1 + pedido de 3 juntas): stops after stage 1, patch is null, no stage-2 call", async () => {
    generateObject.mockResolvedValueOnce({
      object: {
        content: "Isso contradiz uma regra existente — quer mudar o limite ou manter uma por vez?",
        candidates: [
          {
            section: "personalidade",
            item: "perguntas_por_vez",
            summary: "Perguntar nome, cidade e modelo de uma vez",
            rationale: "Pedido do usuário",
            conflicts: [{ description: "Existe uma regra de 1 pergunta por vez", resolution_options: ["Aumentar o limite para 3", "Manter 1 e reformular o pedido"] }],
          },
        ],
      },
    });

    const result = await proposeConfigChange({} as any, "agent-1", "session-1", "pergunta nome, cidade e modelo de uma vez");

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].patch).toBeNull();
    expect(result.proposals[0].conflicts).toHaveLength(1);
  });

  it("duplication scenario: the stage-1 prompt includes the current objeções list so the model can compare before proposing a new one", async () => {
    generateObject.mockResolvedValueOnce({ object: { content: "Já existe uma objeção parecida.", candidates: [] } });

    await proposeConfigChange({} as any, "agent-1", "session-1", "cliente acha caro");

    const stageOnePrompt = generateObject.mock.calls[0][0].prompt as string;
    expect(stageOnePrompt).toContain("Preço alto");
  });

  it("reads the draft through the read-only query — never getOrCreateAgentConfig, which INSERTs", async () => {
    generateObject.mockResolvedValue({ object: { content: "ok", candidates: [] } });

    await proposeConfigChange({} as any, "agent-1", "session-1", "ajusta o tom");

    expect(getAgentConfigIfExists).toHaveBeenCalledWith({}, "agent-1");
    expect(getOrCreateAgentConfig).not.toHaveBeenCalled();
    expect(patchAgentConfig).not.toHaveBeenCalled();
  });

  it("falls back to an in-memory default draft (no row insert) when the agent has no draft yet", async () => {
    getAgentConfigIfExists.mockResolvedValue(null);
    generateObject.mockResolvedValue({ object: { content: "ok", candidates: [] } });

    const result = await proposeConfigChange({} as any, "agent-1", "session-1", "ajusta o tom");

    expect(buildDefaultAgentConfigDraft).toHaveBeenCalledWith(baseAgent);
    // Nothing insert-capable was reached: the only DB functions called were
    // the three read queries.
    expect(getOrCreateAgentConfig).not.toHaveBeenCalled();
    expect(patchAgentConfig).not.toHaveBeenCalled();
    // The in-memory default still produced a usable prompt with the empty
    // identity section, so generation works on a brand-new agent.
    const stageOnePrompt = generateObject.mock.calls[0][0].prompt as string;
    expect(stageOnePrompt).toContain('"identity"');
    expect(result.content).toBe("ok");
  });

  it("fetches conversation-pattern context only when analyzeConversations is explicitly true", async () => {
    generateObject.mockResolvedValue({ object: { content: "ok", candidates: [] } });

    // Omitted -> off, even for a message that mentions "conversas": the old
    // /conversa/i sniffing must not silently scan real customer messages.
    await proposeConfigChange({} as any, "agent-1", "session-1", "melhora o tom da conversa");
    expect(getRecentMessagesForOrganization).not.toHaveBeenCalled();

    // Explicit false -> off.
    await proposeConfigChange({} as any, "agent-1", "session-1", "veja as últimas conversas e sugira melhorias", false);
    expect(getRecentMessagesForOrganization).not.toHaveBeenCalled();

    // Explicit true -> on, even for a message that never says "conversa":
    // a reworded quick-action prompt still analyses real data.
    await proposeConfigChange({} as any, "agent-1", "session-1", "olha o histórico real e sugira melhorias", true);
    expect(getRecentMessagesForOrganization).toHaveBeenCalledTimes(1);
  });

  it("injects the conversation context into the stage-1 prompt when analyzeConversations is true", async () => {
    generateObject.mockResolvedValue({ object: { content: "ok", candidates: [] } });
    getRecentMessagesForOrganization.mockResolvedValue([
      { conversation_id: "11111111-aaaa", role: "user", content: "vocês entregam em Curitiba?", created_at: "2026-01-01T00:00:00Z" },
    ]);

    await proposeConfigChange({} as any, "agent-1", "session-1", "sugira melhorias", true);

    const stageOnePrompt = generateObject.mock.calls[0][0].prompt as string;
    expect(stageOnePrompt).toContain("Padrões observados em conversas reais recentes");
    expect(stageOnePrompt).toContain("vocês entregam em Curitiba?");
  });

  it("a stage-2 failure for one candidate doesn't take down content or the other candidates' proposals", async () => {
    generateObject
      .mockResolvedValueOnce({
        object: {
          content: "Vou ajustar duas coisas.",
          candidates: [
            { section: "personalidade", item: "emojis", summary: "Aumentar emojis de 1 para 3", rationale: "Pedido do usuário", conflicts: [] },
            { section: "conhecimento", item: "links", summary: "Adicionar link inválido", rationale: "Pedido do usuário", conflicts: [] },
          ],
        },
      })
      .mockResolvedValueOnce({ object: { ...baseDraft.personality, emojis: { ativo: true, maximo: 3, instrucao: "" } } })
      .mockRejectedValueOnce(new Error("schema validation failed"));

    const result = await proposeConfigChange({} as any, "agent-1", "session-1", "ajusta emojis e adiciona um link ruim");

    expect(result.content).toBe("Vou ajustar duas coisas.");
    expect(result.proposals).toHaveLength(2);

    const [okProposal, failedProposal] = result.proposals;
    expect(okProposal.section).toBe("personalidade");
    expect(okProposal.status).toBe("proposed");
    expect(okProposal.patch).toEqual({ personality: { ...baseDraft.personality, emojis: { ativo: true, maximo: 3, instrucao: "" } } });

    expect(failedProposal.section).toBe("conhecimento");
    expect(failedProposal.status).toBe("proposed");
    expect(failedProposal.patch).toBeNull();
    expect(failedProposal.diff).toEqual([]);
    expect(failedProposal.conflicts).toHaveLength(1);
  });

  it("issues stage-2 calls for multiple conflict-free candidates via Promise.all, not a serial await loop", async () => {
    let concurrentInFlight = 0;
    let maxConcurrentInFlight = 0;

    generateObject.mockImplementationOnce(async () => ({
      object: {
        content: "Vou ajustar duas coisas.",
        candidates: [
          { section: "personalidade", item: "emojis", summary: "Aumentar emojis", rationale: "r", conflicts: [] },
          { section: "playbooks", item: null, summary: "Atualizar script", rationale: "r", conflicts: [] },
        ],
      },
    }));

    const trackConcurrency = async (result: unknown) => {
      concurrentInFlight += 1;
      maxConcurrentInFlight = Math.max(maxConcurrentInFlight, concurrentInFlight);
      // Yield without resolving immediately, so both stage-2 calls have a
      // chance to start before either finishes — proving they were fanned
      // out rather than awaited one at a time.
      await Promise.resolve();
      concurrentInFlight -= 1;
      return { object: result };
    };

    generateObject
      .mockImplementationOnce(() => trackConcurrency({ ...baseDraft.personality, emojis: { ativo: true, maximo: 3, instrucao: "" } }))
      .mockImplementationOnce(() => trackConcurrency({ ...baseDraft.playbook, script_atendimento: "novo script" }));

    const result = await proposeConfigChange({} as any, "agent-1", "session-1", "ajusta emojis e o script");

    expect(generateObject).toHaveBeenCalledTimes(3);
    expect(maxConcurrentInFlight).toBe(2);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0].section).toBe("personalidade");
    expect(result.proposals[1].section).toBe("playbooks");
  });
});

describe("redactPii", () => {
  it("redacts a Brazilian phone number and an email out of free text", () => {
    const text = "meu telefone é (11) 98888-7777 e email joao@example.com";
    const redacted = redactPii(text);
    expect(redacted).not.toContain("98888-7777");
    expect(redacted).not.toContain("joao@example.com");
  });
});

describe("buildConversationPatternContext", () => {
  it("never includes wa_contacts data — only redacted message content", async () => {
    getRecentMessagesForOrganization.mockResolvedValue([
      { conversation_id: "11111111-aaaa", role: "user", content: "meu whatsapp é (21) 99999-1234", created_at: "2026-01-01T00:00:00Z" },
    ]);

    const context = await buildConversationPatternContext({} as any, "org-1");
    expect(context).not.toContain("99999-1234");
  });

  it("truncates to the most recent messages, dropping the oldest whole lines, when the joined context would overflow the budget", async () => {
    // 500 messages of ~60 chars each joins to ~30000 chars, well past any
    // reasonable single-prompt budget — this must get truncated rather
    // than passed through whole.
    const messages = Array.from({ length: 500 }, (_, i) => ({
      conversation_id: `conversation-${i}`,
      role: "user",
      content: `mensagem numero ${i} sobre um assunto qualquer do cliente`,
      created_at: "2026-01-01T00:00:00Z",
    }));
    getRecentMessagesForOrganization.mockResolvedValue(messages);

    const context = await buildConversationPatternContext({} as any, "org-1");

    expect(context.length).toBeLessThanOrEqual(8000);
    // The most recent message (highest index, last in the ascending-order
    // result) must survive; the oldest must have been dropped.
    expect(context).toContain("mensagem numero 499");
    expect(context).not.toContain("mensagem numero 0 ");
    // No line should be cut mid-line: every kept line ends with the full
    // "sobre um assunto qualquer do cliente" suffix.
    for (const line of context.split("\n")) {
      expect(line).toMatch(/sobre um assunto qualquer do cliente$/);
    }
  });
});

describe("diffSectionValues", () => {
  it("treats arrays as atomic and only reports leaf primitives that changed", () => {
    const before = { a: 1, nested: { b: "x" }, list: [1, 2] };
    const after = { a: 1, nested: { b: "y" }, list: [1, 2, 3] };
    expect(diffSectionValues(before, after)).toEqual([
      { field_path: "nested.b", before: "x", after: "y" },
      { field_path: "list", before: [1, 2], after: [1, 2, 3] },
    ]);
  });
});
