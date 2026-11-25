// Métricas de acompanhamento de proposta (desenho 2026-11-22). Função pura.
// Faixas acumuladas em minutos úteis: até 30 min, até 1 dia útil, até 3 dias úteis. "Cliente respondeu antes" fica à parte:
// não precisou de acompanhamento. Conversão = negócios ganhos / propostas. É correlação, não causa.
import { addBusinessMinutes, businessDayMinutes, type BusinessCalendar } from "./business-calendar.js";
import { PROPOSAL_FOLLOWUP_MINUTES } from "./commitments.js";

export interface ProposalMetricRow { ownerUserId: string | null; sentAt: string; firstSellerFollowupAt: string | null; firstCustomerReplyAt: string | null; outcome: string | null; opportunityStatus?: string | null }
export interface ProposalMetricLine {
  ownerUserId: string | null; name: string; proposals: number; customerRepliedFirst: number; needingFollowup: number;
  within30m: number; within1d: number; within3d: number; pct30m: number; pct1d: number; pct3d: number; won: number; lost: number; conversion: number;
}
export const PROPOSAL_METRICS_NOTE = "Correlação, não causa: o tempo de acompanhamento sozinho não explica a venda.";

function line(ownerUserId: string | null, name: string, rows: ProposalMetricRow[], calendar: BusinessCalendar): ProposalMetricLine {
  const day = businessDayMinutes(calendar) || 600;
  let customerRepliedFirst = 0, within30m = 0, within1d = 0, within3d = 0, won = 0, lost = 0;
  for (const r of rows) {
    if (r.outcome === "won") won++;
    if (r.outcome === "lost") lost++;
    const c = r.firstCustomerReplyAt ? Date.parse(r.firstCustomerReplyAt) : Infinity;
    const s = r.firstSellerFollowupAt ? Date.parse(r.firstSellerFollowupAt) : Infinity;
    if (c <= s && c !== Infinity) { customerRepliedFirst++; continue; }
    if (s === Infinity) continue;
    const sent = new Date(r.sentAt);
    if (s <= addBusinessMinutes(sent, PROPOSAL_FOLLOWUP_MINUTES, calendar).getTime()) within30m++;
    if (s <= addBusinessMinutes(sent, day, calendar).getTime()) within1d++;
    if (s <= addBusinessMinutes(sent, 3 * day, calendar).getTime()) within3d++;
  }
  const proposals = rows.length;
  const needingFollowup = proposals - customerRepliedFirst;
  const pct = (n: number) => (needingFollowup > 0 ? n / needingFollowup : 0);
  return {
    ownerUserId, name, proposals, customerRepliedFirst, needingFollowup, within30m, within1d, within3d,
    pct30m: pct(within30m), pct1d: pct(within1d), pct3d: pct(within3d), won, lost, conversion: proposals > 0 ? won / proposals : 0,
  };
}

export function aggregateProposalMetrics(allRows: ProposalMetricRow[], calendar: BusinessCalendar, names: Record<string, string>) {
  // Proposta de negócio anulado não entra no total nem na conversão.
  const rows = allRows.filter((r) => r.opportunityStatus !== "void");
  const byOwner = new Map<string | null, ProposalMetricRow[]>();
  for (const r of rows) { const k = r.ownerUserId ?? null; byOwner.set(k, [...(byOwner.get(k) ?? []), r]); }
  const sellers = [...byOwner.entries()]
    .map(([id, list]) => line(id, id ? names[id] ?? "Vendedor" : "Sem vendedor", list, calendar))
    .sort((a, b) => b.proposals - a.proposals || a.name.localeCompare(b.name));
  return { sellers, total: line(null, "Total", rows, calendar), note: PROPOSAL_METRICS_NOTE };
}
