"use client";

import { useEffect, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface DailyCost {
  date: string;
  costUsd: number;
  costBrl: number | null;
  rate: number | null;
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

interface SourceCost {
  source: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
}

interface MonthlyCost {
  month: string;
  costUsd: number;
  costBrl: number;
  avgRate: number | null;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  unconvertedDays: number;
}

interface CostSummary {
  ratesAvailable: boolean;
  unconvertedDays: number;
  totalCostBrl: number | null;
  last30dCostBrl: number | null;
  todayCostBrl: number | null;
  todayRate: number | null;
  monthlyCosts: MonthlyCost[];
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
  bySource: SourceCost[];
}

const SOURCE_LABELS: Record<string, string> = {
  conversation: "Conversas com clientes",
  playground: "Playground",
  trainer: "Trainer",
  image_description: "Descrição de imagens",
  import_suggestion: "Importar configuração",
};

function formatUsd(value: number) {
  return `$${value.toFixed(4)}`;
}

function formatBrl(value: number | null) {
  return value === null ? "—" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatRate(value: number | null) {
  return value === null ? "—" : value.toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function formatMonth(ym: string) {
  const [year, month] = ym.split("-");
  const name = new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("pt-BR", { month: "long" });
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}/${year}`;
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
      <h1 className="text-2xl font-bold">Custos de IA (em reais)</h1>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Custo total</p>
          </CardHeader>
          <CardContent>
            <p className="tabular-data text-2xl font-medium text-primary">{summary.ratesAvailable ? formatBrl(summary.totalCostBrl) : formatUsd(summary.totalCostUsd)}</p>
            {summary.ratesAvailable && <p className="tabular-data text-xs text-muted-foreground">{formatUsd(summary.totalCostUsd)}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Hoje</p>
          </CardHeader>
          <CardContent>
            <p className="tabular-data text-2xl font-medium">{summary.ratesAvailable ? formatBrl(summary.todayCostBrl) : formatUsd(summary.todayCostUsd)}</p>
            {summary.ratesAvailable && (
              <p className="tabular-data text-xs text-muted-foreground">
                {formatUsd(summary.todayCostUsd)} · parcial, cotação {formatRate(summary.todayRate)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <p className="label-eyebrow">Ultimos 30 dias</p>
          </CardHeader>
          <CardContent>
            <p className="tabular-data text-2xl font-medium">{summary.ratesAvailable ? formatBrl(summary.last30dCostBrl) : formatUsd(summary.last30dCostUsd)}</p>
            {summary.ratesAvailable && <p className="tabular-data text-xs text-muted-foreground">{formatUsd(summary.last30dCostUsd)}</p>}
          </CardContent>
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

      <p className="text-sm text-muted-foreground">
        {summary.ratesAvailable
          ? `Valores em reais: cada dia convertido pela cotação PTAX de fechamento do dólar (Banco Central) do próprio dia; fins de semana e feriados usam a última cotação anterior.${summary.unconvertedDays > 0 ? ` ${summary.unconvertedDays} dia(s) sem cotação ficaram fora do total em reais.` : ""}`
          : "Cotação do dólar indisponível no momento: exibindo valores em dólar."}
      </p>

      {summary.monthlyCosts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Custo por mês</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="label-eyebrow py-2 pr-4 font-normal">Mês</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Mensagens</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Tokens (in/out)</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Dólar (US$)</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Cotação média</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Custo (R$)</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.monthlyCosts.map((m) => (
                    <tr key={m.month} className="border-b border-border last:border-0">
                      <td className="py-2 pr-4">{formatMonth(m.month)}</td>
                      <td className="tabular-data py-2 pr-4">{m.messageCount}</td>
                      <td className="tabular-data py-2 pr-4">
                        {m.inputTokens.toLocaleString("pt-BR")} / {m.outputTokens.toLocaleString("pt-BR")}
                      </td>
                      <td className="tabular-data py-2 pr-4">{formatUsd(m.costUsd)}</td>
                      <td className="tabular-data py-2 pr-4">{formatRate(m.avgRate)}</td>
                      <td className="tabular-data py-2 pr-4 text-primary">{summary.ratesAvailable ? formatBrl(m.costBrl) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

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
                    <th className="label-eyebrow py-2 pr-4 font-normal">Dólar (US$)</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Cotação</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Custo (R$)</th>
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
                      <td className="tabular-data py-2 pr-4">{formatUsd(day.costUsd)}</td>
                      <td className="tabular-data py-2 pr-4">{formatRate(day.rate)}</td>
                      <td className="tabular-data py-2 pr-4 text-primary">{formatBrl(day.costBrl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {summary.bySource.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Por origem</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="label-eyebrow py-2 pr-4 font-normal">Origem</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Chamadas</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Tokens (in/out)</th>
                    <th className="label-eyebrow py-2 pr-4 font-normal">Custo</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.bySource.map((s) => (
                    <tr key={s.source} className="border-b border-border last:border-0">
                      <td className="py-2 pr-4">{SOURCE_LABELS[s.source] ?? s.source}</td>
                      <td className="tabular-data py-2 pr-4">{s.messageCount}</td>
                      <td className="tabular-data py-2 pr-4">
                        {s.inputTokens.toLocaleString("pt-BR")} / {s.outputTokens.toLocaleString("pt-BR")}
                      </td>
                      <td className="tabular-data py-2 pr-4 text-primary">{formatUsd(s.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

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
