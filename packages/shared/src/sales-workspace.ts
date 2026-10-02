export interface SalesCardInput {
 openOpportunityCount: number;
 handoff: { motivo: string | null; resumo: string | null; first_human_reply_at: string | null } | null;
 latestRole: string | null;
 taskCount: number;
}
export function classifySalesCard(input: SalesCardInput) {
 const humanPending = !!input.handoff && !input.handoff.first_human_reply_at;
 return {
  readyForHuman: humanPending && input.openOpportunityCount === 1,
  humanPending,
  hot: humanPending && ["proposta_pronta", "negociacao_valor"].includes(input.handoff?.motivo ?? ""),
  customerReplied: input.latestRole === "contact",
  taskCount: input.taskCount,
 };
}
export function sortNewestSalesCards<T extends { created_at: string; id: string }>(rows: T[]): T[] {
 return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
}
export type SalesCardState = ReturnType<typeof classifySalesCard> & { handoffSummary: string | null; handedAt: string | null; tasks?: Array<{id:string;type:string;due_date:string;priority:string;consolidated_pendencies?:Array<{type:string;due_date:string;priority:string}>}> };
