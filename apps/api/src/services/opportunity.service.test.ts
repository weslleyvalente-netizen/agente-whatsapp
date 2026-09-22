import { describe, it, expect, vi, beforeEach } from "vitest";

const { createOpportunity, updateOpportunity, addOpportunityEvent } = vi.hoisted(() => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  addOpportunityEvent: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ createOpportunity, updateOpportunity, addOpportunityEvent }));

import { changeStage, changeOperation, markWon, markLost } from "./opportunity.service.js";

const baseOpportunity = {
  id: "opp-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  operation: "vehicle_sale" as const,
  stage: "qualification",
  status: "open" as const,
  product: "car" as const,
  product_model: null,
  initial_operation: "vehicle_sale" as const,
  sale_amount: null,
  credit_amount: null,
  down_payment_amount: null,
  bid_amount: null,
  target_installment_amount: null,
  term_months: null,
  usage_purpose: null,
  urgency: null,
  main_objection: null,
  commercial_notes: null,
  owner_id: null,
  next_action: null,
  next_action_due_date: null,
  waiting_on: null,
  waiting_on_until: null,
  last_interaction_at: null,
  last_progress_at: null,
  lost_reason: null,
  resume_date: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

// Mirrors the `db.from("opportunities").select("*").eq("id", id).single()`
// lookup that changeStage/changeOperation/markWon/markLost each issue
// directly against the Supabase client before delegating the actual
// mutation to updateOpportunity/addOpportunityEvent — see
// integrations/crm-sync.test.ts for the same from()-chain mocking style.
function makeDb(opportunity: typeof baseOpportunity) {
  const from = vi.fn((table: string) => {
    if (table !== "opportunities") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: opportunity, error: null }),
        }),
      }),
    };
  });
  return { from } as any;
}

const actor = { type: "human" as const, id: "user-1" };

describe("changeStage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws and does not persist anything when newStage is not part of the opportunity's funnel", async () => {
    const db = makeDb(baseOpportunity);

    await expect(
      changeStage(db, "opp-1", "not_a_real_stage", "cliente confirmou por telefone", actor)
    ).rejects.toThrow(/não existe no funil/);

    expect(updateOpportunity).not.toHaveBeenCalled();
    expect(addOpportunityEvent).not.toHaveBeenCalled();
  });

  it("updates the stage and logs a stage_changed event carrying the given evidence", async () => {
    const db = makeDb(baseOpportunity);
    updateOpportunity.mockResolvedValue({ ...baseOpportunity, stage: "proposal_sent" });

    const result = await changeStage(db, "opp-1", "proposal_sent", "cliente confirmou por telefone", actor);

    expect(updateOpportunity).toHaveBeenCalledWith(
      db,
      "opp-1",
      expect.objectContaining({ stage: "proposal_sent" })
    );
    expect(addOpportunityEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        opportunity_id: "opp-1",
        organization_id: "org-1",
        event_type: "stage_changed",
        previous_value: { stage: "qualification" },
        new_value: { stage: "proposal_sent" },
        evidence: "cliente confirmou por telefone",
        changed_by_type: "human",
        changed_by_id: "user-1",
      })
    );
    expect(result).toEqual({ ...baseOpportunity, stage: "proposal_sent" });
  });
});

describe("changeOperation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("resets stage to the new operation's first funnel stage instead of keeping the old stage value", async () => {
    // baseOpportunity is mid-funnel on vehicle_sale ("qualification"); its
    // stage name isn't even valid in the consortium funnel, so silently
    // keeping it would be a real correctness bug, not just cosmetic.
    const db = makeDb({ ...baseOpportunity, operation: "vehicle_sale", stage: "negotiation" });
    updateOpportunity.mockResolvedValue({
      ...baseOpportunity,
      operation: "consortium",
      stage: "interest_received",
    });

    await changeOperation(db, "opp-1", "consortium", "cliente decidiu mudar para consórcio", actor);

    expect(updateOpportunity).toHaveBeenCalledWith(
      db,
      "opp-1",
      expect.objectContaining({ operation: "consortium", stage: "interest_received" })
    );
    expect(addOpportunityEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        event_type: "operation_changed",
        previous_value: { operation: "vehicle_sale", stage: "negotiation" },
        new_value: { operation: "consortium", stage: "interest_received" },
        evidence: "cliente decidiu mudar para consórcio",
      })
    );
  });
});

describe("markWon", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sets status to won and logs a won event with the given evidence", async () => {
    const db = makeDb(baseOpportunity);
    updateOpportunity.mockResolvedValue({ ...baseOpportunity, status: "won" });

    const result = await markWon(db, "opp-1", "contrato assinado", actor);

    expect(updateOpportunity).toHaveBeenCalledWith(db, "opp-1", expect.objectContaining({ status: "won" }));
    expect(addOpportunityEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        event_type: "won",
        previous_value: { status: "open" },
        new_value: { status: "won" },
        evidence: "contrato assinado",
      })
    );
    expect(result).toEqual({ ...baseOpportunity, status: "won" });
  });
});

describe("markLost", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sets status to lost and logs a lost event carrying lost_reason and resume_date in new_value", async () => {
    const db = makeDb(baseOpportunity);
    updateOpportunity.mockResolvedValue({
      ...baseOpportunity,
      status: "lost",
      lost_reason: "preço muito alto",
      resume_date: "2026-12-01",
    });

    const result = await markLost(db, "opp-1", "cliente disse que achou caro", "preço muito alto", "2026-12-01", actor);

    expect(updateOpportunity).toHaveBeenCalledWith(
      db,
      "opp-1",
      expect.objectContaining({
        status: "lost",
        lost_reason: "preço muito alto",
        resume_date: "2026-12-01",
      })
    );
    expect(addOpportunityEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        event_type: "lost",
        previous_value: { status: "open" },
        new_value: { status: "lost", lost_reason: "preço muito alto", resume_date: "2026-12-01" },
        evidence: "cliente disse que achou caro",
      })
    );
    expect(result.status).toBe("lost");
  });
});
