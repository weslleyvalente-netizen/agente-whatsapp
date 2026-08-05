import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion,
  patchAgentConfig, restoreAgentConfigFromVersion, getAgentVersions, getAgentVersionById,
} = vi.hoisted(() => ({
  getAgentById: vi.fn(), getOrCreateAgentConfig: vi.fn(), publishAgentConfig: vi.fn(),
  getLatestAgentVersion: vi.fn(), patchAgentConfig: vi.fn(), restoreAgentConfigFromVersion: vi.fn(),
  getAgentVersions: vi.fn(), getAgentVersionById: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion,
  patchAgentConfig, restoreAgentConfigFromVersion, getAgentVersions, getAgentVersionById,
}));

import { publishDraft, getAgentConfigWithStatus, discardDraft, listVersions, getVersionWithDiff, restoreVersion } from "./agent-config.service.js";

const baseAgent = {
  id: "agent-1",
  organization_id: "org-1",
  name: "Helena",
  description: "",
  system_prompt: "texto antigo",
  model: "gpt-4o-mini",
  provider: "openai" as const,
  temperature: 0.7,
  max_tokens: 1024,
  tools_config: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true },
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const baseDraft = {
  id: "config-1",
  agent_id: "agent-1",
  organization_id: "org-1",
  base_version_id: null,
  identity: { nome: "Helena", funcao: "Consultora virtual", missao: "" },
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
  updated_at: "2026-01-01T00:00:00Z",
  updated_by: null,
};

describe("publishDraft", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue(baseAgent);
    getOrCreateAgentConfig.mockResolvedValue(baseDraft);
    publishAgentConfig.mockResolvedValue({ id: "version-1", version: 1 });
  });

  it("compiles the draft into a prompt and passes it, plus model/tools settings, to publishAgentConfig", async () => {
    await publishDraft({} as any, "agent-1", "Primeira publicação", "user-1");

    expect(publishAgentConfig).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agentId: "agent-1",
        changelog: "Primeira publicação",
        publishedBy: "user-1",
        modelSettings: baseDraft.model_settings,
        toolsConfig: baseDraft.tools_config,
      })
    );
    const call = publishAgentConfig.mock.calls[0][1];
    expect(call.compiledSystemPrompt).toContain("Nome: Helena");
    expect(call.compiledSystemPrompt).toContain("Função: Consultora virtual");
    expect(call.configSnapshot).toEqual({
      identity: baseDraft.identity,
      personality: baseDraft.personality,
      rules: baseDraft.rules,
      knowledge: baseDraft.knowledge,
      playbook: baseDraft.playbook,
    });
  });

  it("returns whatever publishAgentConfig returns", async () => {
    const result = await publishDraft({} as any, "agent-1", "changelog", "user-1");
    expect(result).toEqual({ id: "version-1", version: 1 });
  });
});

describe("getAgentConfigWithStatus", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue(baseAgent);
    getOrCreateAgentConfig.mockResolvedValue(baseDraft);
  });

  it("reports every section as changed when the agent has never been published", async () => {
    getLatestAgentVersion.mockResolvedValue(null);

    const result = await getAgentConfigWithStatus({} as any, "agent-1");

    expect(result.hasPendingChanges).toBe(true);
    expect(result.changedSections).toEqual(["identity", "personality", "rules", "knowledge", "playbook", "tools_config"]);
    expect(result.latestVersion).toBeNull();
  });

  it("reports no pending changes when the draft matches the latest published snapshot", async () => {
    getLatestAgentVersion.mockResolvedValue({
      id: "version-1",
      config_snapshot: {
        identity: baseDraft.identity, personality: baseDraft.personality, rules: baseDraft.rules,
        knowledge: baseDraft.knowledge, playbook: baseDraft.playbook,
      },
      tools_config: baseDraft.tools_config,
    });

    const result = await getAgentConfigWithStatus({} as any, "agent-1");

    expect(result.hasPendingChanges).toBe(false);
    expect(result.changedSections).toEqual([]);
  });

  it("reports only the sections that differ from the latest published snapshot", async () => {
    getLatestAgentVersion.mockResolvedValue({
      id: "version-1",
      config_snapshot: {
        identity: { nome: "Nome antigo", funcao: "", missao: "" },
        personality: baseDraft.personality, rules: baseDraft.rules,
        knowledge: baseDraft.knowledge, playbook: baseDraft.playbook,
      },
      tools_config: baseDraft.tools_config,
    });

    const result = await getAgentConfigWithStatus({} as any, "agent-1");

    expect(result.changedSections).toEqual(["identity"]);
  });

  it("reports a tools_config-only change as pending (regression: this used to never surface)", async () => {
    getLatestAgentVersion.mockResolvedValue({
      id: "version-1",
      config_snapshot: {
        identity: baseDraft.identity, personality: baseDraft.personality, rules: baseDraft.rules,
        knowledge: baseDraft.knowledge, playbook: baseDraft.playbook,
      },
      tools_config: { ...baseDraft.tools_config, update_qualification: false },
    });
    getOrCreateAgentConfig.mockResolvedValue({ ...baseDraft, tools_config: { ...baseDraft.tools_config, update_qualification: true } });

    const result = await getAgentConfigWithStatus({} as any, "agent-1");

    expect(result.hasPendingChanges).toBe(true);
    expect(result.changedSections).toEqual(["tools_config"]);
  });
});

