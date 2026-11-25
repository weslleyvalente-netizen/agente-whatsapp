import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ createMessage: vi.fn(), updateConversation: vi.fn() }));
vi.mock("@aula-agente/database", () => m);
vi.mock("@aula-agente/queue", () => ({ getSendMessageQueue: vi.fn(), getRedisConnection: vi.fn() }));
vi.mock("../lib/lock.js", () => ({ acquireConversationLock: vi.fn(), releaseConversationLock: vi.fn() }));
import { runNoReplyClosureCheck, type NoReplyClosureDeps } from "./no-reply-closure.js";

const NOON = new Date("2026-11-25T15:00:00Z"); // 12:00 BRT
const NIGHT = new Date("2026-11-25T23:30:00Z"); // 20:30 BRT
const CLOSING = "Vou encerrar por aqui por enquanto 😊 Quando quiser retomar, é só me mandar uma mensagem.";
const org = (over: object = {}) => ({ id: "org", settings: { no_reply_closure_enabled: true, no_reply_closure_started_at: "2026-11-25T00:00:00Z", sales_low_intent_closing_message: CLOSING, ...over } });
const cand = (id: string, instance = "inst1") => ({ conversation_id: id, contact_id: "c-" + id, instance_id: instance, phone: "5562999990000", followup_days: 4, anchor: "2026-11-20T12:00:00Z", opportunity_id: "opp-" + id });

function fakeDb(candidates: any[], confirmed: any[] = []) {
  const rpc = vi.fn(async (name: string, args: any) => {
    if (name === "no_reply_closure_candidates") return { data: args.p_conversation ? candidates.filter((c) => c.conversation_id === args.p_conversation) : candidates, error: null };
    if (name === "apply_no_reply_closure") return { data: 1, error: null };
    return { data: null, error: null };
  });
  const chain: any = new Proxy({}, { get: (_t, k) => (k === "then" ? (res: any) => Promise.resolve({ data: confirmed, error: null }).then(res) : () => chain) });
  return { rpc, from: vi.fn(() => chain) } as any;
}
const deps = (over: Partial<NoReplyClosureDeps> = {}): NoReplyClosureDeps => ({
  reserve: vi.fn().mockResolvedValue(true), enqueue: vi.fn().mockResolvedValue(undefined), lock: vi.fn().mockResolvedValue("tok"), unlock: vi.fn().mockResolvedValue(undefined), ...over,
});

beforeEach(() => { vi.clearAllMocks(); m.createMessage.mockImplementation(async (_db: any, row: any) => ({ id: "msg-" + row.conversation_id, ...row })); });

describe("encerramento sem resposta (worker)", () => {
  it("flag desligada ou sem data de início: não consulta nada", async () => {
    const db = fakeDb([cand("a")]);
    expect(await runNoReplyClosureCheck(db, { id: "org", settings: {} } as any, NOON, undefined, deps())).toEqual({ applied: 0, lost: 0, queued: 0 });
    expect(await runNoReplyClosureCheck(db, org({ no_reply_closure_started_at: undefined }) as any, NOON, undefined, deps())).toEqual({ applied: 0, lost: 0, queued: 0 });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("envia a mesma despedida da cadência com metadata e tentativa única; uma por instância por ciclo", async () => {
    const d = deps();
    const r = await runNoReplyClosureCheck(fakeDb([cand("a"), cand("b"), cand("c", "inst2")]), org() as any, NOON, undefined, d);
    expect(r.queued).toBe(2);
    expect(m.createMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "agent", content: CLOSING, metadata: { no_reply_closure: expect.objectContaining({ followup_days: 4 }) } }));
    expect((d.enqueue as any).mock.calls.map((c: any) => c[0].conversationId)).toEqual(["a", "c"]);
  });

  it("revisão 25/11: a despedida grava o negócio correspondente (o único aberto do grupo) para o encerramento não atingir outro", async () => {
    await runNoReplyClosureCheck(fakeDb([cand("a")]), org() as any, NOON, undefined, deps());
    expect(m.createMessage.mock.calls[0][1].metadata.no_reply_closure).toMatchObject({ opportunity_id: "opp-a", followup_days: 4 });
  });

  it("fora do horário comercial: só aplica as confirmadas, não envia", async () => {
    const db = fakeDb([cand("a")], [{ id: "m-confirmed" }]);
    const d = deps();
    const r = await runNoReplyClosureCheck(db, org() as any, NIGHT, undefined, d);
    expect(r).toEqual({ applied: 1, lost: 1, queued: 0 });
    expect(db.rpc).toHaveBeenCalledWith("apply_no_reply_closure", { p_message: "m-confirmed" });
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it("limite de intervalo/diário esgotado, conversa travada ou cliente respondeu (reconferência vazia): não envia", async () => {
    expect((await runNoReplyClosureCheck(fakeDb([cand("a")]), org() as any, NOON, undefined, deps({ reserve: vi.fn().mockResolvedValue(false) }))).queued).toBe(0);
    expect((await runNoReplyClosureCheck(fakeDb([cand("a")]), org() as any, NOON, undefined, deps({ lock: vi.fn().mockResolvedValue(null) }))).queued).toBe(0);
    const db = fakeDb([cand("a")]);
    db.rpc.mockImplementation(async (name: string, args: any) => ({ data: name === "no_reply_closure_candidates" && !args.p_conversation ? [cand("a")] : [], error: null }));
    expect((await runNoReplyClosureCheck(db, org() as any, NOON, undefined, deps())).queued).toBe(0);
    expect(m.createMessage).not.toHaveBeenCalled();
  });
});
