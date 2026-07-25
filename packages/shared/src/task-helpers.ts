import type { TaskType, TaskStatus, TaskPriority } from "./types/task.js";
import { OPPORTUNITY_SIGNAL_TASK_TYPES } from "./constants.js";

const OPEN_TASK_STATUSES: TaskStatus[] = ["pending", "in_progress", "rescheduled"];
const DONE_TASK_STATUSES: TaskStatus[] = ["completed", "cancelled"];

export function isOpportunitySignalType(type: TaskType): boolean {
  return (OPPORTUNITY_SIGNAL_TASK_TYPES as TaskType[]).includes(type);
}

export function isHotLead(task: { type: TaskType; status: TaskStatus }): boolean {
  return isOpportunitySignalType(task.type) && OPEN_TASK_STATUSES.includes(task.status);
}

export type TaskBucket = "overdue" | "today" | "upcoming" | "done";

export function resolveTaskBucket(
  task: { due_date: string; status: TaskStatus },
  todayISODate: string
): TaskBucket {
  if (DONE_TASK_STATUSES.includes(task.status)) return "done";
  if (task.due_date < todayISODate) return "overdue";
  if (task.due_date === todayISODate) return "today";
  return "upcoming";
}

export type TaskDedupAction =
  | { action: "create" }
  | { action: "update"; taskId: string; changes: { due_date: string; description: string; reason: string | null } };

export function resolveTaskDedupAction(
  existing: { id: string } | null,
  input: { due_date: string; description: string; reason: string | null }
): TaskDedupAction {
  if (!existing) return { action: "create" };
  return {
    action: "update",
    taskId: existing.id,
    changes: { due_date: input.due_date, description: input.description, reason: input.reason },
  };
}

export interface SortableTask {
  id: string;
  type: TaskType;
  status: TaskStatus;
  due_time: string | null;
  priority: TaskPriority;
  lastMessageAt: string | null;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function sortTasksForToday<T extends SortableTask>(tasks: T[], nowMs: number): T[] {
  return [...tasks].sort((a, b) => {
    const hotA = isHotLead(a) ? 0 : 1;
    const hotB = isHotLead(b) ? 0 : 1;
    if (hotA !== hotB) return hotA - hotB;

    const timeA = a.due_time ?? "99:99";
    const timeB = b.due_time ?? "99:99";
    if (timeA !== timeB) return timeA < timeB ? -1 : 1;

    const waitA = a.lastMessageAt ? nowMs - new Date(a.lastMessageAt).getTime() : -1;
    const waitB = b.lastMessageAt ? nowMs - new Date(b.lastMessageAt).getTime() : -1;
    if (waitA !== waitB) return waitB - waitA;

    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  });
}

export interface TaskSummaryInput {
  type: TaskType;
  status: TaskStatus;
  due_date: string;
  completed_at: string | null;
}

export interface TaskSummary {
  today: number;
  overdue: number;
  completedToday: number;
  hotOpenLeads: number;
}

export function computeTaskSummary(tasks: TaskSummaryInput[], todayISODate: string): TaskSummary {
  const summary: TaskSummary = { today: 0, overdue: 0, completedToday: 0, hotOpenLeads: 0 };

  for (const task of tasks) {
    const bucket = resolveTaskBucket(task, todayISODate);
    if (bucket === "today") summary.today++;
    if (bucket === "overdue") summary.overdue++;
    if (task.status === "completed" && task.completed_at?.slice(0, 10) === todayISODate) {
      summary.completedToday++;
    }
    if (isHotLead(task) && OPEN_TASK_STATUSES.includes(task.status)) {
      summary.hotOpenLeads++;
    }
  }

  return summary;
}
