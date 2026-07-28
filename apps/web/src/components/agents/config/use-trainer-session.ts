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

// `onProposalApplied` fires only after a proposal is successfully applied —
// that's the one decision that writes to agent_configs, so it's the one that
// makes the page's cached config status (and DraftStatusBar's "Publicar N"
// badge) stale. Rejecting never touches agent_configs, so it doesn't fire.
export function useTrainerSession(agentId: string, onProposalApplied?: () => void) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TrainerChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  // Keyed by proposal id: a failed apply/reject has to stay visible on the
  // proposal it belongs to, otherwise the button just re-enables and the
  // user cannot tell whether the config was written.
  const [decisionErrors, setDecisionErrors] = useState<Record<string, string>>({});

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
      try {
        const updated = (await apiFetch(`/agents/${agentId}/trainer/proposals/${proposalId}/${decision}`, { method: "POST" })) as TrainerProposal;
        setMessages((prev) => prev.map((m) => ({ ...m, proposals: m.proposals.map((p) => (p.id === proposalId ? updated : p)) })));
        setDecisionErrors((prev) => {
          if (!(proposalId in prev)) return prev;
          return Object.fromEntries(Object.entries(prev).filter(([id]) => id !== proposalId));
        });
      } catch (err) {
        // Swallowed on purpose: without this catch the rejection escapes
        // TrainerProposalCard's handleDecide as an unhandled rejection and
        // the failure is completely invisible. The message is surfaced on
        // the proposal card instead.
        const detail = err instanceof Error ? err.message : "";
        const base = decision === "apply" ? "Falha ao aplicar" : "Falha ao rejeitar";
        setDecisionErrors((prev) => ({ ...prev, [proposalId]: detail ? `${base}: ${detail}` : `${base} — tente novamente` }));
        return;
      }

      // Outside the try so a failing refresh can never be reported as a
      // failed apply — by this point the write already succeeded. Only
      // "apply" writes agent_configs; "reject" leaves the draft untouched.
      if (decision === "apply") onProposalApplied?.();
    },
    [agentId, onProposalApplied]
  );

  const pendingProposalsCount = messages.reduce((count, m) => count + m.proposals.filter((p) => p.status === "proposed").length, 0);

  return { messages, sendMessage, sending, decideProposal, decisionErrors, pendingProposalsCount };
}
