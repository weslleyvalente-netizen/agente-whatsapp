import { describe, expect, it } from "vitest";
import { ADVANCED_FUNNEL_STAGES, buildCallReport, suggestCallStrategy } from "./call-log.js";

describe("suggestCallStrategy", () => {
  it("último dígito hexadecimal par → message_first, ímpar → call_only", () => {
    expect(suggestCallStrategy("aaaaaaaa-0000-0000-0000-000000000000")).toBe("message_first");
    expect(suggestCallStrategy("aaaaaaaa-0000-0000-0000-000000000001")).toBe("call_only");
    expect(suggestCallStrategy("aaaaaaaa-0000-0000-0000-00000000000e")).toBe("message_first");
    expect(suggestCallStrategy("aaaaaaaa-0000-0000-0000-00000000000F")).toBe("call_only");
  });
  it("é determinística", () => {
    const id = "3f2a9c1e-1111-2222-3333-444455556667";
    expect(suggestCallStrategy(id)).toBe(suggestCallStrategy(id));
  });
  it("id sem dígito hexadecimal no fim cai em message_first", () => {
    expect(suggestCallStrategy("xyz-")).toBe("message_first");
  });
});

describe("ADVANCED_FUNNEL_STAGES", () => {
  it("só tem etapas que existem no funil e exclui as iniciais", () => {
    expect(ADVANCED_FUNNEL_STAGES).toContain("proposal_sent");
    expect(ADVANCED_FUNNEL_STAGES).not.toContain("interest_received");
    expect(ADVANCED_FUNNEL_STAGES).not.toContain("qualification");
  });
});

describe("buildCallReport", () => {
  const opps = {
    a: { status: "open", stage: "proposal_sent", reachedAdvanced: false },
    b: { status: "won", stage: "formalization", reachedAdvanced: false },
    c: { status: "open", stage: "qualification", reachedAdvanced: false },
    d: { status: "lost", stage: "qualification", reachedAdvanced: true },
  };
  const calls = [
    { opportunityId: "a", repUserId: "u1", strategy: "message_first", outcome: "answered" },
    { opportunityId: "a", repUserId: "u1", strategy: "message_first", outcome: "no_answer" },
    { opportunityId: "b", repUserId: "u1", strategy: "call_only", outcome: "answered" },
    { opportunityId: "c", repUserId: "u2", strategy: "call_only", outcome: "no_interest" },
    { opportunityId: "d", repUserId: "u2", strategy: "message_first", outcome: "callback" },
  ] as const;
  const r = buildCallReport(calls as any, opps as any);
  it("agrega por estratégia", () => {
    expect(r.byStrategy.message_first).toMatchObject({ calls: 3, answered: 1, leads: 2, leadsWithProposalOrVisit: 2, won: 0, noInterest: 0 });
    expect(r.byStrategy.message_first.answeredRate).toBeCloseTo(1 / 3);
    expect(r.byStrategy.call_only).toMatchObject({ calls: 2, answered: 1, leads: 2, leadsWithProposalOrVisit: 1, won: 1, noInterest: 1 });
    expect(r.byStrategy.call_only.wonRate).toBeCloseTo(0.5);
  });
  it("agrega por vendedor com a quebra por estratégia", () => {
    const u1 = r.byRep.find(x => x.repUserId === "u1")!;
    expect(u1.total).toMatchObject({ calls: 3, answered: 2, leads: 2 });
    expect(u1.byStrategy.call_only.calls).toBe(1);
  });
  it("taxas são 0 sem dados", () => {
    expect(buildCallReport([], {}).byStrategy.call_only).toMatchObject({ calls: 0, answeredRate: 0, wonRate: 0 });
  });
});
