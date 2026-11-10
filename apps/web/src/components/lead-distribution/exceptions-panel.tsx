"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import type { LeadAssignment, SalesRep, SlaAlert } from "@aula-agente/shared";
import { SlaAlertsSection } from "./sla-alerts-section";
import { nudgedAtLabel, summarizeNudgeAll, type NudgeAllResult } from "@/lib/sla-alert-view";

const REASONS: Record<string, string> = {
  no_available_rep: "Nenhum vendedor disponível", all_reps_sla_breached: "Todos estouraram o SLA", invalid_existing_owner: "Dono atual inválido",
  distribution_error: "Erro na distribuição", manual_review: "Conflito: revisão manual",
};

/** Só para gestores (a rota devolve 403 para vendedores e o painel some). */
export function ExceptionsPanel() {
  const { currentOrg } = useOrganization();
  const [items, setItems] = useState<LeadAssignment[] | null>(null);
  const [alerts, setAlerts] = useState<SlaAlert[]>([]);
  const [nudged, setNudged] = useState<Record<string, string>>({});
  const [nudgeBusy, setNudgeBusy] = useState<Record<string, boolean>>({});
  const [nudgingAll, setNudgingAll] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [target, setTarget] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const [forbidden, setForbidden] = useState(false);
  const enabled = currentOrg?.settings.lead_distribution_enabled === true;

  const load = useCallback(async () => {
    if (!currentOrg || !enabled) { setItems(null); setAlerts([]); return; }
    try {
      const [ex, al, r] = await Promise.all([
        apiFetch(`/organizations/${currentOrg.id}/lead-assignments/exceptions`),
        apiFetch(`/organizations/${currentOrg.id}/lead-assignments/sla-alerts`),
        apiFetch(`/organizations/${currentOrg.id}/sales-reps`),
      ]);
      setItems(ex); setAlerts(al); setReps(r);
    } catch (err) {
      setItems(null); setAlerts([]);
      if ((err as { status?: number }).status === 403) setForbidden(true);
    }
  }, [currentOrg, enabled]);
  useEffect(() => { setForbidden(false); }, [currentOrg?.id]);
  useEffect(() => {
    if (!enabled || forbidden) { setItems(null); setAlerts([]); return; }
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, [load, enabled, forbidden]);

  if (!items) return null;
  const assign = async (a: LeadAssignment) => {
    const repId = target[a.id]; if (!repId || !currentOrg) return;
    setError(null);
    try { await apiFetch(`/organizations/${currentOrg.id}/lead-assignments/manual`, { method: "POST", body: JSON.stringify({ conversationId: a.conversation_id, repId }) }); await load(); }
    catch (err) { setError((err as Error).message); }
  };
  const nudge = async (id: string) => {
    if (!currentOrg) return;
    setNotice(null); setNudgeBusy(b => ({ ...b, [id]: true }));
    try {
      const r = await apiFetch(`/organizations/${currentOrg.id}/lead-assignments/${id}/nudge`, { method: "POST" }) as { status: string; nudgedAt?: string };
      if (r.status === "sent" && r.nudgedAt) setNudged(n => ({ ...n, [id]: nudgedAtLabel(r.nudgedAt!) }));
      else setNotice({ kind: "error", text: "O vendedor não tem notificações ativadas" });
    } catch (err) { setNotice({ kind: "error", text: (err as Error).message }); }
    finally { setNudgeBusy(b => ({ ...b, [id]: false })); }
  };
  const nudgeAll = async () => {
    if (!currentOrg) return;
    setNotice(null); setNudgingAll(true);
    try {
      const r = await apiFetch(`/organizations/${currentOrg.id}/lead-assignments/nudge-all`, { method: "POST" }) as { results: NudgeAllResult[] };
      setNotice({ kind: "info", text: summarizeNudgeAll(r.results) });
    } catch (err) { setNotice({ kind: "error", text: (err as Error).message }); }
    finally { setNudgingAll(false); }
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
      <SlaAlertsSection alerts={alerts} reps={reps} nudged={nudged} busy={nudgeBusy} nudgingAll={nudgingAll} notice={notice} onNudge={nudge} onNudgeAll={nudgeAll} />
    </section>
  );
}
