import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, AgentConfigDraft, AgentVersion } from "@aula-agente/shared";

function defaultConfigSections() {
  return {
    identity: { nome: "", funcao: "", missao: "" },
    personality: {
      tom_de_voz: "equilibrado" as const,
      tom_de_voz_personalizado: "",
      tamanho_resposta: "curta" as const,
      emojis: { ativo: true, maximo: 1, instrucao: "" },
      perguntas_por_vez: { maximo: 1 },
      postura_comercial: { tipo: "", instrucao: "" },
      girias_proibidas: [] as string[],
      proatividade: "",
    },
    rules: {
      transferencia_para_humano: [],
      promessas_proibidas: [],
      regras_por_tipo: [],
      preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" },
      objecoes: [],
    },
    knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
    playbook: { script_atendimento: "" },
  };
}

// The column values a brand-new agent_configs row starts life with.
// Shared by the INSERT in getOrCreateAgentConfig and by the never-persisted
// in-memory draft built by buildDefaultAgentConfigDraft, so the two can't
// drift apart.
//
// identity/personality/rules/knowledge/playbook start empty (filled in later
// via the import-suggestion flow or manual editing), but
// model_settings/tools_config are copied from the agent's current published
// values since those are already structured data with no need for a
// suggestion step.
function newAgentConfigValues(agent: Agent) {
  return {
    agent_id: agent.id,
    organization_id: agent.organization_id,
    base_version_id: null,
    ...defaultConfigSections(),
    tools_config: agent.tools_config,
    model_settings: {
      provider: agent.provider,
      model: agent.model,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
    },
  };
}

// Purely in-memory default draft for read-only callers that must not seed a
// row as a side effect of reading (the Trainer's proposal-generation path).
// `id` is intentionally the empty string: there is no row, and nothing may
// use this value as a primary key. `updated_at` mirrors the agent's own
// timestamp since the (non-existent) draft has never been edited.
export function buildDefaultAgentConfigDraft(agent: Agent): AgentConfigDraft {
  return {
    id: "",
    ...newAgentConfigValues(agent),
    updated_at: agent.updated_at,
    updated_by: null,
  };
}

// Strictly read-only: plain SELECT, returns null when the agent has no draft
// row yet. Use this (never getOrCreateAgentConfig) from any code path that
// must not write to the database — see trainer-writes.test.ts.
export async function getAgentConfigIfExists(
  client: SupabaseClient,
  agentId: string
): Promise<AgentConfigDraft | null> {
  const { data, error } = await client
    .from("agent_configs")
    .select("*")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error) throw error;
  return (data as AgentConfigDraft | null) ?? null;
}

export async function getOrCreateAgentConfig(
  client: SupabaseClient,
  agent: Agent
): Promise<AgentConfigDraft> {
  const existing = await getAgentConfigIfExists(client, agent.id);
  if (existing) return existing;

  // Lazy-seeded on first access.
  const { data: created, error: insertError } = await client
    .from("agent_configs")
    .insert(newAgentConfigValues(agent))
    .select()
    .single();
  if (insertError) throw insertError;
  return created as AgentConfigDraft;
}

type ConfigPatch = Partial<
  Pick<AgentConfigDraft, "identity" | "personality" | "rules" | "knowledge" | "playbook" | "tools_config" | "model_settings">
>;

export async function patchAgentConfig(
  client: SupabaseClient,
  agentId: string,
  patch: ConfigPatch,
  updatedBy: string
): Promise<AgentConfigDraft> {
  const { data, error } = await client
    .from("agent_configs")
    .update({ ...patch, updated_by: updatedBy })
    .eq("agent_id", agentId)
    .select()
    .single();
  if (error) throw error;
  return data as AgentConfigDraft;
}

export async function restoreAgentConfigFromVersion(
  client: SupabaseClient,
  agentId: string,
  version: AgentVersion
): Promise<AgentConfigDraft> {
  const { data, error } = await client
    .from("agent_configs")
    .update({
      base_version_id: version.id,
      identity: version.config_snapshot.identity,
      personality: version.config_snapshot.personality,
      rules: version.config_snapshot.rules,
      knowledge: version.config_snapshot.knowledge,
      playbook: version.config_snapshot.playbook,
      tools_config: version.tools_config,
      model_settings: version.model_settings,
    })
    .eq("agent_id", agentId)
    .select()
    .single();
  if (error) throw error;
  return data as AgentConfigDraft;
}
