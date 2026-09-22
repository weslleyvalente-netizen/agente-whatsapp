import { OPERATIONS, OPPORTUNITY_STATUSES, WAITING_ON_OPTIONS, PRODUCTS } from "../constants.js";

export type Operation = (typeof OPERATIONS)[number];
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
export type WaitingOn = (typeof WAITING_ON_OPTIONS)[number];
export type Product = (typeof PRODUCTS)[number];

export interface Opportunity {
  id: string;
  organization_id: string;
  contact_id: string;
  operation: Operation;
  stage: string;
  status: OpportunityStatus;
  product: Product | null;
  product_model: string | null;
  initial_operation: Operation;
  sale_amount: number | null;
  credit_amount: number | null;
  down_payment_amount: number | null;
  bid_amount: number | null;
  target_installment_amount: number | null;
  term_months: number | null;
  usage_purpose: string | null;
  urgency: string | null;
  main_objection: string | null;
  commercial_notes: string | null;
  owner_id: string | null;
  next_action: string | null;
  next_action_due_date: string | null;
  waiting_on: WaitingOn | null;
  waiting_on_until: string | null;
  last_interaction_at: string | null;
  last_progress_at: string | null;
  lost_reason: string | null;
  resume_date: string | null;
  created_at: string;
  updated_at: string;
}

export type OpportunityEventType =
  | "created"
  | "stage_changed"
  | "operation_changed"
  | "won"
  | "lost"
  | "reopened"
  | "owner_changed"
  | "next_action_updated"
  | "waiting_on_changed";

export type OpportunityEventActorType = "ai" | "human" | "system";

export interface OpportunityEvent {
  id: string;
  organization_id: string;
  opportunity_id: string;
  event_type: OpportunityEventType;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  evidence: string;
  changed_by_type: OpportunityEventActorType;
  changed_by_id: string | null;
  created_at: string;
}
