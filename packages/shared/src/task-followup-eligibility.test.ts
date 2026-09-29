import { describe, it, expect } from "vitest";
import { isTaskFollowupEligible } from "./task-followup-eligibility.js";
import { TASK_TYPES } from "./constants.js";

const ELIGIBLE = [
  "return_customer",
  "request_documents",
  "awaiting_customer_cpf",
  "awaiting_customer_data",
  "awaiting_customer_decision",
  "scheduled_callback",
  "proposal_followup",
  "financing_followup",
  "consortium_followup",
  "vehicle_followup",
  "customer_unresponsive",
  "stalled_negotiation",
  "libera_cred_resumption",
] as const;

const NOT_ELIGIBLE = ["run_quote", "update_quote", "other"] as const;

describe("isTaskFollowupEligible", () => {
  it("covers every TASK_TYPES value exactly once between eligible and not-eligible", () => {
    expect([...ELIGIBLE, ...NOT_ELIGIBLE].sort()).toEqual([...TASK_TYPES].sort());
  });

  for (const type of ELIGIBLE) {
    it(`"${type}" is eligible (customer owns the next reply)`, () => {
      expect(isTaskFollowupEligible(type)).toBe(true);
    });
  }

  for (const type of NOT_ELIGIBLE) {
    it(`"${type}" is NOT eligible (internal pendency)`, () => {
      expect(isTaskFollowupEligible(type)).toBe(false);
    });
  }
});
