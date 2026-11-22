import { describe, expect, it } from "vitest";
import { aggregateProposalMetrics } from "./proposal-metrics.js";
import { DEFAULT_BUSINESS_CALENDAR } from "./business-calendar.js";

const brt = (s: string) => new Date(`${s}-03:00`).toISOString();
const SENT = brt("2026-11-23T10:00:00"); // segunda
const row = (o: Partial<{ ownerUserId: string | null; sentAt: string; firstSellerFollowupAt: string | null; firstCustomerReplyAt: string | null; outcome: string | null }>) =>
  ({ ownerUserId: "marina", sentAt: SENT, firstSellerFollowupAt: null, firstCustomerReplyAt: null, outcome: null, ...o });

describe("aggregateProposalMetrics", () => {
  it("separa por vendedor, conta as faixas (acumuladas) e a conversão; cliente que respondeu antes fica à parte", () => {
    const r = aggregateProposalMetrics([
      row({ firstSellerFollowupAt: brt("2026-11-23T10:20:00"), outcome: "won" }),        // Marina: 20 min
      row({ firstSellerFollowupAt: brt("2026-11-23T15:00:00") }),                         // Marina: mesmo dia (≤ 1 dia útil)
      row({ firstSellerFollowupAt: brt("2026-11-25T11:00:00"), outcome: "lost" }),        // Marina: ~2 dias úteis (≤ 3)
      row({ firstCustomerReplyAt: brt("2026-11-23T10:05:00"), outcome: "won" }),          // Marina: cliente respondeu antes
      row({}),                                                                            // Marina: sem acompanhamento
      row({ ownerUserId: "marcio", firstSellerFollowupAt: brt("2026-11-23T10:31:00") }),  // Márcio: 31 min (> 30)
    ], DEFAULT_BUSINESS_CALENDAR, { marina: "Marina", marcio: "Márcio" });

    const marina = r.sellers.find((s) => s.ownerUserId === "marina")!;
    expect(marina).toMatchObject({ name: "Marina", proposals: 5, customerRepliedFirst: 1, needingFollowup: 4, within30m: 1, within1d: 2, within3d: 3, won: 2, lost: 1 });
    expect(marina.pct30m).toBeCloseTo(0.25);
    expect(marina.conversion).toBeCloseTo(0.4);
    const marcio = r.sellers.find((s) => s.ownerUserId === "marcio")!;
    expect(marcio).toMatchObject({ name: "Márcio", proposals: 1, within30m: 0, within1d: 1 });
    expect(r.total.proposals).toBe(6);
    expect(r.note).toMatch(/correlação/i);
  });
  it("conta minutos úteis: proposta 17:50, retorno 08:15 do dia seguinte = 25 min úteis (dentro de 30 min)", () => {
    const r = aggregateProposalMetrics([row({ sentAt: brt("2026-11-23T17:50:00"), firstSellerFollowupAt: brt("2026-11-24T08:15:00") })], DEFAULT_BUSINESS_CALENDAR, {});
    expect(r.total.within30m).toBe(1);
  });
  it("sem dono vira 'Sem vendedor'; sem propostas não divide por zero", () => {
    const r = aggregateProposalMetrics([row({ ownerUserId: null })], DEFAULT_BUSINESS_CALENDAR, {});
    expect(r.sellers[0].name).toBe("Sem vendedor");
    expect(aggregateProposalMetrics([], DEFAULT_BUSINESS_CALENDAR, {}).total).toMatchObject({ proposals: 0, pct30m: 0, conversion: 0 });
  });
});
