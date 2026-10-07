"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import type { LeadAssignment, SalesRep } from "@aula-agente/shared";

const REASONS: Record<string, string> = {
  no_available_rep: "Nenhum vendedor disponível", all_reps_sla_breached: "Todos estouraram o SLA", invalid_existing_owner: "Dono atual inválido",
  distribution_error: "Erro na distribuição", manual_review: "Conflito: revisão manual",
};

/** Só para gestores (a rota devolve 403 para vendedores e o painel some). */
export function ExceptionsPanel() {
  const { currentOrg } = useOrganization();
  const [items, setItems] = useState<LeadAssignment[] | null>(null);
  const [alerts, setAlerts] = useState<LeadAssignment[]>([]);
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [target, setTarget] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg || currentOrg.settings.lead_distribution_enabled !== true) return;
    try {
      const [ex, al, r] = await Promise.all([
        apiFetch(`/organizations/${currentOrg.id}/lead-assignments/exceptions`),
        apiFetch(`/organizations/${currentOrg.id}/lead-assignments/sla-alerts`),
        apiFetch(`/organizations/${currentOrg.id}/sales-reps`),
      ]);
      setItems(ex); setAlerts(al); setReps(r);
    } catch { setItems(null); }
  }, [currentOrg]);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  if (!items) return null;
  const assign = async (a: LeadAssignment) => {
    const repId = target[a.id]; if (!repId || !currentOrg) return;
    setError(null);
    try { await apiFetch(`/organizations/${currentOrg.id}/lead-assignments/manual`, { method: "POST", body: JSON.stringify({ conversationId: a.conversation_id, repId }) }); await load(); }
    catch (err) { setError((err as Error).message); }
  };
  return (
    <section aria-label="Leads sem responsável" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/30">
      <h2 className="font-medium">Leads sem responsável <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs dark:bg-amber-900">{items.length}</span></h2>
      {!items.length && <p className="mt-1 text-muted-foreground">Nenhuma exceção no momento.</p>}
      {items.map(a => (
        <div key={a.id} className="mt-3 flex flex-wrap items-center gap-2">
          <span>{REASONS[a.exception_reason ?? ""] ?? a.exception_reason}</span>
          <select aria-label="Escolher vendedor" className="rounded border bg-background p-1" value={target[a.id] ?? ""} onChange={e => setTarget({ ...target, [a.id]: e.target.value })}>
            <option value="">Escolher vendedor…</option>
            {reps.filter(r => r.availability !== "out").map(r => <option key={r.id} value={r.id}>{r.display_name}</option>)}
          </select>
          <Button size="sm" disabled={!target[a.id]} onClick={() => assign(a)}>Atribuir</Button>
        </div>
      ))}
      {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
      {alerts.length > 0 && (
        <div className="mt-4 border-t pt-3" aria-label="Atrasos de resposta na carteira">
          <h3 className="font-medium">Atrasos de resposta (clientes que já têm vendedor) <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs dark:bg-amber-900">{alerts.length}</span></h3>
          <p className="text-xs text-muted-foreground">Estes clientes continuam com o mesmo vendedor; não há redistribuição automática.</p>
          {alerts.map(a => <p key={a.id} className="mt-1">{reps.find(r => r.id === a.rep_id)?.display_name ?? "—"} · prazo vencido em {new Date(a.sla_due_at ?? a.assigned_at).toLocaleString("pt-BR")}</p>)}
        </div>
      )}
    </section>
  );
}
