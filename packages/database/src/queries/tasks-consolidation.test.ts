import { describe, it, expect } from "vitest";
import { createTaskWithDedup, resolveAwaitingCustomerPendency } from "./tasks.js";

// A small in-memory fake covering exactly the chains this file's tests need:
// select/eq/in/is/order/limit (awaitable directly, array result), single(),
// maybeSingle(), insert().select().single(), update().eq().select().single().
// Broader/more general-purpose than tasks.test.ts's fake (which only covers
// tasks/task_events) because these tests also exercise organizations and
// opportunities — kept in its own file so it doesn't risk the existing,
// already-passing fixture in tasks.test.ts.
type Row = Record<string, unknown>;

function makeFakeClient(seed: { tasks?: Row[]; task_events?: Row[]; organizations?: Row[]; opportunities?: Row[]; beforeUpdate?:()=>void }) {
  const tables: Record<string, Row[]> = {
    tasks: seed.tasks ? [...seed.tasks] : [],
    task_events: seed.task_events ? [...seed.task_events] : [],
    organizations: seed.organizations ? [...seed.organizations] : [],
    opportunities: seed.opportunities ? [...seed.opportunities] : [],
  };
  let nextId = 1;

  function table(name: string) {
    const rows = tables[name];
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row | undefined;

    const resolveMatches = () => rows.filter((row) => filters.every((f) => f(row)));

    const builder: any = {
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
        filters.push((row) => (row[col] ?? null) === val);
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
        const hook=seed.beforeUpdate;seed.beforeUpdate=undefined;hook?.();
        mode = "update";
        payload = changes;
        return builder;
      },
      async maybeSingle() {
        const matches = resolveMatches();
        matches.sort((a, b) => ((a.created_at as string) < (b.created_at as string) ? 1 : -1));
        return { data: matches[0] ?? null, error: null };
      },
      async single() {
        if (mode === "insert") {
          const newRow: Row = {
            id: `${name}-${nextId++}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: null,
            ...payload,
          };
          rows.push(newRow);
          return { data: newRow, error: null };
        }
        if (mode === "update") {
          const idx = rows.findIndex((row) => filters.every((f) => f(row)));
          if (idx === -1) return { data: null, error: { message: "not found",code:"PGRST116" } };
          rows[idx] = { ...rows[idx], ...payload };
          return { data: rows[idx], error: null };
        }
        const matches = resolveMatches();
        if (matches.length === 0) return { data: null, error: { message: "not found",code:"PGRST116" } };
        return { data: matches[0], error: null };
      },
      // Supports `await builder` directly for a plain select (array result),
      // e.g. getOpenOpportunitiesByContact.
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        resolve({ data: resolveMatches(), error: null });
      },
    };
    return builder;
  }

  const from = (name: string) => table(name);
  return { client: { from } as any, tables };
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

function org(overrides: Row = {}): Row {
  return { id: "org-1", name: "Org", slug: "org", plan: "pro", settings: {}, ...overrides };
}

describe("createTaskWithDedup — auto-link (item 1a)", () => {
  it("does not auto-link when the flag is off, even with exactly one open opportunity", async () => {
    const { client, tables } = makeFakeClient({
      organizations: [org({ settings: { task_auto_link_opportunity_enabled: false } })],
      opportunities: [{ id: "opp-1", organization_id: "org-1", contact_id: "contact-1", status: "open" }],
    });
    const { task } = await createTaskWithDedup(client, baseInput);
    expect(task.opportunity_id ?? null).toBeNull();
    expect(tables.task_events.some((e) => e.event_type === "opportunity_auto_linked")).toBe(false);
  });

  it("auto-links when the flag is on and the contact has exactly one open opportunity", async () => {
    const { client, tables } = makeFakeClient({
      organizations: [org({ settings: { task_auto_link_opportunity_enabled: true } })],
      opportunities: [{ id: "opp-1", organization_id: "org-1", contact_id: "contact-1", status: "open" }],
    });
    const { task } = await createTaskWithDedup(client, baseInput);
    expect(task.opportunity_id).toBe("opp-1");
    expect(tables.task_events.some((e) => e.event_type === "opportunity_auto_linked")).toBe(true);
  });

  it("does not auto-link when the contact has zero open opportunities", async () => {
    const { client } = makeFakeClient({
      organizations: [org({ settings: { task_auto_link_opportunity_enabled: true } })],
      opportunities: [],
    });
    const { task } = await createTaskWithDedup(client, baseInput);
    expect(task.opportunity_id ?? null).toBeNull();
  });

  it("does not auto-link when the contact has more than one open opportunity — ambiguous", async () => {
    const { client } = makeFakeClient({
      organizations: [org({ settings: { task_auto_link_opportunity_enabled: true } })],
      opportunities: [
        { id: "opp-1", organization_id: "org-1", contact_id: "contact-1", status: "open" },
        { id: "opp-2", organization_id: "org-1", contact_id: "contact-1", status: "open" },
      ],
    });
    const { task } = await createTaskWithDedup(client, baseInput);
    expect(task.opportunity_id ?? null).toBeNull();
  });

  it("never overrides an explicitly-passed opportunity_id", async () => {
    const { client } = makeFakeClient({
      organizations: [org({ settings: { task_auto_link_opportunity_enabled: true } })],
      opportunities: [{ id: "opp-other", organization_id: "org-1", contact_id: "contact-1", status: "open" }],
    });
    const { task } = await createTaskWithDedup(client, { ...baseInput, opportunity_id: "opp-explicit" });
    expect(task.opportunity_id).toBe("opp-explicit");
  });
});

describe("createTaskWithDedup — consolidation by opportunity (item 2)", () => {
  it("keeps today's per-type dedup when the flag is off, even with an opportunity linked", async () => {
    const existingTask: Row = {
      id: "task-1",
      organization_id: "org-1",
      contact_id: "contact-1",
      conversation_id: null,
      opportunity_id: "opp-1",
      assignee_type: null,
      assignee_id: null,
      type: "financing_followup",
      title: "Follow-up de financiamento",
      description: "old",
      ai_summary: null,
      reason: "old reason",
      priority: "normal",
      status: "pending",
      due_date: "2026-09-20",
      due_time: null,
      created_by_type: "ai",
      created_by_id: null,
      completed_at: null,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
      consolidated_pendencies: [],
    };
    const { client, tables } = makeFakeClient({
      tasks: [existingTask],
      organizations: [org({ settings: { task_consolidation_by_opportunity_enabled: false } })],
    });

    // Different type (request_documents), same opportunity — with the flag
    // off this must NOT merge into the existing financing_followup task.
    const { task, wasUpdated } = await createTaskWithDedup(client, {
      ...baseInput,
      type: "request_documents",
      opportunity_id: "opp-1",
    });

    expect(wasUpdated).toBe(false);
    expect(tables.tasks).toHaveLength(2);
    expect(task.type).toBe("request_documents");
  });

  it("merges a different-type pendency into the existing open task when the flag is on", async () => {
    const existingTask: Row = {
      id: "task-1",
      organization_id: "org-1",
      contact_id: "contact-1",
      conversation_id: null,
      opportunity_id: "opp-1",
      assignee_type: null,
      assignee_id: null,
      type: "financing_followup",
      title: "Follow-up de financiamento",
      description: "Retornar com resultado da simulação.",
      ai_summary: null,
      reason: "aguardando banco",
      priority: "normal",
      status: "pending",
      due_date: "2026-10-01",
      due_time: null,
      created_by_type: "ai",
      created_by_id: null,
      completed_at: null,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
      consolidated_pendencies: [],
    };
    const { client, tables } = makeFakeClient({
      tasks: [existingTask],
      organizations: [org({ settings: { task_consolidation_by_opportunity_enabled: true } })],
    });

    const { task, wasUpdated } = await createTaskWithDedup(client, {
      ...baseInput,
      type: "awaiting_customer_cpf",
      priority: "urgent",
      description: "Aguardando CPF do cliente.",
      reason: null,
      due_date: "2026-09-26",
      opportunity_id: "opp-1",
    });

    expect(wasUpdated).toBe(true);
    expect(tables.tasks).toHaveLength(1); // no new task created — merged
    // Higher-priority pendency (urgent CPF) becomes the visible primary.
    expect(task.type).toBe("awaiting_customer_cpf");
    expect(task.priority).toBe("urgent");
    // Soonest due_date across both open pendencies.
    expect(task.due_date).toBe("2026-09-26");
    expect(task.consolidated_pendencies).toHaveLength(2);
    expect(tables.task_events.some((e) => e.event_type === "consolidated_pendency_added")).toBe(true);
  });

  it("keeps the higher-priority pendency as primary even when a lower-priority one arrives later", async () => {
    const existingTask: Row = {
      id: "task-1",
      organization_id: "org-1",
      contact_id: "contact-1",
      conversation_id: null,
      opportunity_id: "opp-1",
      assignee_type: null,
      assignee_id: null,
      type: "awaiting_customer_cpf",
      title: "Cliente ficou de enviar CPF",
      description: "Aguardando CPF do cliente.",
      ai_summary: null,
      reason: null,
      priority: "urgent",
      status: "pending",
      due_date: "2026-09-26",
      due_time: null,
      created_by_type: "ai",
      created_by_id: null,
      completed_at: null,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
      consolidated_pendencies: [],
    };
    const { client } = makeFakeClient({
      tasks: [existingTask],
      organizations: [org({ settings: { task_consolidation_by_opportunity_enabled: true } })],
    });

    const { task } = await createTaskWithDedup(client, {
      ...baseInput,
      type: "customer_unresponsive",
      priority: "low",
      opportunity_id: "opp-1",
    });

    // Still shows the CPF pendency — a low-priority arrival must not bury it.
    expect(task.type).toBe("awaiting_customer_cpf");
    expect(task.priority).toBe("urgent");
  });
});

describe("resolveAwaitingCustomerPendency", () => {
  it("removes just the matching pendency and keeps the task open when others remain", async () => {
    const task: Row = {
      id: "task-1",
      organization_id: "org-1",
      contact_id: "contact-1",
      conversation_id: null,
      opportunity_id: "opp-1",
      assignee_type: null,
      assignee_id: null,
      type: "awaiting_customer_cpf",
      title: "Cliente ficou de enviar CPF",
      description: "Aguardando CPF do cliente.",
      ai_summary: null,
      reason: null,
      priority: "urgent",
      status: "pending",
      due_date: "2026-09-26",
      due_time: null,
      created_by_type: "ai",
      created_by_id: null,
      completed_at: null,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
      consolidated_pendencies: [
        {
          type: "awaiting_customer_cpf",
          description: "Aguardando CPF do cliente.",
          reason: null,
          priority: "urgent",
          due_date: "2026-09-26",
          due_time: null,
          added_at: "2026-09-20T00:00:00Z",
          added_by_type: "ai",
          added_by_id: null,
        },
        {
          type: "financing_followup",
          description: "Retornar com resultado da simulação.",
          reason: "aguardando banco",
          priority: "normal",
          due_date: "2026-10-01",
          due_time: null,
          added_at: "2026-09-21T00:00:00Z",
          added_by_type: "ai",
          added_by_id: null,
        },
      ],
    };
    const { client, tables } = makeFakeClient({ tasks: [task] });

    const result = await resolveAwaitingCustomerPendency(
      client,
      "org-1",
      "task-1",
      "awaiting_customer_cpf",
      "Cliente enviou o CPF."
    );

    expect(result.taskCompleted).toBe(false);
    const updated = tables.tasks.find((t) => t.id === "task-1")!;
    expect(updated.status).toBe("pending");
    expect(updated.type).toBe("financing_followup");
    expect((updated.consolidated_pendencies as Row[]).map((p) => p.type)).toEqual(["financing_followup"]);
    expect(tables.task_events.some((e) => e.event_type === "consolidated_pendency_resolved")).toBe(true);
  });

  it("completes the task outright when it was the only pendency", async () => {
    const task: Row = {
      id: "task-1",
      organization_id: "org-1",
      contact_id: "contact-1",
      conversation_id: null,
      opportunity_id: null,
      assignee_type: null,
      assignee_id: null,
      type: "awaiting_customer_cpf",
      title: "Cliente ficou de enviar CPF",
      description: "Aguardando CPF do cliente.",
      ai_summary: null,
      reason: null,
      priority: "urgent",
      status: "pending",
      due_date: "2026-09-26",
      due_time: null,
      created_by_type: "ai",
      created_by_id: null,
      completed_at: null,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
      consolidated_pendencies: [],
    };
    const { client, tables } = makeFakeClient({ tasks: [task] });

    const result = await resolveAwaitingCustomerPendency(
      client,
      "org-1",
      "task-1",
      "awaiting_customer_cpf",
      "Cliente enviou o CPF."
    );

    expect(result.taskCompleted).toBe(true);
    const updated = tables.tasks.find((t) => t.id === "task-1")!;
    expect(updated.status).toBe("completed");
    expect(tables.task_events.some((e) => e.event_type === "completed")).toBe(true);
  });
});

it("preserva retorno que chega durante dedup com consolidação desligada",async()=>{
 const row:Row={id:"task",organization_id:"org-1",contact_id:"contact-1",opportunity_id:"opp",type:"awaiting_customer_cpf",status:"pending",description:"CPF",priority:"urgent",due_date:"2026-09-01",created_at:"2026-09-01",updated_at:"old",consolidated_pendencies:[]};
 const callback={type:"scheduled_callback",description:"Retornar",priority:"normal",due_date:"2026-11-01",added_at:"2026-10-01",added_by_type:"human",added_by_id:null,reason:null,due_time:null,freeze_opportunity_id:"opp"};
 const {client,tables}=makeFakeClient({tasks:[row],organizations:[org()],beforeUpdate:()=>{row.updated_at="new";row.consolidated_pendencies=[{...callback,type:"awaiting_customer_cpf",freeze_opportunity_id:undefined,description:"CPF",priority:"urgent"},callback]}});
 await createTaskWithDedup(client,{...baseInput,opportunity_id:"opp",type:"awaiting_customer_cpf"});
 expect((tables.tasks[0].consolidated_pendencies as Row[]).some(p=>p.freeze_opportunity_id==="opp")).toBe(true);
});
