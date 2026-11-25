// Revisão independente do PR #123 (25/11): regressões do worker escritas antes da correção.
// Banco falso com estado: as tabelas respeitam eq/in/is/gte/order/limit como o PostgREST, e as RPCs novas espelham o SQL
// (o comportamento real delas está coberto em packages/database/src/sql/returning-customer-and-closure.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ createTaskWithDedup: vi.fn() }));
vi.mock("@aula-agente/database", () => m);
import { runReturningCustomerCheck } from "./returning-customer.js";

type Row = Record<string, any>;
function statefulDb(seed: { handoffs: Row[]; decisions?: Row[] }, opts: { openFailures?: number } = {}) {
  const messages = seed.handoffs.map((h) => ({ id: `m-${h.id}`, conversation_id: h.conversation_id, role: "contact", content: "Quero saber o valor da moto",
    created_at: new Date(Date.parse(h.handed_at) - 5 * 60_000).toISOString() }));
  const tables: Record<string, Row[]> = { handoff_events: seed.handoffs, tasks: [], returning_customer_decisions: seed.decisions ?? [], messages, lead_ad_touches: [] };
  let openFailures = opts.openFailures ?? 0;
  const calls = { open: [] as string[] };
  const query = (table: string) => {
    let rows = () => tables[table] ?? [];
    const filters: Array<(r: Row) => boolean> = [];
    let order: string | null = null, asc = true, limit = Infinity, op: "select" | "update" = "select", patch: Row = {}, upsertRow: Row | null = null;
    const q: any = {
      select: () => q, order: (c: string, o?: { ascending?: boolean }) => { order = c; asc = o?.ascending !== false; return q; }, limit: (n: number) => { limit = n; return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      gte: (c: string, v: string) => { filters.push((r) => r[c] >= v); return q; },
      lte: (c: string, v: string) => { filters.push((r) => r[c] <= v); return q; },
      update: (p: Row) => { op = "update"; patch = p; return q; },
      upsert: (r: Row) => { upsertRow = r; return q; },
      then: (res: any, rej: any) => {
        try {
          if (upsertRow) {
            const dup = tables[table].some((x) => x.trigger_kind === upsertRow!.trigger_kind && x.trigger_id === upsertRow!.trigger_id);
            if (dup) return Promise.resolve({ data: [], error: null }).then(res);
            const row = { id: `dec-${tables[table].length + 1}`, attempts: 0, last_error: null, review_task_id: null, ...upsertRow };
            tables[table].push(row);
            return Promise.resolve({ data: [{ id: row.id }], error: null }).then(res);
          }
          let out = rows().filter((r) => filters.every((f) => f(r)));
          if (op === "update") { out.forEach((r) => Object.assign(r, patch)); return Promise.resolve({ data: null, error: null }).then(res); }
          if (order) out = [...out].sort((a, b) => (asc ? 1 : -1) * String(a[order!]).localeCompare(String(b[order!])));
          return Promise.resolve({ data: out.slice(0, limit), error: null }).then(res);
        } catch (e) { return Promise.reject(e).then(res, rej); }
      },
    };
    return q;
  };
  const dec = (id: string) => tables.returning_customer_decisions.find((d) => d.id === id)!;
  const db: any = {
    from: (t: string) => query(t),
    rpc: vi.fn(async (name: string, a: any) => {
      if (name === "returning_customer_context")
        return { data: { identity_ids: [a.p_contact], identity_status: "resolved", open: [], previous: { id: "prev", status: "lost", lost_reason: "sem_resposta", operation: "vehicle_sale", owner_id: null, owner_active: false, closed_at: "2026-11-01T00:00:00Z" } }, error: null };
      if (name === "returning_customer_triggers") {
        const done = new Set(tables.returning_customer_decisions.map((d) => `${d.trigger_kind}:${d.trigger_id}`));
        const data = tables.handoff_events.filter((h) => h.handed_at >= a.p_since && !done.has(`handoff:${h.id}`)).sort((x, y) => x.handed_at.localeCompare(y.handed_at))
          .slice(0, a.p_limit).map((h) => ({ kind: "handoff", id: h.id, contact_id: h.contact_id, conversation_id: h.conversation_id, at: h.handed_at, summary: h.resumo }));
        return { data, error: null };
      }
      if (name === "returning_customer_pending_decisions")
        return { data: tables.returning_customer_decisions.filter((d) => d.mode === "write" && d.attempts < 5 && (d.outcome === "would_create" || (d.outcome === "needs_review" && !d.review_task_id))), error: null };
      if (name === "returning_customer_mark_attempt") { const d = dec(a.p_decision); d.attempts++; d.last_error = a.p_error; return { data: null, error: null }; }
      if (name === "returning_customer_owner") return { data: { user_id: "marcio", rule: "round_robin" }, error: null };
      if (name === "open_returning_customer_opportunity") {
        calls.open.push(a.p_decision);
        if (openFailures-- > 0) return { data: null, error: { message: "statement timeout" } };
        Object.assign(dec(a.p_decision), { outcome: "created", opportunity_id: "opp-1" });
        return { data: "opp-1", error: null };
      }
      return { data: null, error: null };
    }),
  };
  return { db, tables, calls };
}

const NOW = new Date("2026-11-25T15:00:00Z");
const org = (mode: "shadow" | "write" = "write") => ({ id: "org", settings: { returning_customer_card_enabled: true, returning_customer_card_mode: mode, returning_customer_card_started_at: "2026-11-20T00:00:00Z" } });
const handoff = (i: number) => ({ id: `h${String(i).padStart(2, "0")}`, organization_id: "org", trigger_type: "request_human", conversation_id: `conv${i}`, contact_id: `c${i}`,
  conversations: { contact_id: `c${i}` }, handed_at: new Date(Date.UTC(2026, 10, 24, 0, i)).toISOString(), resumo: "quer moto" });
const commercial = vi.fn();
const unclear = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  commercial.mockResolvedValue({ intent: "commercial", operation: "vehicle_sale", customer_gave_specifics: true, proposal_message_id: null, reason: "Pediu valores" });
  unclear.mockResolvedValue({ intent: "unclear", operation: null, customer_gave_specifics: false, proposal_message_id: null, reason: "Só um arquivo" });
});

