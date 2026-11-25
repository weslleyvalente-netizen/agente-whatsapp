import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ createTaskWithDedup: vi.fn() }));
vi.mock("@aula-agente/database", () => m);
import { evaluateTrigger, runReturningCustomerCheck, type Trigger } from "./returning-customer.js";

// Supabase falso: cada from(tabela) devolve uma cadeia que resolve com o que o teste definiu.
function fakeDb(opts: { context: unknown; messages?: unknown[]; upsertId?: string | null; openResult?: string | null }) {
  const calls = { upserts: [] as any[], rpc: [] as Array<[string, any]>, updates: [] as any[] };
  const chain = (result: unknown) => {
    const c: any = new Proxy({}, { get: (_t, k) => (k === "then" ? (res: any) => Promise.resolve(result).then(res) : () => c) });
    return c;
  };
  const db: any = {
    rpc: vi.fn(async (name: string, args: any) => {
      calls.rpc.push([name, args]);
      if (name === "returning_customer_context") return { data: opts.context, error: null };
      if (name === "open_returning_customer_opportunity") return { data: opts.openResult ?? "opp-new", error: null };
      return { data: null, error: null };
    }),
    from: (table: string) => ({
      select: () => chain(table === "messages" ? { data: [...(opts.messages ?? [])].reverse(), error: null } : { data: [], error: null }),
      upsert: (row: any) => { calls.upserts.push(row); return chain({ data: opts.upsertId === null ? [] : [{ id: opts.upsertId ?? "dec-1" }], error: null }); },
      update: (row: any) => { calls.updates.push(row); return chain({ error: null }); },
    }),
  };
  return { db, calls };
}

const prev = { id: "prev", status: "lost", lost_reason: "sem_resposta", operation: "vehicle_sale", owner_id: "marina", owner_active: true, closed_at: "2026-11-04T14:49:00Z" };
const ctx = (over: object = {}) => ({ identity_ids: ["c1"], identity_status: "resolved", open: [], previous: prev, ...over });
const trig: Trigger = { kind: "handoff", id: "h1", contactId: "c1", conversationId: "conv1", at: "2026-11-24T18:11:00Z", summary: "Rosângela procura elétrico estilo Biz" };
const msgs = [{ id: "m1", role: "contact", content: "Mande para mim as fotos e os valores por favor", created_at: "2026-11-24T18:07:00Z" }];
const commercial = vi.fn().mockResolvedValue({ intent: "commercial", operation: "vehicle_sale", customer_gave_specifics: true, proposal_message_id: null, reason: "Pediu fotos e valores de elétricas" });
const org = (mode: "shadow" | "write") => ({ id: "org", settings: { returning_customer_card_enabled: true, returning_customer_card_mode: mode, returning_customer_card_started_at: "2026-11-25T00:00:00Z" } });

beforeEach(() => { vi.clearAllMocks(); m.createTaskWithDedup.mockResolvedValue({ task: { id: "task-review" } }); });

describe("cliente que volta", () => {
  it("modo sombra (caso Rosângela): grava 'would_create' com etapa e evidência e NÃO cria card", async () => {
    const { db, calls } = fakeDb({ context: ctx(), messages: msgs });
    expect(await evaluateTrigger(db, org("shadow") as any, trig, commercial)).toBe("recorded");
    expect(calls.upserts[0]).toMatchObject({ mode: "shadow", intent: "commercial", operation: "vehicle_sale", stage: "qualification", outcome: "would_create", previous_opportunity_id: "prev", trigger_kind: "handoff", trigger_id: "h1" });
    expect(calls.upserts[0].evidence.customer_messages[0].text).toContain("fotos e os valores");
    expect(calls.rpc.map((c) => c[0])).not.toContain("open_returning_customer_opportunity");
  });

  it("modo escrita: comercial cria pelo banco (trava e reconferência ficam no SQL)", async () => {
    const { db, calls } = fakeDb({ context: ctx(), messages: msgs });
    expect(await evaluateTrigger(db, org("write") as any, trig, commercial)).toBe("created");
    expect(calls.rpc.find((c) => c[0] === "open_returning_customer_opportunity")![1]).toMatchObject({ p_decision: "dec-1" });
  });

  it("intenção incerta: em escrita vira pendência de revisão para a vendedora anterior ativa", async () => {
    const unclear = vi.fn().mockResolvedValue({ intent: "unclear", operation: null, customer_gave_specifics: false, proposal_message_id: null, reason: "Só arquivos sem explicação" });
    const { db, calls } = fakeDb({ context: ctx(), messages: msgs });
    expect(await evaluateTrigger(db, org("write") as any, trig, unclear)).toBe("review");
    expect(calls.upserts[0].outcome).toBe("needs_review");
    expect(m.createTaskWithDedup).toHaveBeenCalledWith(db, expect.objectContaining({ type: "other", assignee_id: "marina", reason: "returning_customer_review:dec-1" }));
    expect(calls.updates[0]).toEqual({ review_task_id: "task-review" });
  });

  it("administrativo (pós-venda) só registra; negócio aberto da mesma operação => sem duplicidade; outra operação => cria", async () => {
    const admin = vi.fn().mockResolvedValue({ intent: "administrative", operation: null, customer_gave_specifics: false, proposal_message_id: null, reason: "Comprovante de boleto" });
    let f = fakeDb({ context: ctx(), messages: msgs });
    expect(await evaluateTrigger(f.db, org("write") as any, trig, admin)).toBe("recorded");
    expect(f.calls.upserts[0].outcome).toBe("skipped_not_commercial");
    f = fakeDb({ context: ctx({ open: [{ id: "o", operation: "vehicle_sale", operation_is_default: false }] }), messages: msgs });
    await evaluateTrigger(f.db, org("write") as any, trig, commercial);
    expect(f.calls.upserts[0].outcome).toBe("skipped_open_compatible");
    f = fakeDb({ context: ctx({ open: [{ id: "o", operation: "consortium", operation_is_default: false }] }), messages: msgs });
    expect(await evaluateTrigger(f.db, org("write") as any, trig, commercial)).toBe("created");
  });

  it("contato sem negócio fechado (lead novo) ou gatilho já decidido por outro processo: nada acontece", async () => {
    let f = fakeDb({ context: ctx({ previous: null }), messages: msgs });
    expect(await evaluateTrigger(f.db, org("write") as any, trig, commercial)).toBe("skipped");
    expect(f.calls.upserts).toHaveLength(0);
    f = fakeDb({ context: ctx(), messages: msgs, upsertId: null });
    expect(await evaluateTrigger(f.db, org("write") as any, trig, commercial)).toBe("skipped");
    expect(f.calls.rpc.map((c) => c[0])).not.toContain("open_returning_customer_opportunity");
  });

  it("flag desligada ou sem data de início: não lê nada", async () => {
    const { db } = fakeDb({ context: ctx() });
    db.from = vi.fn();
    expect(await runReturningCustomerCheck(db, { id: "org", settings: {} } as any, commercial)).toEqual({ evaluated: 0, created: 0, review: 0 });
    expect(await runReturningCustomerCheck(db, { id: "org", settings: { returning_customer_card_enabled: true } } as any, commercial)).toEqual({ evaluated: 0, created: 0, review: 0 });
    expect(db.from).not.toHaveBeenCalled();
  });
});
