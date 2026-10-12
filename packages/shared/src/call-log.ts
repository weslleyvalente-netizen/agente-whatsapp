export const CALL_STRATEGIES = ["message_first", "call_only"] as const;
export type CallStrategy = (typeof CALL_STRATEGIES)[number];
export const CALL_OUTCOMES = ["answered", "no_answer", "callback", "no_interest", "wrong_number"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const CALL_STRATEGY_LABELS: Record<CallStrategy, string> = {
  message_first: "Mensagem antes e depois ligar",
  call_only: "Ligar direto",
};
export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  answered: "Atendeu", no_answer: "Não atendeu", callback: "Pediu retorno", no_interest: "Sem interesse", wrong_number: "Número errado",
};

/**
 * Etapas em que o lead já recebeu proposta/simulação/condições (ou foi além). Contam como "proposta/visita" no relatório de ligações.
 * Fora: interest_received, qualification, compatible_letter_search, documentation, awaiting_simulation, bank_analysis, financing_rejected
 * (ainda não há proposta ao cliente ou o negócio recuou).
 */
export const ADVANCED_FUNNEL_STAGES: readonly string[] = [
  "proposal_sent", "negotiation", "formalization",
  "simulation_sent", "decision_negotiation", "membership",
  "conditions_approved_negotiation",
  "plan_term_presented", "decision_objections",
  "analysis_transfer",
];

/** Divisão estável 50/50 pelo último dígito hexadecimal do id: par → mensagem antes, ímpar → ligar direto. */
export function suggestCallStrategy(opportunityId: string): CallStrategy {
  const last = opportunityId.trim().slice(-1);
  if (!/^[0-9a-fA-F]$/.test(last)) return "message_first";
  return parseInt(last, 16) % 2 === 0 ? "message_first" : "call_only";
}

export interface CallLogRow { opportunityId: string; repUserId: string; strategy: CallStrategy; outcome: CallOutcome }
export interface CallReportOpportunity { status: string; stage: string; reachedAdvanced: boolean }
export interface CallGroupStats {
  calls: number; answered: number; answeredRate: number; leads: number;
  leadsWithProposalOrVisit: number; proposalOrVisitRate: number; won: number; wonRate: number; noInterest: number;
}
export interface CallReport {
  byStrategy: Record<CallStrategy, CallGroupStats>;
  byRep: { repUserId: string; total: CallGroupStats; byStrategy: Record<CallStrategy, CallGroupStats> }[];
}

function stats(rows: CallLogRow[], opps: Record<string, CallReportOpportunity>): CallGroupStats {
  const leadIds = new Set(rows.map(r => r.opportunityId));
  const calls = rows.length;
  const answered = rows.filter(r => r.outcome === "answered").length;
  let withProposal = 0, won = 0;
  for (const id of leadIds) {
    const o = opps[id];
    if (!o) continue;
    if (o.reachedAdvanced || ADVANCED_FUNNEL_STAGES.includes(o.stage) || o.status === "won") withProposal++;
    if (o.status === "won") won++;
  }
  const leads = leadIds.size;
  return {
    calls, answered, answeredRate: calls ? answered / calls : 0, leads,
    leadsWithProposalOrVisit: withProposal, proposalOrVisitRate: leads ? withProposal / leads : 0,
    won, wonRate: leads ? won / leads : 0,
    noInterest: rows.filter(r => r.outcome === "no_interest").length,
  };
}

const split = (rows: CallLogRow[], opps: Record<string, CallReportOpportunity>): Record<CallStrategy, CallGroupStats> => ({
  message_first: stats(rows.filter(r => r.strategy === "message_first"), opps),
  call_only: stats(rows.filter(r => r.strategy === "call_only"), opps),
});

export function buildCallReport(calls: CallLogRow[], opps: Record<string, CallReportOpportunity>): CallReport {
  const reps = [...new Set(calls.map(c => c.repUserId))];
  return {
    byStrategy: split(calls, opps),
    byRep: reps.map(repUserId => {
      const mine = calls.filter(c => c.repUserId === repUserId);
      return { repUserId, total: stats(mine, opps), byStrategy: split(mine, opps) };
    }),
  };
}