describe("revisão 25/11 — worker cliente que volta", () => {
  it("starvation: 35 encaminhamentos na janela, os 30 primeiros já decididos => os 5 novos são avaliados", async () => {
    const handoffs = Array.from({ length: 35 }, (_, i) => handoff(i));
    const decisions = handoffs.slice(0, 30).map((h, i) => ({ id: `old-${i}`, organization_id: "org", trigger_kind: "handoff", trigger_id: h.id, mode: "shadow", outcome: "skipped_not_commercial", attempts: 0 }));
    const { db } = statefulDb({ handoffs, decisions });
    const r = await runReturningCustomerCheck(db, org("shadow") as any, commercial, NOW);
    expect(r.evaluated).toBe(5);
  });

  it("falha entre gravar a decisão e criar o card: o ciclo seguinte recupera (sem reclassificar e sem duplicar)", async () => {
    const { db, tables, calls } = statefulDb({ handoffs: [handoff(1)] }, { openFailures: 1 });
    const first = await runReturningCustomerCheck(db, org() as any, commercial, NOW);
    expect(first.created).toBe(0);
    expect(tables.returning_customer_decisions).toHaveLength(1);
    expect(tables.returning_customer_decisions[0]).toMatchObject({ outcome: "would_create", attempts: 1, last_error: "statement timeout" });
    const second = await runReturningCustomerCheck(db, org() as any, commercial, new Date(NOW.getTime() + 15 * 60_000));
    expect(second.created).toBe(1);
    expect(calls.open).toEqual(["dec-1", "dec-1"]);
    expect(commercial).toHaveBeenCalledTimes(1);
    expect(tables.returning_customer_decisions[0]).toMatchObject({ outcome: "created", opportunity_id: "opp-1" });
    const third = await runReturningCustomerCheck(db, org() as any, commercial, new Date(NOW.getTime() + 30 * 60_000));
    expect(third.created).toBe(0);
    expect(calls.open).toHaveLength(2);
  });

  it("falha ao criar a tarefa de revisão: o ciclo seguinte cria, com responsável pelo rodízio", async () => {
    m.createTaskWithDedup.mockRejectedValueOnce(new Error("insert failed")).mockResolvedValue({ task: { id: "task-review" } });
    const { db, tables } = statefulDb({ handoffs: [handoff(1)] });
    expect((await runReturningCustomerCheck(db, org() as any, unclear, NOW)).review).toBe(0);
    expect(tables.returning_customer_decisions[0]).toMatchObject({ outcome: "needs_review", review_task_id: null, attempts: 1 });
    expect((await runReturningCustomerCheck(db, org() as any, unclear, new Date(NOW.getTime() + 15 * 60_000))).review).toBe(1);
    expect(m.createTaskWithDedup).toHaveBeenLastCalledWith(db, expect.objectContaining({ assignee_type: "human", assignee_id: "marcio", reason: "returning_customer_review:dec-1" }));
    expect(tables.returning_customer_decisions[0].review_task_id).toBe("task-review");
    expect(unclear).toHaveBeenCalledTimes(1);
  });
});
