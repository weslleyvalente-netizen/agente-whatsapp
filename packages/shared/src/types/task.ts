import { TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES } from "../constants.js";

export type TaskType = (typeof TASK_TYPES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskCreatedByType = "ai" | "human";
export type TaskAssigneeType = "human" | "ai";

export interface Task {
  /** Derived display field; never stored on tasks. */
  opportunity_frozen_until?: string | null;
  id: string;
  organization_id: string;
  contact_id: string;
  conversation_id: string | null;
  opportunity_id: string | null;
  assignee_type: TaskAssigneeType | null;
  assignee_id: string | null;
  type: TaskType;
  title: string;
  description: string;
  ai_summary: string | null;
  reason: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  due_date: string;
  due_time: string | null;
  created_by_type: TaskCreatedByType;
  created_by_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  consolidated_pendencies: TaskPendency[];
  // Follow-up-from-task (see task-followup-eligibility.ts /
  // task-followup-throttle.ts): the AI-suggested message, kept on the task
  // so opening it again doesn't regenerate for free, and how many times
  // "Gerar outra" has been used against this task's configured cap.
  followup_suggested_message: string | null;
  followup_suggestion_generated_at: string | null;
  followup_regeneration_count: number;
  // Points to a `messages` row while a follow-up send is in flight/
  // unconfirmed (see task-followup.service.ts's confirmation flow, point 2).
  followup_pending_message_id: string | null;
}

// One pending item folded into a consolidated task (Fase 2, item 2) — a
// task's own type/title/description/priority/due_date always mirror the
// highest-priority entry here (see task-consolidation.ts); this array is
// the source of truth once consolidation is on, so a pendency resolved
// individually (e.g. awaiting_customer_cpf, item 3) can leave the task
// open with whatever else is still pending, instead of closing it outright.
export interface TaskPendency {
  freeze_opportunity_id?: string;
  type: TaskType;
  description: string;
  reason: string | null;
  priority: TaskPriority;
  due_date: string;
  due_time: string | null;
  added_at: string;
  added_by_type: TaskCreatedByType;
  added_by_id: string | null;
}

export type TaskEventType =
  | "created"
  | "updated"
  | "rescheduled"
  | "completed"
  | "cancelled"
  | "assigned"
  | "auto_followup_stage_1"
  | "auto_followup_stage_2"
  | "opportunity_auto_linked"
  | "consolidated_pendency_added"
  | "consolidated_pendency_resolved"
  | "libera_cred_resumption_created"
  | "libera_cred_resumption_escalated"
  | "libera_cred_resumption_suggest_lost"
  | "followup_sent";

export interface TaskEvent {
  id: string;
  task_id: string;
  organization_id: string;
  event_type: TaskEventType;
  note: string | null;
  created_by_type: TaskCreatedByType;
  created_by_id: string | null;
  created_at: string;
}
