import { describe, it, expect } from "vitest";
import {
  isOpportunitySignalType,
  isHotLead,
  resolveTaskBucket,
  resolveTaskDedupAction,
  sortTasksForToday,
  computeTaskSummary,
  type SortableTask,
} from "./task-helpers.js";

describe("isOpportunitySignalType", () => {
  it("treats 'other' and 'customer_unresponsive' as not a real signal", () => {
    expect(isOpportunitySignalType("other")).toBe(false);
    expect(isOpportunitySignalType("customer_unresponsive")).toBe(false);
  });

  it("treats every other type as a real opportunity signal", () => {
    expect(isOpportunitySignalType("proposal_followup")).toBe(true);
    expect(isOpportunitySignalType("awaiting_customer_cpf")).toBe(true);
  });
});

describe("isHotLead", () => {
  it("is true for an open task with a signal type", () => {
    expect(isHotLead({ type: "proposal_followup", status: "pending" })).toBe(true);
  });

  it("is false for a signal type that is already completed", () => {
    expect(isHotLead({ type: "proposal_followup", status: "completed" })).toBe(false);
  });

  it("is false for a non-signal type even if open", () => {
    expect(isHotLead({ type: "other", status: "pending" })).toBe(false);
  });
});

describe("resolveTaskBucket", () => {
  it("buckets a completed task as done regardless of due_date", () => {
    expect(resolveTaskBucket({ due_date: "2026-01-01", status: "completed" }, "2026-07-24")).toBe("done");
  });

  it("buckets a cancelled task as done regardless of due_date", () => {
    expect(resolveTaskBucket({ due_date: "2026-12-31", status: "cancelled" }, "2026-07-24")).toBe("done");
  });

  it("buckets a past due_date as overdue when still open", () => {
    expect(resolveTaskBucket({ due_date: "2026-07-23", status: "pending" }, "2026-07-24")).toBe("overdue");
  });

  it("buckets today's due_date as today", () => {
    expect(resolveTaskBucket({ due_date: "2026-07-24", status: "pending" }, "2026-07-24")).toBe("today");
  });

  it("buckets a future due_date as upcoming, including rescheduled tasks", () => {
    expect(resolveTaskBucket({ due_date: "2026-07-26", status: "rescheduled" }, "2026-07-24")).toBe("upcoming");
  });
});

describe("resolveTaskDedupAction", () => {
  it("creates when there is no existing open task", () => {
    expect(resolveTaskDedupAction(null, { due_date: "2026-07-26", description: "x", reason: null })).toEqual({
      action: "create",
    });
  });

  it("updates the existing task's due_date/description/reason instead of creating a new one", () => {
    const result = resolveTaskDedupAction(
      { id: "task-1" },
      { due_date: "2026-07-27", description: "novo texto", reason: "novo motivo" }
    );
    expect(result).toEqual({
      action: "update",
      taskId: "task-1",
      changes: { due_date: "2026-07-27", description: "novo texto", reason: "novo motivo" },
    });
  });
});

describe("sortTasksForToday", () => {
  const base: SortableTask = {
    id: "",
    type: "other",
    status: "pending",
    due_time: null,
    priority: "normal",
    lastMessageAt: null,
  };

  it("puts hot leads before everything else", () => {
    const tasks: SortableTask[] = [
      { ...base, id: "cold", type: "other" },
      { ...base, id: "hot", type: "proposal_followup" },
    ];
    expect(sortTasksForToday(tasks, Date.now()).map((t) => t.id)).toEqual(["hot", "cold"]);
  });

  it("within the same group, sorts by due_time ascending, nulls last", () => {
    const tasks: SortableTask[] = [
      { ...base, id: "no-time", due_time: null },
      { ...base, id: "late", due_time: "15:00" },
      { ...base, id: "early", due_time: "09:00" },
    ];
    expect(sortTasksForToday(tasks, Date.now()).map((t) => t.id)).toEqual(["early", "late", "no-time"]);
  });

  it("breaks remaining ties by longest time waiting since the last customer message", () => {
    const now = new Date("2026-07-24T12:00:00.000Z").getTime();
    const tasks: SortableTask[] = [
      { ...base, id: "recent", lastMessageAt: "2026-07-24T11:00:00.000Z" },
      { ...base, id: "stale", lastMessageAt: "2026-07-23T11:00:00.000Z" },
    ];
    expect(sortTasksForToday(tasks, now).map((t) => t.id)).toEqual(["stale", "recent"]);
  });

  it("finally breaks ties by priority, most urgent first", () => {
    const tasks: SortableTask[] = [
      { ...base, id: "low", priority: "low" },
      { ...base, id: "urgent", priority: "urgent" },
      { ...base, id: "normal", priority: "normal" },
    ];
    expect(sortTasksForToday(tasks, Date.now()).map((t) => t.id)).toEqual(["urgent", "normal", "low"]);
  });
});

describe("computeTaskSummary", () => {
  it("counts today, overdue, completed-today, and open hot leads independently", () => {
    const tasks = [
      { type: "other" as const, status: "pending" as const, due_date: "2026-07-24", completed_at: null },
      { type: "other" as const, status: "pending" as const, due_date: "2026-07-20", completed_at: null },
      { type: "proposal_followup" as const, status: "pending" as const, due_date: "2026-07-24", completed_at: null },
      {
        type: "other" as const,
        status: "completed" as const,
        due_date: "2026-07-10",
        completed_at: "2026-07-24T10:00:00.000Z",
      },
      {
        type: "other" as const,
        status: "completed" as const,
        due_date: "2026-07-10",
        completed_at: "2026-07-01T10:00:00.000Z",
      },
    ];
    expect(computeTaskSummary(tasks, "2026-07-24")).toEqual({
      today: 2,
      overdue: 1,
      completedToday: 1,
      hotOpenLeads: 1,
    });
  });
});
