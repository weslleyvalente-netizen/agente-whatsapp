import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion, restoreAgentConfigFromVersion, getAgentVersions, getAgentVersionById } from "@aula-agente/database";
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

  const baseSnapshot = latestVersion
    ? { ...latestVersion.config_snapshot, tools_config: latestVersion.tools_config }
    : null;
  const changedSections = computeChangedSections(
    {
      identity: draft.identity, personality: draft.personality, rules: draft.rules,
      knowledge: draft.knowledge, playbook: draft.playbook, tools_config: draft.tools_config,
    },
    baseSnapshot
  );

  return { draft, latestVersion, changedSections, hasPendingChanges: changedSections.length > 0 };
}

export async function discardDraft(db: SupabaseClient, agentId: string): Promise<AgentConfigDraft> {
  const latestVersion = await getLatestAgentVersion(db, agentId);
  if (!latestVersion) {
    throw new Error("This agent has never been published — there is nothing to discard to.");
  }
  return restoreAgentConfigFromVersion(db, agentId, latestVersion);
}

export async function listVersions(db: SupabaseClient, agentId: string): Promise<AgentVersion[]> {
  return getAgentVersions(db, agentId);
}

export interface VersionWithDiff {
  version: AgentVersion;
  changedSections: string[];
}

export async function getVersionWithDiff(db: SupabaseClient, agentId: string, versionId: string): Promise<VersionWithDiff> {
  const version = await getAgentVersionById(db, versionId);
  const allVersions = await getAgentVersions(db, agentId);
  const previous = allVersions.find((v) => v.version === version.version - 1) ?? null;

  const changedSections = computeChangedSections(
    { ...version.config_snapshot, tools_config: version.tools_config },
    previous ? { ...previous.config_snapshot, tools_config: previous.tools_config } : null
  );
  return { version, changedSections };
}

export async function restoreVersion(db: SupabaseClient, agentId: string, versionId: string): Promise<AgentConfigDraft> {
  const version = await getAgentVersionById(db, versionId);
  return restoreAgentConfigFromVersion(db, agentId, version);
}
