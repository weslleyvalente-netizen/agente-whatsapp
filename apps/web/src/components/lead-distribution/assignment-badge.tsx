"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import { describeSla } from "./format";

export interface CardAssignment { id: string; rep_id: string | null; rep_name: string | null; status: "pending" | "accepted"; sla_due_at: string | null; sla_action: "redistribute" | "alert"; sla_breached: boolean; assigned_at: string; accepted_at: string | null }

export function AssignmentBadge({ assignment, canAccept, onAccepted }: { assignment: CardAssignment; canAccept: boolean; onAccepted: () => void }) {
  const { currentOrg } = useOrganization();
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);

  const sla = assignment.status === "pending" ? describeSla(assignment.sla_due_at, now) : null;
  const accept = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!currentOrg) return;
    setBusy(true); setError(null);
    try { await apiFetch(`/lead-assignments/${assignment.id}/accept?organizationId=${currentOrg.id}`, { method: "POST" }); onAccepted(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1 text-xs">
      <span className="font-medium">{assignment.rep_name ?? "Sem vendedor"}</span>
      {assignment.status === "accepted" && <span className="text-muted-foreground">assumido</span>}
      {sla && (assignment.sla_action === "alert"
        ? <span className={sla.overdue ? "text-destructive" : "text-muted-foreground"}>{sla.overdue ? `Atraso de resposta · ${sla.label}` : `Responder em ${sla.label}`} (cliente da carteira)</span>
        : <span className={sla.overdue ? "text-destructive" : "text-muted-foreground"}>Prazo: {sla.label}</span>)}
      {assignment.status === "pending" && canAccept && <Button size="sm" disabled={busy} onClick={accept}>Assumir lead</Button>}
      {error && <span role="alert" className="text-destructive">{error}</span>}
    </div>
  );
}
