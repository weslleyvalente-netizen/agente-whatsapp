"use client";
import { useEffect, useState } from "react";
import type { ProposalMetricLine } from "@aula-agente/shared";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Data = { available: false; days: number } | { available: true; days: number; sellers: ProposalMetricLine[]; total: ProposalMetricLine; note: string };

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Acompanhamento de propostas por vendedor (só gestor: 403 esconde o cartão). Correlação, não causa. */
export function ProposalMetricsCard({ organizationId }: { organizationId: string }) {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    let alive = true;
    apiFetch(`/organizations/${organizationId}/proposal-metrics?days=30`).then((d) => { if (alive) setData(d as Data); }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [organizationId]);
  if (!data) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Acompanhamento de propostas (30 dias)</CardTitle></CardHeader>
      <CardContent>
        {!data.available || data.total.proposals === 0 ? (
          <p className="text-sm text-muted-foreground">Ainda não há propostas identificadas no período.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="py-2 pr-2 font-medium">Vendedor</th><th className="px-2 font-medium">Propostas</th><th className="px-2 font-medium">Até 30 min</th><th className="px-2 font-medium">Até 1 dia</th><th className="px-2 font-medium">Até 3 dias</th><th className="px-2 font-medium">Cliente respondeu antes</th><th className="px-2 font-medium">Vendas</th></tr>
              </thead>
              <tbody className="tabular-nums">
                {[...data.sellers, data.total].map((s, i) => (
                  <tr key={`${s.ownerUserId ?? "none"}-${i}`} className={i === data.sellers.length ? "border-t font-medium" : ""}>
                    <td className="py-2 pr-2">{s.name}</td>
                    <td className="px-2">{s.proposals}</td>
                    <td className="px-2">{pct(s.pct30m)}</td>
                    <td className="px-2">{pct(s.pct1d)}</td>
                    <td className="px-2">{pct(s.pct3d)}</td>
                    <td className="px-2">{s.customerRepliedFirst}</td>
                    <td className="px-2">{s.won} ({pct(s.conversion)})</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">Percentuais sobre as propostas em que o cliente não respondeu antes. {data.note}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
