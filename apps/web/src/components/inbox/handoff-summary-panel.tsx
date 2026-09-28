"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { HANDOFF_MOTIVO_LABELS } from "@aula-agente/shared";
import type { HandoffEvent } from "@aula-agente/shared";

interface HandoffSummaryPanelProps {
  conversationId: string;
}

function formatWaitMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}min`;
}

// Shows the most recent requestHuman handoff for this conversation at the
// top of the sidebar — so whoever picks it up sees why, without scrolling
// the whole thread first. Only request_human handoffs carry a motivo/resumo
// worth surfacing here (painel_manual/fromMe_real are just "a human
// replied", already obvious from the thread itself).
export function HandoffSummaryPanel({ conversationId }: HandoffSummaryPanelProps) {
  const [handoff, setHandoff] = useState<HandoffEvent | null>(null);

  const fetchHandoff = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("handoff_events")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("trigger_type", "request_human")
      .order("handed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setHandoff((data as HandoffEvent | null) ?? null);
  }, [conversationId]);

  useEffect(() => {
    fetchHandoff();
  }, [fetchHandoff]);

  if (!handoff) return null;

  const waiting = !handoff.first_human_reply_at;
  const waitMinutes = Math.round((Date.now() - new Date(handoff.handed_at).getTime()) / 60_000);

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Handoff</h3>
        {waiting ? (
          <Badge variant="destructive">Aguardando há {formatWaitMinutes(waitMinutes)}</Badge>
        ) : (
          <Badge variant="secondary">Respondido</Badge>
        )}
      </div>
      {handoff.motivo && (
        <p className="mt-1 text-sm">
          <span className="font-medium">Motivo:</span> {HANDOFF_MOTIVO_LABELS[handoff.motivo]}
          {handoff.urgencia && handoff.urgencia !== "normal" ? ` · urgência ${handoff.urgencia}` : ""}
        </p>
      )}
      {handoff.resumo && <p className="mt-1 text-sm text-muted-foreground">{handoff.resumo}</p>}
    </div>
  );
}
