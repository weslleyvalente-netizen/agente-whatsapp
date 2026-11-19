"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import type { SalesRep, SlaAlert } from "@aula-agente/shared";
import { SlaAlertsSection } from "./sla-alerts-section";
import { exceptionRow, nudgedAtLabel, nudgeNotDeliveredMessage, summarizeNudgeAll, type NudgeAllResult } from "@/lib/sla-alert-view";

/** "Atraso no atendimento" no funil. Só aviso (sem escolher vendedor): clientes que ninguém respondeu e atrasos da carteira. Só gestores (403 some o painel). */
export function ExceptionsPanel() {
  const { currentOrg } = useOrganization();
  const [items, setItems] = useState<SlaAlert[] | null>(null);
  const [alerts, setAlerts] = useState<SlaAlert[]>([]);
  const [nudged, setNudged] = useState<Record<string, string>>({});
  const [nudgeBusy, setNudgeBusy] = useState<Record<string, boolean>>({});
  const [nudgingAll, setNudgingAll] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [reps, setReps] = useState<SalesRep[]>([]);

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
  const nudge = async (id: string) => {
    if (!currentOrg) return;
    setNotice(null); setNudgeBusy(b => ({ ...b, [id]: true }));
    try {
      const r = await apiFetch(`/organizations/${currentOrg.id}/lead-assignments/${id}/nudge`, { method: "POST" }) as { status: string; nudgedAt?: string };
      if (r.status === "sent" && r.nudgedAt) setNudged(n => ({ ...n, [id]: nudgedAtLabel(r.nudgedAt!) }));
      else setNotice({ kind: "error", text: nudgeNotDeliveredMessage(r.status) });
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
  if (!items.length && !alerts.length) return null;
  const total = items.length + alerts.length;
  return (
    <details open aria-label="Atraso no atendimento" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/30">
      <summary className="cursor-pointer font-medium">Atraso no atendimento <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs dark:bg-amber-900">{total}</span></summary>
      {items.length > 0 && (
        <div className="mt-3" aria-label="Clientes que nenhum vendedor respondeu">
          <h3 className="font-medium">Ninguém respondeu <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs dark:bg-amber-900">{items.length}</span></h3>
          <p className="text-xs text-muted-foreground">O sistema não troca mais de vendedor sozinho nem pede para você escolher. Abra a conversa e cobre o vendedor do cliente.</p>
          {items.map(e => {
            const row = exceptionRow(e);
            return (
              <div key={e.id} className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <a href={row.href} className="font-medium underline-offset-2 hover:underline">{row.client}</a>
                <span className="text-muted-foreground">· {row.reason} · aguardando {row.waiting}</span>
              </div>
            );
          })}
        </div>
      )}
      <SlaAlertsSection alerts={alerts} reps={reps} nudged={nudged} busy={nudgeBusy} nudgingAll={nudgingAll} notice={notice} onNudge={nudge} onNudgeAll={nudgeAll} />
    </details>
  );
}
