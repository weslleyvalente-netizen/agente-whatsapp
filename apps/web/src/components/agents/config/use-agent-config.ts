"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { computeChangedSections } from "@aula-agente/shared";
import type { AgentConfigDraft, AgentVersion } from "@aula-agente/shared";

export interface AgentConfigStatus {
  draft: AgentConfigDraft;
  latestVersion: AgentVersion | null;
  changedSections: string[];
  hasPendingChanges: boolean;
}

type ConfigPatch = Partial<
  Pick<AgentConfigDraft, "identity" | "personality" | "rules" | "knowledge" | "playbook" | "tools_config" | "model_settings">
>;

export function useAgentConfig(agentId: string) {
  const [status, setStatus] = useState<AgentConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const data = (await apiFetch(`/agents/${agentId}/config`)) as AgentConfigStatus;
    setStatus(data);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Saving is a PATCH followed by a refetch — two sequential network round
  // trips. If we only updated `status` once that chain resolves, a user who
  // switches to another section and back inside that window remounts it with
  // the pre-save draft still sitting in this hook's state, making the edit
  // look reverted even though it landed. Updating `status` synchronously
  // here (before the network call) closes that window; the refetch below
  // still runs afterward to reconcile with the server's authoritative value.
  const patch = useCallback(
    async (body: ConfigPatch) => {
      let previousStatus: AgentConfigStatus | null = null;
      setSaveError(null);
      setStatus((current) => {
        if (!current) return current;
        previousStatus = current;
        const draft = { ...current.draft, ...body };
        const changedSections = computeChangedSections(
          { identity: draft.identity, personality: draft.personality, rules: draft.rules, knowledge: draft.knowledge, playbook: draft.playbook },
          current.latestVersion?.config_snapshot ?? null
        );
        return { ...current, draft, changedSections, hasPendingChanges: changedSections.length > 0 };
      });

      try {
        await apiFetch(`/agents/${agentId}/config`, { method: "PATCH", body: JSON.stringify(body) });
        await refetch();
      } catch (err) {
        if (previousStatus) setStatus(previousStatus);
        setSaveError(err instanceof Error ? err.message : "Não foi possível salvar as alterações.");
        throw err;
      }
    },
    [agentId, refetch]
  );

  return { status, loading, patch, refetch, saveError };
}
