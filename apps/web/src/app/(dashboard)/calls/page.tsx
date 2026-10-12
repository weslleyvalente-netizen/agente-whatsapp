"use client";

import { Fragment, useEffect, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { useMyRole } from "@/components/lead-distribution/use-my-role";
import { apiFetch } from "@/lib/api";
import { toISODateInTimeZone, CALL_STRATEGIES, CALL_STRATEGY_LABELS, type CallGroupStats, type CallStrategy } from "@aula-agente/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface Report {
  byStrategy: Record<CallStrategy, CallGroupStats>;
  byRep: { repUserId: string; repName: string | null; total: CallGroupStats; byStrategy: Record<CallStrategy, CallGroupStats> }[];
}
const MIN_SAMPLE = 30;
const pct = (v: number) => `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
const shiftDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function Row({ label, s }: { label: string; s: CallGroupStats }) {
  return (
    <tr className="border-t">
      <th scope="row" className="py-2 pr-4 text-left font-medium">
        {label}
        {s.calls < MIN_SAMPLE && <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-400">amostra pequena</span>}
      </th>
      <td className="tabular-data py-2 pr-4 text-right">{s.calls}</td>
      <td className="tabular-data py-2 pr-4 text-right">{s.leads}</td>
      <td className="tabular-data py-2 pr-4 text-right">{pct(s.answeredRate)}</td>
      <td className="tabular-data py-2 pr-4 text-right">{pct(s.proposalOrVisitRate)}</td>
      <td className="tabular-data py-2 pr-4 text-right">{pct(s.wonRate)}</td>
      <td className="tabular-data py-2 text-right">{s.noInterest}</td>
    </tr>
  );
}
function Head({ first }: { first: string }) {
  return (
    <thead>
      <tr className="text-left text-xs text-muted-foreground">
        <th className="pb-2 pr-4 font-medium">{first}</th>
        <th className="pb-2 pr-4 text-right font-medium">Ligações</th>
        <th className="pb-2 pr-4 text-right font-medium">Leads</th>
        <th className="pb-2 pr-4 text-right font-medium">% atenderam</th>
        <th className="pb-2 pr-4 text-right font-medium">% proposta/visita</th>
        <th className="pb-2 pr-4 text-right font-medium">% ganhos</th>
        <th className="pb-2 text-right font-medium">Sem interesse</th>
      </tr>
    </thead>
  );
}

export default function CallsPage() {
  const { currentOrg } = useOrganization();
  const { role } = useMyRole({ always: true });
  const isManager = role === "owner" || role === "admin";
  const today = toISODateInTimeZone(new Date());
  const [from, setFrom] = useState(shiftDays(today, -30));
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrg || !isManager || !from || !to || from > to) return;
    let cancelled = false;
    setLoading(true); setError(null);
    apiFetch(`/organizations/${currentOrg.id}/call-report?from=${from}&to=${to}`)
      .then(r => { if (!cancelled) setReport(r); })
      .catch(err => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentOrg, isManager, from, to]);

  if (role !== null && !isManager) return <div>Esta página é exclusiva para gestores.</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Ligações</h1>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm">De<Input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
        <label className="text-sm">Até<Input type="date" value={to} min={from} max={today} onChange={e => setTo(e.target.value)} /></label>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading && !report && <div>Carregando...</div>}
      {report && (
        <>
          <Card>
            <CardHeader><CardTitle>Mensagem antes de ligar x só ligar</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <Head first="Estratégia" />
                <tbody>{CALL_STRATEGIES.map(s => <Row key={s} label={CALL_STRATEGY_LABELS[s]} s={report.byStrategy[s]} />)}</tbody>
              </table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Por vendedor</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              {report.byRep.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma ligação registrada no período.</p> : (
                <table className="w-full text-sm">
                  <Head first="Vendedor" />
                  <tbody>
                    {report.byRep.map(r => (
                      <Fragment key={r.repUserId}>
                        <Row label={r.repName ?? "Vendedor"} s={r.total} />
                        {CALL_STRATEGIES.map(s => r.byStrategy[s].calls > 0 && <Row key={`${r.repUserId}-${s}`} label={`↳ ${CALL_STRATEGY_LABELS[s]}`} s={r.byStrategy[s]} />)}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
          <p className="text-sm text-muted-foreground">
            Com menos de {MIN_SAMPLE} ligações por grupo a amostra é pequena: a diferença entre as estratégias pode ser só acaso, não tire conclusões ainda.
            “% atenderam” é sobre as ligações; “% proposta/visita” e “% ganhos” são sobre os leads distintos ligados no período (um lead ligado das duas formas conta nos dois grupos).
            “Proposta/visita” considera leads que chegaram a proposta, simulação ou condições apresentadas (ou além) no funil.
          </p>
        </>
      )}
    </div>
  );
}
