"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
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

  const refetch = useCallback(async () => {
    const data = (await apiFetch(`/agents/${agentId}/config`)) as AgentConfigStatus;
    setStatus(data);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const patch = useCallback(
    async (body: ConfigPatch) => {
      await apiFetch(`/agents/${agentId}/config`, { method: "PATCH", body: JSON.stringify(body) });
      await refetch();
    },
    [agentId, refetch]
  );

  return { status, loading, patch, refetch };
}
