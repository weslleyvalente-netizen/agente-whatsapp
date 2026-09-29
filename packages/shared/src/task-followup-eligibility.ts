import type { TaskType } from "./types/task.js";

// Task types whose next step is the customer replying — eligible for the
// "send follow-up from the task" feature. Left out on purpose: run_quote /
// update_quote (internal actions, no message to the customer) and "other"
// (too ambiguous to assume it's customer-facing).
export const TASK_FOLLOWUP_ELIGIBLE_TYPES: readonly TaskType[] = [
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
];

const ELIGIBLE_SET = new Set<TaskType>(TASK_FOLLOWUP_ELIGIBLE_TYPES);

export function isTaskFollowupEligible(type: TaskType): boolean {
  return ELIGIBLE_SET.has(type);
}

// decideFollowupGate (the "waiting_on = scheduled_date not yet due" gate)
// already lives in task-helpers.js and is exported from the package index —
// callers combine isTaskFollowupEligible(task.type) with that.
