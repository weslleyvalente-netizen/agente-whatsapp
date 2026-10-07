"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import type { LeadAssignment, SalesRep } from "@aula-agente/shared";

const REASONS: Record<string, string> = { round_robin: "Rodízio", existing_owner: "Já tinha vendedor (cliente da carteira)", sla_redistribution: "SLA estourado", manual: "Reatribuição manual", bulk_reassignment: "Reatribuição em lote", exception: "Exceção" };
const when = (v: string | null) => v ? new Date(v).toLocaleString("pt-BR") : "—";

export function AssignmentHistory({ contactId }: { contactId: string }) {
  const { currentOrg } = useOrganization();
  const [rows, setRows] = useState<LeadAssignment[] | null>(null);
  const [reps, setReps] = useState<SalesRep[]>([]);
  useEffect(() => {
    if (!currentOrg || currentOrg.settings.lead_distribution_enabled !== true) return;
    Promise.all([apiFetch(`/organizations/${currentOrg.id}/contacts/${contactId}/lead-assignments`), apiFetch(`/organizations/${currentOrg.id}/sales-reps`)])
      .then(([h, r]) => { setRows(h); setReps(r); }).catch(() => setRows([]));
  }, [currentOrg, contactId]);
  if (!rows?.length) return null;
  const name = (id: string | null) => reps.find(r => r.id === id)?.display_name ?? "—";
  return (
    <section className="rounded-lg border p-4" aria-label="Histórico de atribuição">
      <h3 className="mb-3 font-medium">Atribuição do lead</h3>
      {rows.map(a => (
        <div key={a.id} className="mb-3 border-l-2 pl-3 text-sm">
          <p className="font-medium">{a.rep_id ? name(a.rep_id) : "Sem vendedor"} · {REASONS[a.reason] ?? a.reason}</p>
          <p className="text-xs text-muted-foreground">Atribuído: {when(a.assigned_at)} · Assumiu: {when(a.accepted_at)}{a.accepted_via ? ` (${a.accepted_via})` : ""}</p>
          {a.sla_breached && <p className="text-xs text-destructive">SLA estourado{a.redistribution_reason ? ` · ${a.redistribution_reason}` : ""}{a.next_assignment_id ? ` → ${name(rows.find(x => x.id === a.next_assignment_id)?.rep_id ?? null)}` : ""}</p>}
          {a.status === "exception" && <p className="text-xs text-destructive">Exceção: {a.exception_reason}{a.resolved_at ? ` · resolvida em ${when(a.resolved_at)}` : ""}</p>}
        </div>
      ))}
    </section>
  );
}
