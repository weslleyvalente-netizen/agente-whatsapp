"use client";

import { useEffect, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface DailyCost {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
}

interface ModelCost {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  priced: boolean;
}

interface CostSummary {
  totalCostUsd: number;
  todayCostUsd: number;
  last30dCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  exactMessageCount: number;
  unpricedMessageCount: number;
  legacyMessageCount: number;
  dailyCosts: DailyCost[];
  byModel: ModelCost[];
}

function formatUsd(value: number) {
  return `$${value.toFixed(4)}`;
}

function formatDate(isoDate: string) {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

export default function CostsPage() {
  const { currentOrg } = useOrganization();
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg) return;
    apiFetch(`/organizations/${currentOrg.id}/costs/summary`)
      .then(setSummary)
      .finally(() => setLoading(false));
  }, [currentOrg]);

  if (loading) return <div>Carregando...</div>;
  if (!summary) return <div>Nao foi possivel carregar os custos.</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Custos de IA</h1>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Custo total</p>
          </CardHeader>
          <CardContent className="tabular-data text-2xl font-medium text-primary">{formatUsd(summary.totalCostUsd)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Hoje</p>
          </CardHeader>
          <CardContent className="tabular-data text-2xl font-medium">{formatUsd(summary.todayCostUsd)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Ultimos 30 dias</p>
          </CardHeader>
          <CardContent className="tabular-data text-2xl font-medium">{formatUsd(summary.last30dCostUsd)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Tokens (in / out)</p>
          </CardHeader>
          <CardContent className="tabular-data text-2xl font-medium">
            {summary.totalInputTokens.toLocaleString("pt-BR")} / {summary.totalOutputTokens.toLocaleString("pt-BR")}
          </CardContent>
        </Card>
      </div>

      {(summary.legacyMessageCount > 0 || summary.unpricedMessageCount > 0) && (
        <p className="text-sm text-muted-foreground">
          {summary.legacyMessageCount > 0 &&
            `${summary.legacyMessageCount} mensagem(ns) antiga(s) sem separacao de tokens nao entraram no calculo. `}
          {summary.unpricedMessageCount > 0 &&
            `${summary.unpricedMessageCount} mensagem(ns) usaram um modelo sem preco configurado.`}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Custo por dia (ultimos 30 dias)</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.dailyCosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum dado no periodo.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="label-eyebrow py-2 pr-4 font-normal">Data</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Mensagens</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Tokens (in/out)</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Custo</th>
                  </tr>
                </thead>
                <tbody>
                  {[...summary.dailyCosts].reverse().map((day) => (
                    <tr key={day.date} className="border-b border-border last:border-0">
                      <td className="tabular-data py-2 pr-4">{formatDate(day.date)}</td>
                      <td className="tabular-data py-2 pr-4">{day.messageCount}</td>
                      <td className="tabular-data py-2 pr-4">
                        {day.inputTokens.toLocaleString("pt-BR")} / {day.outputTokens.toLocaleString("pt-BR")}
                      </td>
                      <td className="tabular-data py-2 pr-4 text-primary">{formatUsd(day.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {summary.byModel.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Por modelo</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="label-eyebrow py-2 pr-4 font-normal">Modelo</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Mensagens</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Tokens (in/out)</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Custo</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byModel.map((m) => (
                    <tr key={m.model} className="border-b border-border last:border-0">
                      <td className="tabular-data py-2 pr-4">{m.model}</td>
                      <td className="tabular-data py-2 pr-4">{m.messageCount}</td>
                      <td className="tabular-data py-2 pr-4">
                        {m.inputTokens.toLocaleString("pt-BR")} / {m.outputTokens.toLocaleString("pt-BR")}
                      </td>
                      <td className="tabular-data py-2 pr-4 text-primary">{m.priced ? formatUsd(m.costUsd) : "sem preco"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
