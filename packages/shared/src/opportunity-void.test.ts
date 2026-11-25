// Negócio anulado fica fora de todos os indicadores comerciais (decisão do dono 25/11).
import { describe, expect, it } from "vitest";
import { buildCallReport } from "./call-log.js";
import { aggregateProposalMetrics } from "./proposal-metrics.js";
import { OPPORTUNITY_STATUSES, OPPORTUNITY_STATUS_LABELS, isCountableOpportunity } from "./index.js";
import { resolveBusinessCalendar } from "./business-calendar.js";

const CAL = resolveBusinessCalendar(undefined);

describe("negócio anulado nos indicadores", () => {
  it("status próprio com rótulo; só aberto/ganho/perdido contam", () => {
    expect(OPPORTUNITY_STATUSES).toContain("void");
    expect(OPPORTUNITY_STATUS_LABELS.void).toBe("Anulado");
    expect(["open", "won", "lost", "void"].map(isCountableOpportunity)).toEqual([true, true, true, false]);
  });

  it("relatório de ligações: ligação de negócio anulado não entra em ligações, leads nem ganhos", () => {
    const calls = [
      { opportunityId: "ok", repUserId: "marcio", strategy: "message_first", outcome: "answered" },
      { opportunityId: "anulado", repUserId: "marcio", strategy: "message_first", outcome: "answered" },
    ] as any;
    const r = buildCallReport(calls, { ok: { status: "open", stage: "qualification", reachedAdvanced: false }, anulado: { status: "void", stage: "interest_received", reachedAdvanced: false } });
    expect(r.byStrategy.message_first).toMatchObject({ calls: 1, leads: 1, won: 0 });
    expect(r.byRep[0].total).toMatchObject({ calls: 1, leads: 1 });
  });

  it("propostas: proposta de negócio anulado não entra no total nem na conversão (mesmo se já tinha resultado 'won')", () => {
    const rows = [
      { ownerUserId: "marcio", sentAt: "2026-11-18T13:00:00Z", firstSellerFollowupAt: null, firstCustomerReplyAt: null, outcome: "won", opportunityStatus: "void" },
      { ownerUserId: "marcio", sentAt: "2026-11-18T13:00:00Z", firstSellerFollowupAt: null, firstCustomerReplyAt: null, outcome: null, opportunityStatus: "open" },
    ] as any;
    const m = aggregateProposalMetrics(rows, CAL, { marcio: "Márcio" });
    expect(m.total).toMatchObject({ proposals: 1, won: 0, conversion: 0 });
    expect(m.sellers[0]).toMatchObject({ name: "Márcio", proposals: 1, won: 0 });
  });
});
