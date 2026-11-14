import { describe, expect, it } from "vitest";
import { createTaskWithDedup, resolveUnresponsiveTasksOnReply } from "./tasks.js";
import { completeNudgeTasksOnSellerMessage, listNudgeTasksByConversation, listOpenNudgeTasks, nudgeTouchNote, recordNudgeTouch } from "./customer-nudge.js";

// "Cutucar cliente" dentro das tarefas consolidadas por negócio: o cutucar é UMA pendência da lista, nunca uma tarefa paralela.
type Row = Record<string, any>;

function makeFakeClient(seed: { tasks?: Row[]; task_events?: Row[]; organizations?: Row[] }) {
  const tables: Record<string, Row[]> = { tasks: [...(seed.tasks ?? [])], task_events: [...(seed.task_events ?? [])], organizations: [...(seed.organizations ?? [])], opportunities: [], conversation_qualifications: [] };
  let nextId = 1;
  const contains = (have: unknown, want: unknown[]) => Array.isArray(have) && want.every((w) => have.some((h) => Object.entries(w as Row).every(([k, v]) => (h as Row)[k] === v)));
  function table(name: string) {
    const rows = tables[name];
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row | undefined; let slice: [number, number] | null = null;
    const matches = () => { const m = rows.filter((r) => filters.every((f) => f(r))); return slice ? m.slice(slice[0], slice[1] + 1) : m; };
    const b: any = {
      select: () => b,
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      like(c: string, pattern: string) { const needle = pattern.replace(/%/g, ""); filters.push((r) => String(r[c] ?? "").includes(needle)); return b; },
      filter(c: string, op: string, v: string) { if (op !== "cs") throw new Error("op"); const want = JSON.parse(v); filters.push((r) => contains(r[c], want)); return b; },
      order: () => b, limit: () => b,
      range(from: number, to: number) { slice = [from, to]; return b; },
      insert(row: Row) { mode = "insert"; payload = row; return b; },
      update(changes: Row) { mode = "update"; payload = changes; return b; },
      async maybeSingle() { const m = matches().sort((x, y) => (x.created_at < y.created_at ? 1 : -1)); return { data: m[0] ?? null, error: null }; },
      async single() {
        if (mode === "insert") { const row = { id: `${name}-${nextId++}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null, ...payload }; rows.push(row); return { data: row, error: null }; }
        if (mode === "update") { const i = rows.findIndex((r) => filters.every((f) => f(r))); if (i < 0) return { data: null, error: { message: "nf", code: "PGRST116" } }; rows[i] = { ...rows[i], ...payload }; return { data: rows[i], error: null }; }
        const m = matches(); return m.length ? { data: m[0], error: null } : { data: null, error: { message: "nf", code: "PGRST116" } };
      },
      then(resolve: (v: any) => void) {
        if (mode === "insert") { rows.push({ id: `${name}-${nextId++}`, created_at: new Date().toISOString(), ...payload }); return resolve({ data: null, error: null }); }
        resolve({ data: matches(), error: null });
      },
    };
    return b;
  }
  return { client: { from: (n: string) => table(n) } as any, tables };
}

const ORG = "org-1";
const consolidatedOrg = { id: ORG, settings: { task_consolidation_by_opportunity_enabled: true } };
const pend = (type: string, over: Row = {}) => ({ type, description: `desc ${type}`, reason: `motivo ${type}`, priority: "normal", due_date: "2026-11-16", due_time: null, added_at: "2026-11-13T19:02:36.000Z", added_by_type: "ai", added_by_id: null, ...over });
const task = (over: Row = {}): Row => ({
  id: "t1", organization_id: ORG, contact_id: "ct1", conversation_id: "conv1", opportunity_id: "op1", assignee_type: "human", assignee_id: "marina", type: "return_customer", title: "x",
  description: "Atender cliente qualificado", reason: "handoff", priority: "high", status: "pending", due_date: "2026-11-13", due_time: null, created_by_type: "ai", created_by_id: null,
  completed_at: null, created_at: "2026-11-13T19:02:36.552Z", updated_at: "2026-11-13T19:02:36.552Z", consolidated_pendencies: [pend("return_customer", { priority: "high", due_date: "2026-11-13" })], ...over,
});
const nudgeInput = (over: Row = {}) => ({
  organization_id: ORG, contact_id: "ct1", conversation_id: "conv1", opportunity_id: "op1", type: "customer_nudge" as const, description: "Cliente parou de responder há 1 dia útil.", reason: "Sem resposta há 1 dia útil.",
  priority: "normal" as const, due_date: "2026-11-16", created_by_type: "ai" as const, created_by_id: null, assignee_type: "human" as const, assignee_id: "marcio", assign_on_merge: true, ...over,
});

describe("cutucar agrupado na tarefa consolidada do negócio", () => {
  it("entra como pendência da tarefa aberta (sem tarefa paralela), preserva a pendência existente e leva o responsável para o dono atual", async () => {
    const { client, tables } = makeFakeClient({ tasks: [task()], organizations: [consolidatedOrg] });
    const r = await createTaskWithDedup(client, nudgeInput());
    expect(tables.tasks).toHaveLength(1);
    expect(r).toMatchObject({ wasUpdated: true, pendencyAdded: true });
    const t = tables.tasks[0];
    expect(t.consolidated_pendencies.map((p: Row) => p.type).sort()).toEqual(["customer_nudge", "return_customer"]);
    const original = t.consolidated_pendencies.find((p: Row) => p.type === "return_customer");
    expect(original).toMatchObject({ priority: "high", due_date: "2026-11-13", reason: "motivo return_customer" });
    const added = t.consolidated_pendencies.find((p: Row) => p.type === "customer_nudge");
    expect(added).toMatchObject({ due_date: "2026-11-16", reason: "Sem resposta há 1 dia útil.", added_by_type: "ai" });
    expect(t).toMatchObject({ type: "return_customer", assignee_type: "human", assignee_id: "marcio", due_date: "2026-11-13" });
    expect(tables.task_events.map((e) => e.event_type)).toEqual(["consolidated_pendency_added", "assigned"]);
  });
  it("sem assign_on_merge o responsável da tarefa não muda", async () => {
    const { client, tables } = makeFakeClient({ tasks: [task()], organizations: [consolidatedOrg] });
    await createTaskWithDedup(client, nudgeInput({ assign_on_merge: undefined }));
    expect(tables.tasks[0].assignee_id).toBe("marina"); expect(tables.task_events.some((e) => e.event_type === "assigned")).toBe(false);
  });
  it("mesmo responsável: nenhum evento de reatribuição", async () => {
    const { client, tables } = makeFakeClient({ tasks: [task()], organizations: [consolidatedOrg] });
    await createTaskWithDedup(client, nudgeInput({ assignee_id: "marina" }));
    expect(tables.task_events.some((e) => e.event_type === "assigned")).toBe(false);
  });
  it("deduplicação: o mesmo cutucar de novo só atualiza a pendência (pendencyAdded=false), nunca cria outra tarefa nem outra pendência", async () => {
    const { client, tables } = makeFakeClient({ tasks: [task({ consolidated_pendencies: [pend("return_customer"), pend("customer_nudge")] })], organizations: [consolidatedOrg] });
    const r = await createTaskWithDedup(client, nudgeInput());
    expect(tables.tasks).toHaveLength(1); expect(r.pendencyAdded).toBe(false);
    expect(tables.tasks[0].consolidated_pendencies.filter((p: Row) => p.type === "customer_nudge")).toHaveLength(1);
  });
  it("sem tarefa aberta no negócio: cria a tarefa (wasUpdated=false) com o cutucar como única pendência", async () => {
    const { client, tables } = makeFakeClient({ organizations: [consolidatedOrg] });
    const r = await createTaskWithDedup(client, nudgeInput());
    expect(r.wasUpdated).toBe(false); expect(tables.tasks).toHaveLength(1);
    expect(tables.tasks[0]).toMatchObject({ type: "customer_nudge", assignee_id: "marcio", assignee_type: "human", opportunity_id: "op1" });
    expect(tables.tasks[0].consolidated_pendencies).toHaveLength(1);
  });
  it("não mexe em tarefa de OUTRO negócio nem em tarefa já concluída", async () => {
    const other = task({ id: "t2", opportunity_id: "op2" }); const done = task({ id: "t3", status: "completed" });
    const { client, tables } = makeFakeClient({ tasks: [other, done], organizations: [consolidatedOrg] });
    await createTaskWithDedup(client, nudgeInput());
    expect(tables.tasks).toHaveLength(3);
    expect(tables.tasks.find((t) => t.id === "t2")!.consolidated_pendencies).toHaveLength(1);
    expect(tables.tasks.find((t) => t.id === "t3")!.consolidated_pendencies).toHaveLength(1);
  });
});

describe("resposta do cliente encerra só a pendência de retorno correspondente", () => {
  const reply = (over: Row = {}) => ({ organizationId: ORG, contactId: "ct1", conversationId: "conv1", role: "contact", createdAt: "2026-11-16T15:00:00.000Z", messageId: "m9", ...over });
  it("tira o cutucar da lista e mantém a obrigação comercial aberta com seus próprios dados", async () => {
    const t = task({ consolidated_pendencies: [pend("return_customer", { priority: "high", due_date: "2026-11-13" }), pend("customer_nudge", { added_at: "2026-11-16T12:00:00.000Z" })] });
    const { client, tables } = makeFakeClient({ tasks: [t], organizations: [consolidatedOrg] });
    await resolveUnresponsiveTasksOnReply(client, reply());
    expect(tables.tasks[0].status).toBe("pending");
    expect(tables.tasks[0].consolidated_pendencies.map((p: Row) => p.type)).toEqual(["return_customer"]);
    expect(tables.tasks[0]).toMatchObject({ type: "return_customer", priority: "high", due_date: "2026-11-13" });
    expect(tables.task_events.at(-1)).toMatchObject({ event_type: "consolidated_pendency_resolved" });
    expect(tables.task_events.at(-1)!.note).toContain("não precisa mais cutucar");
  });
  it("se o cutucar era a única pendência, conclui a tarefa", async () => {
    const t = task({ type: "customer_nudge", consolidated_pendencies: [pend("customer_nudge", { added_at: "2026-11-16T12:00:00.000Z" })] });
    const { client, tables } = makeFakeClient({ tasks: [t], organizations: [consolidatedOrg] });
    await resolveUnresponsiveTasksOnReply(client, reply());
    expect(tables.tasks[0].status).toBe("completed");
  });
  it("resposta ANTERIOR à pendência não a encerra (mensagem atrasada/reordenada)", async () => {
    const t = task({ consolidated_pendencies: [pend("return_customer"), pend("customer_nudge", { added_at: "2026-11-16T16:00:00.000Z" })] });
    const { client, tables } = makeFakeClient({ tasks: [t], organizations: [consolidatedOrg] });
    await resolveUnresponsiveTasksOnReply(client, reply({ createdAt: "2026-11-16T15:00:00.000Z" }));
    expect(tables.tasks[0].consolidated_pendencies).toHaveLength(2);
  });
  it("não encerra tarefas de ação do vendedor (retornar cliente, cobrar documentos) quando o cliente responde", async () => {
    const t = task({ consolidated_pendencies: [pend("return_customer"), pend("request_documents")] });
    const { client, tables } = makeFakeClient({ tasks: [t], organizations: [consolidatedOrg] });
    await resolveUnresponsiveTasksOnReply(client, reply());
    expect(tables.tasks[0].consolidated_pendencies).toHaveLength(2); expect(tables.tasks[0].status).toBe("pending");
  });
  it("ignora tarefas de outra conversa e mensagens que não são do cliente", async () => {
    const t = task({ conversation_id: "conv2", consolidated_pendencies: [pend("customer_nudge", { added_at: "2026-11-16T12:00:00.000Z" })], type: "customer_nudge" });
    const { client, tables } = makeFakeClient({ tasks: [t], organizations: [consolidatedOrg] });
    await resolveUnresponsiveTasksOnReply(client, reply());
    await resolveUnresponsiveTasksOnReply(client, reply({ conversationId: "conv2", role: "human_agent" }));
    expect(tables.tasks[0].status).toBe("pending");
  });
});

describe("consultas do cutucar na tarefa consolidada", () => {
  it("listOpenNudgeTasks enxerga tarefa do tipo customer_nudge E pendência dentro de tarefa consolidada, ignora concluídas, e devolve quando a PENDÊNCIA entrou", async () => {
    const typed = task({ id: "a", type: "customer_nudge", consolidated_pendencies: [], created_at: "2026-11-10T10:00:00.000Z" });
    const grouped = task({ id: "b", consolidated_pendencies: [pend("return_customer"), pend("customer_nudge", { added_at: "2026-11-16T12:00:00.000Z" })] });
    const done = task({ id: "c", status: "completed", consolidated_pendencies: [pend("customer_nudge")] });
    const plain = task({ id: "d" });
    const { client } = makeFakeClient({ tasks: [typed, grouped, done, plain] });
    const out = await listOpenNudgeTasks(client, ORG);
    expect(out.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(out.find((t) => t.id === "b")!.createdAt).toBe("2026-11-16T12:00:00.000Z");
    expect(out.find((t) => t.id === "a")!.createdAt).toBe("2026-11-10T10:00:00.000Z");
  });
  it("toques: eventos (sobrevivem à pendência sair da lista) + tarefas legadas sem evento, sem contar duas vezes", async () => {
    const legacy = task({ id: "L", type: "customer_nudge", conversation_id: "conv1", consolidated_pendencies: [], status: "completed", created_at: "2026-11-01T10:00:00.000Z", completed_at: "2026-11-01T12:00:00.000Z" });
    const both = task({ id: "B", type: "customer_nudge", conversation_id: "conv1", consolidated_pendencies: [], created_at: "2026-11-05T10:00:00.000Z" });
    const events = [
      { task_id: "B", organization_id: ORG, event_type: "customer_nudge_touch", note: nudgeTouchNote("conv1", 2), created_at: "2026-11-05T10:00:01.000Z" },
      { task_id: "X", organization_id: ORG, event_type: "customer_nudge_touch", note: nudgeTouchNote("conv1", 3), created_at: "2026-11-09T10:00:00.000Z" },
      { task_id: "Y", organization_id: ORG, event_type: "customer_nudge_touch", note: nudgeTouchNote("outra", 1), created_at: "2026-11-09T10:00:00.000Z" },
    ];
    const { client } = makeFakeClient({ tasks: [legacy, both], task_events: events });
    const touches = await listNudgeTasksByConversation(client, ORG, "conv1");
    expect(touches).toHaveLength(3);
    expect(touches.map((t) => t.createdAt).sort()).toEqual(["2026-11-01T10:00:00.000Z", "2026-11-05T10:00:01.000Z", "2026-11-09T10:00:00.000Z"]);
  });
  it("evento de tarefa que ainda é do tipo customer_nudge herda status e conclusão dela (intervalo entre toques e 'aberto' como antes)", async () => {
    const typed = task({ id: "T", type: "customer_nudge", conversation_id: "conv1", consolidated_pendencies: [], status: "completed", created_at: "2026-11-05T10:00:00.000Z", completed_at: "2026-11-05T12:00:00.000Z" });
    const ev = [{ task_id: "T", organization_id: ORG, event_type: "customer_nudge_touch", note: nudgeTouchNote("conv1", 1), created_at: "2026-11-05T10:00:01.000Z" }];
    const { client } = makeFakeClient({ tasks: [typed], task_events: ev });
    expect(await listNudgeTasksByConversation(client, ORG, "conv1")).toEqual([{ id: "T#0", status: "completed", createdAt: "2026-11-05T10:00:01.000Z", completedAt: "2026-11-05T12:00:00.000Z" }]);
  });
  it("recordNudgeTouch grava o evento ligado à conversa", async () => {
    const { client, tables } = makeFakeClient({});
    await recordNudgeTouch(client, ORG, "t9", "conv1", 2);
    expect(tables.task_events[0]).toMatchObject({ task_id: "t9", event_type: "customer_nudge_touch", note: nudgeTouchNote("conv1", 2) });
  });
});

describe("vendedor falou: encerra só o cutucar, preservando as outras obrigações", () => {
  const at = "2026-11-16T15:00:00.000Z";
  it("remove a pendência de cutucar criada antes da mensagem e mantém a tarefa aberta", async () => {
    const t = task({ consolidated_pendencies: [pend("return_customer"), pend("request_documents"), pend("customer_nudge", { added_at: "2026-11-16T12:00:00.000Z" })] });
    const { client, tables } = makeFakeClient({ tasks: [t], organizations: [consolidatedOrg] });
    await completeNudgeTasksOnSellerMessage(client, ORG, "conv1", at);
    expect(tables.tasks[0].status).toBe("pending");
    expect(tables.tasks[0].consolidated_pendencies.map((p: Row) => p.type).sort()).toEqual(["request_documents", "return_customer"]);
  });
  it("pendência criada DEPOIS da mensagem do vendedor fica (a mensagem não a cobriu)", async () => {
    const t = task({ consolidated_pendencies: [pend("return_customer"), pend("customer_nudge", { added_at: "2026-11-16T16:00:00.000Z" })] });
    const { client, tables } = makeFakeClient({ tasks: [t], organizations: [consolidatedOrg] });
    await completeNudgeTasksOnSellerMessage(client, ORG, "conv1", at);
    expect(tables.tasks[0].consolidated_pendencies).toHaveLength(2);
  });
  it("tarefa legada do tipo customer_nudge é concluída como antes", async () => {
    const t = task({ type: "customer_nudge", consolidated_pendencies: [], created_at: "2026-11-16T12:00:00.000Z" });
    const { client, tables } = makeFakeClient({ tasks: [t], organizations: [consolidatedOrg] });
    await completeNudgeTasksOnSellerMessage(client, ORG, "conv1", at);
    expect(tables.tasks[0].status).toBe("completed");
  });
  it("outra conversa não é afetada", async () => {
    const t = task({ conversation_id: "conv2", consolidated_pendencies: [pend("customer_nudge", { added_at: "2026-11-16T12:00:00.000Z" })], type: "customer_nudge" });
    const { client, tables } = makeFakeClient({ tasks: [t], organizations: [consolidatedOrg] });
    expect(await completeNudgeTasksOnSellerMessage(client, ORG, "conv1", at)).toBe(0);
    expect(tables.tasks[0].status).toBe("pending");
  });
});
