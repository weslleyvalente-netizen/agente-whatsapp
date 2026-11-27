"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import type { SalesRep, SlaAlert } from "@aula-agente/shared";
import { DelayBoard } from "./delay-board";
import { ExceptionTriagePanel } from "./exception-triage-panel";
import { nudgedAtLabel, nudgeNotDeliveredMessage, summarizeNudgeAll, type NudgeAllResult } from "@/lib/sla-alert-view";

/** "Atraso no atendimento" no funil. Só aviso (sem escolher vendedor): clientes que ninguém respondeu e atrasos da carteira. Só gestores (403 some o painel). */
/** Painel atual (comportamento sem mudança quando a triagem está desligada). */
function LegacyExceptionsPanel() {
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
  return <DelayBoard exceptions={items} alerts={alerts} reps={reps} nudged={nudged} busy={nudgeBusy} nudgingAll={nudgingAll} notice={notice} onNudge={nudge} onNudgeAll={nudgeAll} />;
}

/**
 * Só para gestores (a rota devolve 403 para vendedores e o painel some). Com settings.exception_triage_panel_enabled = true mostra a
 * triagem (urgentes / respondidas / obsoletas) do PR #102; sem a chave (padrão) o painel atual segue exatamente como está.
 */
export function ExceptionsPanel() {
  const { currentOrg } = useOrganization();
  if (currentOrg?.settings.exception_triage_panel_enabled === true) return <ExceptionTriagePanel />;
  return <LegacyExceptionsPanel />;
}
