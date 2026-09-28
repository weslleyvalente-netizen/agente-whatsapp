import type { TaskPriority } from "./types/task.js";
import type { WaitingOn } from "./types/opportunity.js";
import type { QualificationUrgency } from "./types/conversation-qualification.js";

export type DueDateScoreBucket = "overdue" | "today" | "upcoming";

export interface TaskPriorityScoreInput {
  priority: TaskPriority;
  dueDateBucket: DueDateScoreBucket;
  // max(credit_amount, sale_amount, bid_amount) of the linked opportunity, or
  // null when the task has none.
  opportunityValue: number | null;
  // Index of the opportunity's stage within its funnel (0 = first stage), or
  // null when there's no linked opportunity.
  stagePosition: number | null;
  stageCount: number | null;
  // Days since the linked opportunity's last_progress_at (fallback
  // last_interaction_at/created_at), or null when there's no opportunity.
  daysStalled: number | null;
  waitingOn: WaitingOn | null;
  waitingOnUntil: string | null;
  qualificationUrgency: QualificationUrgency | null;
  hasUnansweredHandoff: boolean;
  // Only used to resolve a scheduled_date waitingOn against waitingOnUntil.
  todayISODate: string;
}

export interface TaskPriorityScoreWeights {
  priority: Record<TaskPriority, number>;
  dueDateBucket: Record<DueDateScoreBucket, number>;
  opportunityValueMaxPoints: number;
  opportunityValueCapAmount: number;
  stageMaxPoints: number;
  daysStalledMaxPoints: number;
  daysStalledCapDays: number;
  waitingOnCustomerOrNull: number;
  waitingOnInternal: number;
  waitingOnScheduledFuture: number;
  waitingOnScheduledDue: number;
  qualificationUrgency: Record<QualificationUrgency, number>;
  handoffUnanswered: number;
}

// Starting weights — validated with real diagnostico-fase0.md data but meant
// to be tuned from here, not re-derived from the formula, once a week or two
// of real usage of the "Hoje" view shows what actually needs bumping.
export const DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS: TaskPriorityScoreWeights = {
  priority: { urgent: 20, high: 10, normal: 0, low: -5 },
  dueDateBucket: { overdue: 15, today: 8, upcoming: 0 },
  opportunityValueMaxPoints: 20,
  opportunityValueCapAmount: 50_000,
  stageMaxPoints: 15,
  daysStalledMaxPoints: 20,
  daysStalledCapDays: 30,
  waitingOnCustomerOrNull: 5,
  waitingOnInternal: 15,
  waitingOnScheduledFuture: -15,
  waitingOnScheduledDue: 15,
  qualificationUrgency: { immediate: 15, this_week: 8, flexible: 0 },
  handoffUnanswered: 25,
};

function scoreOpportunityValue(value: number | null, weights: TaskPriorityScoreWeights): number {
  if (value === null) return 0;
  const ratio = Math.min(value / weights.opportunityValueCapAmount, 1);
  return ratio * weights.opportunityValueMaxPoints;
}

function scoreStage(position: number | null, count: number | null, weights: TaskPriorityScoreWeights): number {
  if (position === null || count === null || count <= 1) return 0;
  const ratio = position / (count - 1);
  return ratio * weights.stageMaxPoints;
}

function scoreDaysStalled(days: number | null, weights: TaskPriorityScoreWeights): number {
  if (days === null) return 0;
  const ratio = Math.min(days, weights.daysStalledCapDays) / weights.daysStalledCapDays;
  return ratio * weights.daysStalledMaxPoints;
}

function scoreWaitingOn(
  waitingOn: WaitingOn | null,
  waitingOnUntil: string | null,
  todayISODate: string,
  weights: TaskPriorityScoreWeights
): number {
  if (waitingOn === null || waitingOn === "customer") return weights.waitingOnCustomerOrNull;
  if (waitingOn === "team" || waitingOn === "bank_or_admin") return weights.waitingOnInternal;
  // scheduled_date
  if (waitingOnUntil && waitingOnUntil > todayISODate) return weights.waitingOnScheduledFuture;
  return weights.waitingOnScheduledDue;
}

export function computeTaskPriorityScore(
  input: TaskPriorityScoreInput,
  weights: TaskPriorityScoreWeights = DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS
): number {
  return (
    weights.priority[input.priority] +
    weights.dueDateBucket[input.dueDateBucket] +
    scoreOpportunityValue(input.opportunityValue, weights) +
    scoreStage(input.stagePosition, input.stageCount, weights) +
    scoreDaysStalled(input.daysStalled, weights) +
    scoreWaitingOn(input.waitingOn, input.waitingOnUntil, input.todayISODate, weights) +
    (input.qualificationUrgency ? weights.qualificationUrgency[input.qualificationUrgency] : 0) +
    (input.hasUnansweredHandoff ? weights.handoffUnanswered : 0)
  );
}
