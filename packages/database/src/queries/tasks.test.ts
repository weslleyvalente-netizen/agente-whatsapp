import { describe, it, expect } from "vitest";
import { createTaskWithDedup } from "./tasks.js";

// Minimal fake Supabase client covering exactly the `.from("tasks")` /
// `.from("task_events")` chains createTaskWithDedup (and the query helpers it
// calls) issues: select().eq()...maybeSingle(), insert().select().single(),
// and update().eq().select().single(). Modeled after the from()-chain mocking
// style used in apps/api/src/integrations/crm-sync.test.ts and
// apps/api/src/services/opportunity.service.test.ts — but here we exercise
// the real createTaskWithDedup (it lives in this package, so there is no
// @aula-agente/database to mock around it).
type Row = Record<string, unknown>;

function makeFakeClient(initialTasks: Row[]) {
  const tasks: Row[] = [...initialTasks];
  const taskEvents: Row[] = [];
  let nextId = 1;

  function tasksTable() {
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row | undefined;

    const builder = {
      select: () => builder,
      eq(col: string, val: unknown) {
        filters.push((row) => row[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push((row) => vals.includes(row[col]));
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push((row) => row[col] === val);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      insert(row: Row) {
        mode = "insert";
        payload = row;
        return builder;
      },
      update(changes: Row) {
        mode = "update";
        payload = changes;
        return builder;
      },
      async maybeSingle() {
        const matches = tasks.filter((row) => filters.every((f) => f(row)));
        matches.sort((a, b) => ((a.created_at as string) < (b.created_at as string) ? 1 : -1));
        return { data: matches[0] ?? null, error: null };
      },
      async single() {
        if (mode === "insert") {
          const newRow: Row = {
            id: `task-${nextId++}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: null,
            ...payload,
          };
          tasks.push(newRow);
          return { data: newRow, error: null };
        }
        if (mode === "update") {
          const idx = tasks.findIndex((row) => filters.every((f) => f(row)));
          if (idx === -1) return { data: null, error: { message: "not found" } };
          tasks[idx] = { ...tasks[idx], ...payload };
          return { data: tasks[idx], error: null };
        }
        throw new Error("single() called without insert/update");
      },
    };
    return builder;
  }

  function taskEventsTable() {
    return {
      insert(row: Row) {
        const newRow: Row = { id: `event-${nextId++}`, created_at: new Date().toISOString(), ...row };
        taskEvents.push(newRow);
        return {
          select: () => ({
            single: async () => ({ data: newRow, error: null }),
          }),
        };
      },
    };
  }

  const from = (table: string) => {
    if (table === "tasks") return tasksTable();
    if (table === "task_events") return taskEventsTable();
    throw new Error(`unexpected table ${table}`);
  };

  return { client: { from } as any, tasks, taskEvents };
}

const baseInput = {
  organization_id: "org-1",
  contact_id: "contact-1",
  conversation_id: null,
  type: "run_quote" as const,
  description: "nova descrição",
  reason: "novo motivo",
  priority: "normal" as const,
  due_date: "2026-09-25",
  created_by_type: "ai" as const,
  created_by_id: null,
};

describe("createTaskWithDedup", () => {
  // Regression for the overlapping-key-spaces bug: a task already linked to
  // opportunity A must not be matched (and silently overwritten) by a
  // same-contact-and-type call that carries no opportunity_id at all — e.g.
  // Helena's create_task tool or the stale-conversation-followup worker,
  // neither of which passes opportunity_id today.
  it("does not match or overwrite an opportunity-linked open task when the new call has no opportunity_id", async () => {
    const linkedTask: Row = {
      id: "task-linked",
      organization_id: "org-1",
      contact_id: "contact-1",
      conversation_id: null,
      opportunity_id: "opp-1",
      assignee_type: null,
      assignee_id: null,
      type: "run_quote",
      title: "Rodar cotação",
      description: "descrição antiga",
      ai_summary: null,
      reason: "motivo antigo",
      priority: "normal",
      status: "pending",
      due_date: "2026-09-01",
      due_time: null,
      created_by_type: "human",
      created_by_id: "user-1",
      completed_at: null,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
    };
    const { client, tasks } = makeFakeClient([linkedTask]);

    const result = await createTaskWithDedup(client, { ...baseInput, opportunity_id: undefined });

    // Must not have reused/updated the opportunity-linked task.
    expect(result.wasUpdated).toBe(false);
    expect(result.task.id).not.toBe("task-linked");
    expect(result.task.opportunity_id ?? null).toBe(null);

    // The originally linked task must be untouched.
    const stillLinked = tasks.find((t) => t.id === "task-linked")!;
    expect(stillLinked.description).toBe("descrição antiga");
    expect(stillLinked.reason).toBe("motivo antigo");
    expect(stillLinked.opportunity_id).toBe("opp-1");

    // A brand new, unlinked task was created instead.
    expect(tasks).toHaveLength(2);
  });

  // The common case must keep working: dedup against a same-contact,
  // same-type open task that was never linked to any opportunity.
  it("still matches and updates an existing open task with no opportunity_id (unlinked key space)", async () => {
    const unlinkedTask: Row = {
      id: "task-unlinked",
      organization_id: "org-1",
      contact_id: "contact-1",
      conversation_id: null,
      opportunity_id: null,
      assignee_type: null,
      assignee_id: null,
      type: "run_quote",
      title: "Rodar cotação",
      description: "descrição antiga",
      ai_summary: null,
      reason: "motivo antigo",
      priority: "normal",
      status: "pending",
      due_date: "2026-09-01",
      due_time: null,
      created_by_type: "human",
      created_by_id: "user-1",
      completed_at: null,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
    };
    const { client, tasks } = makeFakeClient([unlinkedTask]);

    const result = await createTaskWithDedup(client, { ...baseInput, opportunity_id: undefined });

    expect(result.wasUpdated).toBe(true);
    expect(result.task.id).toBe("task-unlinked");
    expect(result.task.description).toBe("nova descrição");
    expect(result.task.reason).toBe("novo motivo");
    expect(result.task.due_date).toBe("2026-09-25");
    expect(tasks).toHaveLength(1);
  });

  // Opportunity-scoped dedup (the sibling key space) is unaffected by this
  // fix: a call that does carry opportunity_id still matches/updates the
  // task already linked to that same opportunity.
  it("still matches and updates an existing open task for the same opportunity_id", async () => {
    const linkedTask: Row = {
      id: "task-linked",
      organization_id: "org-1",
      contact_id: "contact-1",
      conversation_id: null,
      opportunity_id: "opp-1",
      assignee_type: null,
      assignee_id: null,
      type: "run_quote",
      title: "Rodar cotação",
      description: "descrição antiga",
      ai_summary: null,
      reason: "motivo antigo",
      priority: "normal",
      status: "pending",
      due_date: "2026-09-01",
      due_time: null,
      created_by_type: "human",
      created_by_id: "user-1",
      completed_at: null,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
    };
    const { client, tasks } = makeFakeClient([linkedTask]);

    const result = await createTaskWithDedup(client, { ...baseInput, opportunity_id: "opp-1" });

    expect(result.wasUpdated).toBe(true);
    expect(result.task.id).toBe("task-linked");
    expect(result.task.description).toBe("nova descrição");
    expect(tasks).toHaveLength(1);
  });
});
