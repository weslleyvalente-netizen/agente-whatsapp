"use client";
import { useCallback, useEffect, useState } from "react";
import type { SalesRep } from "@aula-agente/shared";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { nudgedAtLabel, nudgeNotDeliveredMessage } from "@/lib/sla-alert-view";
import type { TriageResponse } from "@/lib/exception-triage-view";
import { ExceptionTriageSection } from "./exception-triage-section";

/** Contêiner do painel de triagem (só gestores; some em 403 ou quando o servidor responde enabled:false). */
export function ExceptionTriagePanel() {
  const { currentOrg } = useOrganization();
  const [data, setData] = useState<TriageResponse | null>(null);
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg) return;
    try {
      const [d, r] = await Promise.all([
        apiFetch(`/organizations/${currentOrg.id}/exception-triage`) as Promise<TriageResponse>,
        apiFetch(`/organizations/${currentOrg.id}/sales-reps`) as Promise<SalesRep[]>,
      ]);
      setData(d); setReps(r);
    } catch (err) {
      setData(null);
      if ((err as { status?: number }).status === 403) setForbidden(true);
    }
  }, [currentOrg]);
  useEffect(() => { setForbidden(false); }, [currentOrg?.id]);
  useEffect(() => {
    if (!currentOrg || forbidden) return;
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, [load, currentOrg, forbidden]);

  const post = async (id: string, body: Record<string, unknown>, ok: string) => {
    if (!currentOrg) return;
    setNotice(null); setBusy(b => ({ ...b, [id]: true }));
    try {
      await apiFetch(`/organizations/${currentOrg.id}/exception-events/${id}`, { method: "POST", body: JSON.stringify(body) });
      setNotice({ kind: "info", text: ok });
      await load();
    } catch (err) { setNotice({ kind: "error", text: (err as Error).message }); }
    finally { setBusy(b => ({ ...b, [id]: false })); }
  };
  const nudgeSeller = async (id: string) => {
    if (!currentOrg) return;
    setNotice(null); setBusy(b => ({ ...b, [id]: true }));
    try {
      const r = await apiFetch(`/organizations/${currentOrg.id}/lead-assignments/${id}/nudge`, { method: "POST" }) as { status: string; nudgedAt?: string };
      setNotice(r.status === "sent" && r.nudgedAt ? { kind: "info", text: nudgedAtLabel(r.nudgedAt) } : { kind: "error", text: nudgeNotDeliveredMessage(r.status) });
    } catch (err) { setNotice({ kind: "error", text: (err as Error).message }); }
    finally { setBusy(b => ({ ...b, [id]: false })); }
  };

  if (!data || !data.enabled) return null;
  return (
    <ExceptionTriageSection
      data={data} reps={reps} busy={busy} notice={notice}
      onAcknowledge={id => post(id, { kind: "acknowledged" }, "Exceção reconhecida.")}
      onConfirm={(id, repId, note) => post(id, { kind: "resolved_confirmed", repId, note: note || undefined }, "Registrado: quem assumiu foi confirmado.")}
      onNoAction={(id, note, waitingJustification) => post(id, { kind: "resolved_no_action", note, ...(waitingJustification ? { waitingJustification } : {}) }, "Registrado: sem ação necessária.")}
      onNudgeSeller={nudgeSeller}
    />
  );
}
