"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { TrainerProposal } from "@aula-agente/shared";

export interface TrainerChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  proposals: TrainerProposal[];
  created_at: string;
}

export function useTrainerSession(agentId: string) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TrainerChatMessage[]>([]);
  const [sending, setSending] = useState(false);

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    const session = (await apiFetch(`/agents/${agentId}/trainer/sessions`, { method: "POST" })) as { id: string };
    setSessionId(session.id);
    return session.id;
  }, [agentId, sessionId]);

  const sendMessage = useCallback(
    async (content: string, options: { analyzeConversations?: boolean } = {}) => {
      setSending(true);
      try {
        const id = await ensureSession();
        const optimisticUser: TrainerChatMessage = {
          id: `local-${Date.now()}`, session_id: id, role: "user", content, proposals: [], created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimisticUser]);

        const assistantMessage = (await apiFetch(`/agents/${agentId}/trainer/sessions/${id}/messages`, {
          method: "POST",
          // analyzeConversations is an explicit opt-in from the caller (the
          // "Analisar conversas reais" quick action), never inferred from
          // the text the user typed.
          body: JSON.stringify({ content, analyzeConversations: options.analyzeConversations ?? false }),
        })) as TrainerChatMessage;
        setMessages((prev) => [...prev, assistantMessage]);
      } finally {
        setSending(false);
      }
    },
    [agentId, ensureSession]
  );

  const decideProposal = useCallback(
    async (proposalId: string, decision: "apply" | "reject") => {
      const updated = (await apiFetch(`/agents/${agentId}/trainer/proposals/${proposalId}/${decision}`, { method: "POST" })) as TrainerProposal;
      setMessages((prev) => prev.map((m) => ({ ...m, proposals: m.proposals.map((p) => (p.id === proposalId ? updated : p)) })));
    },
    [agentId]
  );

  const pendingProposalsCount = messages.reduce((count, m) => count + m.proposals.filter((p) => p.status === "proposed").length, 0);

  return { messages, sendMessage, sending, decideProposal, pendingProposalsCount };
}
