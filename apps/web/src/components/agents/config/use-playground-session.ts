"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { AgentPlaygroundMessage } from "@aula-agente/shared";

export function usePlaygroundSession(agentId: string) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentPlaygroundMessage[]>([]);
  const [sending, setSending] = useState(false);

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    const session = (await apiFetch(`/agents/${agentId}/playground/sessions`, { method: "POST" })) as { id: string };
    setSessionId(session.id);
    return session.id;
  }, [agentId, sessionId]);

  const sendMessage = useCallback(
    async (content: string) => {
      setSending(true);
      try {
        const id = await ensureSession();
        const optimisticUser: AgentPlaygroundMessage = {
          id: `local-${Date.now()}`, session_id: id, organization_id: "",
          role: "user", content, tool_calls: [], created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimisticUser]);

        const assistantMessage = (await apiFetch(`/agents/${agentId}/playground/sessions/${id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content }),
        })) as AgentPlaygroundMessage;
        setMessages((prev) => [...prev, assistantMessage]);
      } finally {
        setSending(false);
      }
    },
    [agentId, ensureSession]
  );

  const reset = useCallback(() => {
    setSessionId(null);
    setMessages([]);
  }, []);

  return { messages, sendMessage, sending, reset };
}
