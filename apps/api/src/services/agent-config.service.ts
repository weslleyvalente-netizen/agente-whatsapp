import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById, getOrCreateAgentConfig, publishAgentConfig } from "@aula-agente/database";
import { compileSystemPrompt } from "@aula-agente/shared";
import type { AgentVersion } from "@aula-agente/shared";

export async function publishDraft(
  db: SupabaseClient,
  agentId: string,
  changelog: string,
  publishedBy: string
): Promise<AgentVersion> {
  const agent = await getAgentById(db, agentId);
  const draft = await getOrCreateAgentConfig(db, agent);

  const configSnapshot = {
    identity: draft.identity,
    personality: draft.personality,
    rules: draft.rules,
    knowledge: draft.knowledge,
    playbook: draft.playbook,
  };

  return publishAgentConfig(db, {
    agentId,
    changelog,
    compiledSystemPrompt: compileSystemPrompt(configSnapshot),
    configSnapshot,
    modelSettings: draft.model_settings,
    toolsConfig: draft.tools_config,
    publishedBy,
  });
}
