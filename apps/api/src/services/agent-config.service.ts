import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion } from "@aula-agente/database";
import { compileSystemPrompt, computeChangedSections } from "@aula-agente/shared";
import type { AgentConfigDraft, AgentVersion } from "@aula-agente/shared";

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

export interface AgentConfigStatus {
  draft: AgentConfigDraft;
  latestVersion: AgentVersion | null;
  changedSections: string[];
  hasPendingChanges: boolean;
}

export async function getAgentConfigWithStatus(db: SupabaseClient, agentId: string): Promise<AgentConfigStatus> {
  const agent = await getAgentById(db, agentId);
  const draft = await getOrCreateAgentConfig(db, agent);
  const latestVersion = await getLatestAgentVersion(db, agentId);

  const baseSnapshot = latestVersion?.config_snapshot ?? null;
  const changedSections = computeChangedSections(
    { identity: draft.identity, personality: draft.personality, rules: draft.rules, knowledge: draft.knowledge, playbook: draft.playbook },
    baseSnapshot
  );

  return { draft, latestVersion, changedSections, hasPendingChanges: changedSections.length > 0 };
}
