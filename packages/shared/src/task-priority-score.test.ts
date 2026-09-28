import { describe, expect, it } from "vitest";
import {
  computeTaskPriorityScore,
  DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS,
  type TaskPriorityScoreInput,
} from "./task-priority-score.js";

// waitingOn defaults to null in every case below — null scores the same as
// "customer" (+5, see computeTaskPriorityScore's waiting_on branch): a task
// with no linked opportunity, or one explicitly waiting on the customer, is
// equally "ready to act on now", not blocked on anything. Every expectation
// here carries that +5 baseline unless the test overrides waitingOn itself.
function baseInput(overrides: Partial<TaskPriorityScoreInput> = {}): TaskPriorityScoreInput {
  return {
    priority: "normal",
    dueDateBucket: "upcoming",
    opportunityValue: null,
    stagePosition: null,
    stageCount: null,
    daysStalled: null,
    waitingOn: null,
    waitingOnUntil: null,
    qualificationUrgency: null,
    hasUnansweredHandoff: false,
    todayISODate: "2026-09-28",
    ...overrides,
  };
}

const WAITING_ON_NULL_BASELINE = 5;

describe("computeTaskPriorityScore", () => {
  it("scores a bare-minimum task at just the waiting_on=null baseline", () => {
    expect(computeTaskPriorityScore(baseInput())).toBe(WAITING_ON_NULL_BASELINE);
  });

  it("weighs task priority", () => {
    expect(computeTaskPriorityScore(baseInput({ priority: "urgent" }))).toBe(20 + WAITING_ON_NULL_BASELINE);
    expect(computeTaskPriorityScore(baseInput({ priority: "high" }))).toBe(10 + WAITING_ON_NULL_BASELINE);
    expect(computeTaskPriorityScore(baseInput({ priority: "low" }))).toBe(-5 + WAITING_ON_NULL_BASELINE);
  });

  it("weighs due date bucket", () => {
    expect(computeTaskPriorityScore(baseInput({ dueDateBucket: "overdue" }))).toBe(15 + WAITING_ON_NULL_BASELINE);
    expect(computeTaskPriorityScore(baseInput({ dueDateBucket: "today" }))).toBe(8 + WAITING_ON_NULL_BASELINE);
  });

  it("scales opportunity value up to the cap", () => {
    expect(computeTaskPriorityScore(baseInput({ opportunityValue: 25_000 }))).toBe(10 + WAITING_ON_NULL_BASELINE);
    expect(computeTaskPriorityScore(baseInput({ opportunityValue: 50_000 }))).toBe(20 + WAITING_ON_NULL_BASELINE);
    expect(computeTaskPriorityScore(baseInput({ opportunityValue: 200_000 }))).toBe(20 + WAITING_ON_NULL_BASELINE);
  });

  it("scales funnel stage position", () => {
    // 5-stage funnel (positions 0-4): position 2 = halfway = 7.5 points
    expect(computeTaskPriorityScore(baseInput({ stagePosition: 2, stageCount: 5 }))).toBe(
      7.5 + WAITING_ON_NULL_BASELINE
    );
    expect(computeTaskPriorityScore(baseInput({ stagePosition: 4, stageCount: 5 }))).toBe(
      15 + WAITING_ON_NULL_BASELINE
    );
    expect(computeTaskPriorityScore(baseInput({ stagePosition: 0, stageCount: 5 }))).toBe(WAITING_ON_NULL_BASELINE);
  });

  it("ignores stage when stageCount is missing or degenerate", () => {
    expect(computeTaskPriorityScore(baseInput({ stagePosition: 2, stageCount: null }))).toBe(
      WAITING_ON_NULL_BASELINE
    );
    expect(computeTaskPriorityScore(baseInput({ stagePosition: 0, stageCount: 1 }))).toBe(WAITING_ON_NULL_BASELINE);
  });

  it("scales days stalled up to the cap", () => {
    expect(computeTaskPriorityScore(baseInput({ daysStalled: 15 }))).toBe(10 + WAITING_ON_NULL_BASELINE);
    expect(computeTaskPriorityScore(baseInput({ daysStalled: 30 }))).toBe(20 + WAITING_ON_NULL_BASELINE);
    expect(computeTaskPriorityScore(baseInput({ daysStalled: 90 }))).toBe(20 + WAITING_ON_NULL_BASELINE);
  });

  it("weighs waiting_on customer the same as null", () => {
    expect(computeTaskPriorityScore(baseInput({ waitingOn: "customer" }))).toBe(WAITING_ON_NULL_BASELINE);
    expect(computeTaskPriorityScore(baseInput({ waitingOn: null }))).toBe(WAITING_ON_NULL_BASELINE);
  });

  it("weighs waiting_on team/bank_or_admin higher — it's our own pendency to chase", () => {
    expect(computeTaskPriorityScore(baseInput({ waitingOn: "team" }))).toBe(15);
    expect(computeTaskPriorityScore(baseInput({ waitingOn: "bank_or_admin" }))).toBe(15);
  });

  it("suppresses a scheduled_date pendency that hasn't arrived yet", () => {
    const score = computeTaskPriorityScore(
      baseInput({ waitingOn: "scheduled_date", waitingOnUntil: "2026-10-05", todayISODate: "2026-09-28" })
    );
    expect(score).toBe(-15);
  });

  it("surfaces a scheduled_date pendency once its date has arrived", () => {
    const score = computeTaskPriorityScore(
      baseInput({ waitingOn: "scheduled_date", waitingOnUntil: "2026-09-20", todayISODate: "2026-09-28" })
    );
    expect(score).toBe(15);
  });

  it("weighs qualification urgency", () => {
    expect(computeTaskPriorityScore(baseInput({ qualificationUrgency: "immediate" }))).toBe(
      15 + WAITING_ON_NULL_BASELINE
    );
    expect(computeTaskPriorityScore(baseInput({ qualificationUrgency: "this_week" }))).toBe(
      8 + WAITING_ON_NULL_BASELINE
    );
    expect(computeTaskPriorityScore(baseInput({ qualificationUrgency: "flexible" }))).toBe(WAITING_ON_NULL_BASELINE);
  });

  it("gives a strong bump for an unanswered handoff on the task's conversation", () => {
    expect(computeTaskPriorityScore(baseInput({ hasUnansweredHandoff: true }))).toBe(25 + WAITING_ON_NULL_BASELINE);
  });

  it("sums every component for a fully-loaded task", () => {
    const score = computeTaskPriorityScore(
      baseInput({
        priority: "urgent",
        dueDateBucket: "overdue",
        opportunityValue: 50_000,
        stagePosition: 4,
        stageCount: 5,
        daysStalled: 30,
        waitingOn: "team",
        qualificationUrgency: "immediate",
        hasUnansweredHandoff: true,
      })
    );
    expect(score).toBe(20 + 15 + 20 + 15 + 20 + 15 + 15 + 25);
  });

  it("respects an explicit weights override without mutating the default", () => {
    const custom = { ...DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS, handoffUnanswered: 100 };
    expect(computeTaskPriorityScore(baseInput({ hasUnansweredHandoff: true }), custom)).toBe(
      100 + WAITING_ON_NULL_BASELINE
    );
    expect(computeTaskPriorityScore(baseInput({ hasUnansweredHandoff: true }))).toBe(25 + WAITING_ON_NULL_BASELINE);
  });
});
