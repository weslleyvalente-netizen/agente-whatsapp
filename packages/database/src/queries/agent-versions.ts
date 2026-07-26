import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentVersion } from "@aula-agente/shared";

export async function getAgentVersions(client: SupabaseClient, agentId: string): Promise<AgentVersion[]> {
  const { data, error } = await client
    .from("agent_versions")
    .select("*")
    .eq("agent_id", agentId)
    .order("version", { ascending: false });
  if (error) throw error;
  return data as AgentVersion[];
}

export async function getAgentVersionById(client: SupabaseClient, versionId: string): Promise<AgentVersion> {
  const { data, error } = await client
    .from("agent_versions")
    .select("*")
    .eq("id", versionId)
    .single();
  if (error) throw error;
  return data as AgentVersion;
}

export async function getLatestAgentVersion(
  client: SupabaseClient,
  agentId: string
): Promise<AgentVersion | null> {
  const { data, error } = await client
    .from("agent_versions")
    .select("*")
    .eq("agent_id", agentId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as AgentVersion | null;
}

export interface PublishAgentConfigParams {
  agentId: string;
  changelog: string;
  compiledSystemPrompt: string;
  configSnapshot: AgentVersion["config_snapshot"];
  modelSettings: AgentVersion["model_settings"];
  toolsConfig: AgentVersion["tools_config"];
  publishedBy: string;
}

// Calls the publish_agent_config Postgres function (created in Task 5),
// which updates `agents`, inserts this row, and updates agent_configs'
// base_version_id all inside one implicit plpgsql transaction — see
// 00016_publish_agent_config_function.sql for the atomicity guarantee.
export async function publishAgentConfig(
  client: SupabaseClient,
  params: PublishAgentConfigParams
): Promise<AgentVersion> {
  const { data, error } = await client.rpc("publish_agent_config", {
    p_agent_id: params.agentId,
    p_changelog: params.changelog,
    p_compiled_prompt: params.compiledSystemPrompt,
    p_config_snapshot: params.configSnapshot,
    p_model_settings: params.modelSettings,
    p_tools_config: params.toolsConfig,
    p_published_by: params.publishedBy,
  });
  if (error) throw error;
  return data as AgentVersion;
}
