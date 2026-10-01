import type { TaskPendency } from "./types/task.js";
import type { TaskPriority, TaskType } from "./types/task.js";
import { TASK_TYPE_LABELS } from "./constants.js";

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

// Adds a new pendency to the list, or — if the same type is already
// present — replaces that entry in place instead of duplicating it. Mirrors
// the dedup-by-type behavior createTaskWithDedup already has for
// non-consolidated tasks, just applied within the list.
export function upsertPendency(pendencies: TaskPendency[], next: TaskPendency): TaskPendency[] {
  if(pendencies.some(p=>p.type===next.type && p.freeze_opportunity_id))return [...pendencies];
  const withoutType = pendencies.filter((p) => p.type !== next.type);
  return [...withoutType, next];
}

export function removePendencyByType(pendencies: TaskPendency[], type: TaskType): TaskPendency[] {
  return pendencies.filter((p) => p.type !== type);
}

// The pendency a consolidated task's own type/title/description/priority
// should mirror: highest priority first, then soonest due_date, then
// earliest added_at — never "most recently added", so a low-priority
// pendency arriving later can't bury a still-open awaiting_customer_cpf.
export function pickPrimaryPendency(pendencies: TaskPendency[]): TaskPendency | null {
  if (pendencies.length === 0) return null;
  return [...pendencies].sort((a, b) => {
    const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (rankDiff !== 0) return rankDiff;
    if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
    return a.added_at < b.added_at ? -1 : a.added_at > b.added_at ? 1 : 0;
  })[0];
}

// The task's own due_date always tracks the soonest pendency, not just the
// primary one's — so the task surfaces itself as soon as ANY part of it is
// due, even if that part isn't the highest-priority one.
export function earliestDueDate(pendencies: TaskPendency[]): string | null {
  if (pendencies.length === 0) return null;
  return pendencies.reduce((earliest, p) => (p.due_date < earliest ? p.due_date : earliest), pendencies[0].due_date);
}

export function buildConsolidatedDescription(pendencies: TaskPendency[]): string {
  const primary = pickPrimaryPendency(pendencies);
  if (!primary) return "";
  const rest = pendencies.filter((p) => p !== primary);
  if (rest.length === 0) return primary.description;

  const restList = rest.map((p) => `${TASK_TYPE_LABELS[p.type]} (${p.description})`).join("; ");
  return `${primary.description} Também em aberto: ${restList}.`;
}
