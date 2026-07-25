import { TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES } from "../constants.js";

export type TaskType = (typeof TASK_TYPES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskCreatedByType = "ai" | "human";
export type TaskAssigneeType = "human" | "ai";

export interface Task {
  id: string;
  organization_id: string;
  contact_id: string;
  conversation_id: string | null;
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
}

export type TaskEventType = "created" | "updated" | "rescheduled" | "completed" | "cancelled" | "assigned";

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
