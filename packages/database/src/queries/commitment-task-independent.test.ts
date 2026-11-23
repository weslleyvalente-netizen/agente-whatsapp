import { describe, expect, it } from "vitest";
import { COMMITMENT_TASK_REASON } from "@aula-agente/shared";
import { createTaskWithDedup, resolveAwaitingCustomerPendency } from "./tasks.js";
import { createCommitmentTask, resolveCommitmentPendency, taskHasOpenPendency } from "./commitments.js";

// Regressão da simulação de 22/11/2026: a promessa entrava na tarefa consolidada do negócio, virava a pendência principal (prioridade
// alta), trocava título/hora/responsável da tarefa do vendedor e era encerrada quando ele concluía "a tarefa" pensando na obrigação
// original. Agora a tarefa da rotina de compromissos é INDEPENDENTE: não entra em tarefa de outro fluxo e não recebe pendência dele.
type Row = Record<string, any>;

// O fake reproduz o índice único parcial da migração 20261122150000 (uma tarefa ABERTA por conversa e commitment_kind): o insert que
// colidir recebe o mesmo erro do Postgres (23505). `ops` registra a ordem das leituras/gravações para provar a execução intercalada.
const OPEN = ["pending", "in_progress", "rescheduled"];
function makeFakeClient(seed: { tasks?: Row[]; task_events?: Row[]; organizations?: Row[] }) {
  const tables: Record<string, Row[]> = { tasks: [...(seed.tasks ?? [])], task_events: [...(seed.task_events ?? [])], organizations: [...(seed.organizations ?? [])], opportunities: [], conversation_qualifications: [] };
  const ops: string[] = [];
  const violatesCommitmentIndex = (name: string, row: Row) => name === "tasks" && !!row.commitment_kind && OPEN.includes(row.status ?? "pending")
    && tables.tasks.some((t) => t.organization_id === row.organization_id && t.conversation_id === row.conversation_id && t.commitment_kind === row.commitment_kind && OPEN.includes(t.status));
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
        if (name === "tasks") ops.push(mode);
        if (mode === "insert" && violatesCommitmentIndex(name, payload!)) return { data: null, error: { message: "duplicate key value violates unique constraint \"tasks_commitment_open_per_conversation\"", code: "23505" } };
        if (mode === "insert") { const row = { id: `${name}-${nextId++}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null, ...payload }; rows.push(row); return { data: row, error: null }; }
        if (mode === "update") { const i = rows.findIndex((r) => filters.every((f) => f(r))); if (i < 0) return { data: null, error: { message: "nf", code: "PGRST116" } }; rows[i] = { ...rows[i], ...payload }; return { data: rows[i], error: null }; }
        const m = matches(); return m.length ? { data: m[0], error: null } : { data: null, error: { message: "nf", code: "PGRST116" } };
      },
      then(resolve: (v: any) => void) {
        if (name === "tasks") ops.push(mode);
        if (mode === "insert") { rows.push({ id: `${name}-${nextId++}`, created_at: new Date().toISOString(), ...payload }); return resolve({ data: null, error: null }); }
        resolve({ data: matches(), error: null });
      },
    };
    return b;
  }
  return { client: { from: (n: string) => table(n) } as any, tables, ops };
}

const ORG = "org-1";
const consolidatedOrg = { id: ORG, settings: { task_consolidation_by_opportunity_enabled: true, task_auto_link_opportunity_enabled: true } };
const pend = (type: string, over: Row = {}) => ({ type, description: `desc ${type}`, reason: `motivo ${type}`, priority: "normal", due_date: "2026-11-24", due_time: null, added_at: "2026-11-20T12:00:00.000Z", added_by_type: "ai", added_by_id: null, ...over });
const sellerTask = (over: Row = {}): Row => ({
  id: "vend-1", organization_id: ORG, contact_id: "ct1", conversation_id: "conv1", opportunity_id: "op1", assignee_type: "human", assignee_id: "marcio",
  type: "vehicle_followup", title: "Acompanhar veículo", description: "Acompanhar avaliação do veículo", reason: "fluxo do CRM", priority: "normal", status: "pending",
  due_date: "2026-11-24", due_time: "10:00", created_by_type: "ai", created_by_id: null, completed_at: null,
  created_at: "2026-11-20T12:00:00.000Z", updated_at: "2026-11-20T12:00:00.000Z", consolidated_pendencies: [pend("vehicle_followup", { due_time: "10:00" })], ...over,
});
const promise = (over: Row = {}) => ({
  organizationId: ORG, contactId: "ct1", conversationId: "conv1", opportunityId: "op1", ownerId: "marina", type: "return_customer" as const,
  description: 'Retornar ao cliente: você disse "vou verificar" às 09:08. Prazo: segunda, 23/11, às 11:08.',
  priority: "high" as const, dueDate: "2026-11-23", dueTime: "11:08", ...over,
});
const openTasks = (tables: Record<string, Row[]>) => tables.tasks.filter((t) => OPEN.includes(t.status));

describe("promessa de retorno em tarefa independente", () => {
  it("negócio com tarefa consolidada aberta de outro fluxo: cria a tarefa da promessa à parte e NÃO altera a tarefa do vendedor", async () => {
    const before = sellerTask();
    const { client, tables } = makeFakeClient({ tasks: [{ ...before }], organizations: [consolidatedOrg] });
    const { id } = await createCommitmentTask(client, promise());
    expect(id).not.toBe("vend-1");
    expect(tables.tasks.find((t) => t.id === "vend-1")).toEqual(before); // tipo, título, hora, responsável e pendências intactos
    expect(openTasks(tables)).toHaveLength(2);
  });

  it("o prazo individual da promessa fica na própria tarefa (data e hora visíveis ao vendedor) e o responsável é o dono da promessa", async () => {
    const { client, tables } = makeFakeClient({ tasks: [sellerTask()], organizations: [consolidatedOrg] });
    const { id } = await createCommitmentTask(client, promise());
    const t = tables.tasks.find((x) => x.id === id)!;
    expect(t).toMatchObject({ type: "return_customer", due_date: "2026-11-23", due_time: "11:08", priority: "high", assignee_type: "human", assignee_id: "marina",
      reason: COMMITMENT_TASK_REASON.return_customer, commitment_kind: "return_customer", opportunity_id: "op1", conversation_id: "conv1", status: "pending" });
    expect(t.consolidated_pendencies).toEqual([expect.objectContaining({ type: "return_customer", due_date: "2026-11-23", due_time: "11:08" })]);
    expect(t.description).toContain("Prazo: segunda, 23/11, às 11:08");
  });

  it("nova promessa na mesma conversa: reaproveita a tarefa da promessa e troca data e hora (nenhuma tarefa paralela)", async () => {
    const { client, tables } = makeFakeClient({ tasks: [], organizations: [consolidatedOrg] });
    const first = await createCommitmentTask(client, promise());
    const second = await createCommitmentTask(client, promise({ dueDate: "2026-11-24", dueTime: "15:00", description: 'Retornar ao cliente: você disse "às 15h". Prazo: terça, 24/11, às 15:00.' }));
    expect(second.id).toBe(first.id);
    expect(openTasks(tables)).toHaveLength(1);
    expect(tables.tasks[0]).toMatchObject({ due_date: "2026-11-24", due_time: "15:00" });
    expect(tables.tasks[0].consolidated_pendencies).toEqual([expect.objectContaining({ due_date: "2026-11-24", due_time: "15:00" })]);
  });

  it("outro fluxo do CRM (consolidação ligada) NÃO agrupa na tarefa da promessa: abre/usa outra tarefa e a promessa não muda", async () => {
    const { client, tables } = makeFakeClient({ tasks: [], organizations: [consolidatedOrg] });
    const { id } = await createCommitmentTask(client, promise());
    const snapshot = { ...tables.tasks.find((t) => t.id === id)! };
    const other = await createTaskWithDedup(client, { organization_id: ORG, contact_id: "ct1", conversation_id: "conv1", opportunity_id: "op1", type: "customer_nudge",
      description: "Cliente parou de responder.", reason: "Sem resposta.", priority: "normal", due_date: "2026-11-23", created_by_type: "ai", created_by_id: null,
      assignee_type: "human", assignee_id: "marcio", assign_on_merge: true });
    expect(other.task.id).not.toBe(id);
    expect(tables.tasks.find((t) => t.id === id)).toEqual(snapshot);
  });

  it("outro fluxo que cria \"Retornar cliente\" (mesmo tipo, ex.: repasse) também não reaproveita nem reescreve a tarefa da promessa", async () => {
    const off = { id: ORG, settings: { task_consolidation_by_opportunity_enabled: false } };
    for (const opportunity_id of ["op1", null]) {
      const { client, tables } = makeFakeClient({ tasks: [], organizations: [off] });
      const { id } = await createCommitmentTask(client, promise({ opportunityId: opportunity_id }));
      const snapshot = { ...tables.tasks.find((t) => t.id === id)! };
      const handoff = await createTaskWithDedup(client, { organization_id: ORG, contact_id: "ct1", conversation_id: "conv1", opportunity_id, type: "return_customer",
        description: "Atender cliente qualificado", reason: "handoff", priority: "high", due_date: "2026-11-25", created_by_type: "ai", created_by_id: null });
      expect(handoff.task.id).not.toBe(id);
      expect(tables.tasks.find((t) => t.id === id)).toEqual(snapshot);
    }
  });

  it("concluir a pendência de OUTRA tarefa do mesmo negócio não encerra a promessa", async () => {
    const { client, tables } = makeFakeClient({ tasks: [sellerTask()], organizations: [consolidatedOrg] });
    const { id } = await createCommitmentTask(client, promise());
    await resolveAwaitingCustomerPendency(client, ORG, "vend-1", "vehicle_followup", "Concluída pelo vendedor", 0, undefined, { type: "human", id: "marcio" });
    expect(tables.tasks.find((t) => t.id === "vend-1")!.status).toBe("completed");
    expect(await taskHasOpenPendency(client, ORG, id, "return_customer")).toBe(true);
  });

  it("a promessa só se encerra pela conclusão da própria tarefa", async () => {
    const { client, tables } = makeFakeClient({ tasks: [], organizations: [consolidatedOrg] });
    const { id } = await createCommitmentTask(client, promise());
    await resolveCommitmentPendency(client, ORG, id, "return_customer", "Retorno prometido entregue ao cliente.");
    expect(tables.tasks.find((t) => t.id === id)!.status).toBe("completed");
    expect(await taskHasOpenPendency(client, ORG, id, "return_customer")).toBe(false);
  });
});

describe("lembrete de proposta em tarefa independente", () => {
  it("não entra na tarefa do vendedor, não troca o responsável dela e uma segunda proposta da conversa reaproveita o mesmo lembrete", async () => {
    const before = sellerTask({ type: "scheduled_callback", consolidated_pendencies: [pend("scheduled_callback")] });
    const { client, tables } = makeFakeClient({ tasks: [{ ...before }], organizations: [consolidatedOrg] });
    const reminder = { ...promise(), type: "proposal_followup" as const, priority: "normal" as const, dueTime: null,
      description: "Proposta enviada há 30 min — avaliar próximo contato. É só um lembrete interno: nada foi enviado ao cliente." };
    const a = await createCommitmentTask(client, reminder);
    const b = await createCommitmentTask(client, { ...reminder, dueDate: "2026-11-24" });
    expect(a.id).not.toBe("vend-1");
    expect(b.id).toBe(a.id);
    expect(tables.tasks.find((t) => t.id === "vend-1")).toEqual(before);
    expect(openTasks(tables)).toHaveLength(2);
  });
});

describe("revisão #122: execuções simultâneas e edição do motivo", () => {
  it("duas execuções SIMULTÂNEAS criando a mesma promessa: as duas leem antes de gravar, o índice único barra a segunda e ela reaproveita a primeira", async () => {
    const { client, tables, ops } = makeFakeClient({ tasks: [], organizations: [consolidatedOrg] });
    const [a, b] = await Promise.all([
      createCommitmentTask(client, promise()),
      createCommitmentTask(client, promise({ dueDate: "2026-11-24", dueTime: "15:00", description: 'Retornar ao cliente: você disse "às 15h". Prazo: terça, 24/11, às 15:00.' })),
    ]);
    expect(ops.slice(0, 2)).toEqual(["select", "select"]); // intercaladas de verdade: nenhuma viu a tarefa da outra
    expect(b.id).toBe(a.id);
    expect(openTasks(tables)).toHaveLength(1);
    expect(tables.tasks[0]).toMatchObject({ commitment_kind: "return_customer", due_date: "2026-11-24", due_time: "15:00" }); // a segunda leva o prazo dela
  });

  it("promessa e lembrete de proposta da mesma conversa, simultâneos, não colidem (marcas diferentes)", async () => {
    const { client, tables } = makeFakeClient({ tasks: [], organizations: [consolidatedOrg] });
    await Promise.all([createCommitmentTask(client, promise()), createCommitmentTask(client, { ...promise(), type: "proposal_followup", priority: "normal", dueTime: null })]);
    expect(openTasks(tables).map((t) => t.commitment_kind).sort()).toEqual(["proposal_followup", "return_customer"]);
  });

  it("promessa concluída não bloqueia a próxima: nova promessa na conversa abre outra tarefa", async () => {
    const { client, tables } = makeFakeClient({ tasks: [], organizations: [consolidatedOrg] });
    const first = await createCommitmentTask(client, promise());
    tables.tasks.find((t) => t.id === first.id)!.status = "completed";
    const second = await createCommitmentTask(client, promise({ dueTime: "16:00" }));
    expect(second.id).not.toBe(first.id);
    expect(openTasks(tables)).toHaveLength(1);
  });

  it("vendedor EDITOU o motivo (e até o tipo) da tarefa da promessa: ela continua fora da consolidação e da reutilização", async () => {
    for (const settings of [{ task_consolidation_by_opportunity_enabled: true, task_auto_link_opportunity_enabled: true }, { task_consolidation_by_opportunity_enabled: false }]) {
      const { client, tables } = makeFakeClient({ tasks: [], organizations: [{ id: ORG, settings }] });
      const { id } = await createCommitmentTask(client, promise());
      const t = tables.tasks.find((x) => x.id === id)!;
      t.reason = "Cliente pediu para ligar depois do almoço"; // edição pelo CRM (PATCH /tasks/:id aceita reason e type, não commitment_kind)
      const snapshot = { ...t };
      for (const type of ["customer_nudge", "return_customer"]) {
        const other = await createTaskWithDedup(client, { organization_id: ORG, contact_id: "ct1", conversation_id: "conv1", opportunity_id: "op1", type: type as any,
          description: "outro fluxo", reason: "handoff", priority: "high", due_date: "2026-11-25", created_by_type: "ai", created_by_id: null,
          assignee_type: "human", assignee_id: "marcio", assign_on_merge: true });
        expect(other.task.id).not.toBe(id);
      }
      expect(tables.tasks.find((x) => x.id === id)).toEqual(snapshot);
      // e a rotina continua reconhecendo a própria tarefa (não abre outra)
      expect((await createCommitmentTask(client, promise({ dueTime: "16:00" }))).id).toBe(id);
    }
  });

  it("tarefa comum cujo motivo foi escrito igual ao da rotina NÃO vira independente (segue agrupável)", async () => {
    const common = sellerTask({ reason: COMMITMENT_TASK_REASON.return_customer, type: "return_customer", consolidated_pendencies: [pend("return_customer")] });
    const { client } = makeFakeClient({ tasks: [common], organizations: [consolidatedOrg] });
    const other = await createTaskWithDedup(client, { organization_id: ORG, contact_id: "ct1", conversation_id: "conv1", opportunity_id: "op1", type: "customer_nudge",
      description: "Cliente parou de responder.", reason: "Sem resposta.", priority: "normal", due_date: "2026-11-23", created_by_type: "ai", created_by_id: null });
    expect(other.task.id).toBe("vend-1");
  });
});