describe("discardDraft", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("restores the draft from the latest published version when one exists", async () => {
    const version = { id: "version-1", version: 2 };
    getLatestAgentVersion.mockResolvedValue(version);
    restoreAgentConfigFromVersion.mockResolvedValue(baseDraft);

    const result = await discardDraft({} as any, "agent-1");

    expect(restoreAgentConfigFromVersion).toHaveBeenCalledWith({}, "agent-1", version);
    expect(result).toEqual(baseDraft);
  });

  it("throws when the agent has never been published — nothing to discard to", async () => {
    getLatestAgentVersion.mockResolvedValue(null);
    await expect(discardDraft({} as any, "agent-1")).rejects.toThrow(/never been published/i);
    expect(restoreAgentConfigFromVersion).not.toHaveBeenCalled();
  });
});

const emptySections = {
  identity: { nome: "", funcao: "", missao: "" },
  personality: baseDraft.personality,
  rules: baseDraft.rules,
  knowledge: baseDraft.knowledge,
  playbook: baseDraft.playbook,
};

describe("listVersions", () => {
  it("returns whatever getAgentVersions returns, newest first (that ordering lives in the query itself)", async () => {
    getAgentVersions.mockResolvedValue([{ id: "v2", version: 2 }, { id: "v1", version: 1 }]);
    const result = await listVersions({} as any, "agent-1");
    expect(result).toEqual([{ id: "v2", version: 2 }, { id: "v1", version: 1 }]);
  });
});

describe("getVersionWithDiff", () => {
  it("diffs the requested version against the one immediately before it", async () => {
    const older = { id: "v1", version: 1, config_snapshot: emptySections };
    const newer = { id: "v2", version: 2, config_snapshot: { ...emptySections, identity: { nome: "Helena", funcao: "", missao: "" } } };
    getAgentVersionById.mockResolvedValue(newer);
    getAgentVersions.mockResolvedValue([newer, older]);

    const result = await getVersionWithDiff({} as any, "agent-1", "v2");

    expect(result.version).toEqual(newer);
    expect(result.changedSections).toEqual(["identity"]);
  });

  it("treats every section as changed when diffing the very first version", async () => {
    const onlyVersion = { id: "v1", version: 1, config_snapshot: emptySections };
    getAgentVersionById.mockResolvedValue(onlyVersion);
    getAgentVersions.mockResolvedValue([onlyVersion]);

    const result = await getVersionWithDiff({} as any, "agent-1", "v1");

    expect(result.changedSections).toEqual(["identity", "personality", "rules", "knowledge", "playbook", "tools_config"]);
  });
});

describe("restoreVersion", () => {
  it("restores the given version's snapshot onto the draft", async () => {
    const version = { id: "v1", version: 1, config_snapshot: emptySections };
    getAgentVersionById.mockResolvedValue(version);
    restoreAgentConfigFromVersion.mockResolvedValue(baseDraft);

    const result = await restoreVersion({} as any, "agent-1", "v1");

    expect(restoreAgentConfigFromVersion).toHaveBeenCalledWith({}, "agent-1", version);
    expect(result).toEqual(baseDraft);
  });
});
