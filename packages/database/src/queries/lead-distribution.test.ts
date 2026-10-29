// packages/database/src/queries/lead-distribution.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  acceptAssignment, computeEscalationDueAt, computeSlaDueAt, distributeLeadForHandoff, getActiveAssignmentRepUserId, hasOpenDistributionException,
  listSlaAlerts, recordDistributionError, recordHumanMessage, redistributeAssignment,
} from "./lead-distribution.js";

vi.mock("./organizations.js", () => ({ getOrganizationById: vi.fn() }));
import { getOrganizationById } from "./organizations.js";

const rpcDb = (data: unknown = "id-1", error: unknown = null) => {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { db: { rpc } as any, rpc };
};

describe("computeSlaDueAt", () => {
  it("usa 15 minutos úteis por padrão e pula o fim de semana", () => {
    const due = computeSlaDueAt({}, new Date("2026-10-09T20:50:00Z")); // sex 17:50
    expect(due.toISOString()).toBe("2026-10-12T11:05:00.000Z");
  });
  it("respeita lead_sla_minutes e business_calendar configurados", () => {
    const due = computeSlaDueAt({ lead_sla_minutes: 30, business_calendar: { weekly: { sat: [{ start: "08:00", end: "12:00" }] } } as any }, new Date("2026-10-10T14:00:00Z"));
    expect(due.toISOString()).toBe("2026-10-10T14:30:00.000Z"); // sáb 11:00 + 30 → 11:30 (janela de sábado configurada)
  });
  it("calendário inválido nunca derruba: usa o padrão", () => {
    const due = computeSlaDueAt({ business_calendar: { weekly: {} } as any }, new Date("2026-10-05T12:00:00Z"));
    expect(due.toISOString()).toBe("2026-10-05T12:15:00.000Z");
  });
});

describe("distributeLeadForHandoff", () => {
  it("modo sombra: chama distribute_lead_shadow quando só a sombra está ligada", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: { lead_distribution_shadow_enabled: true } } as any);
    const { db, rpc } = rpcDb("shadow-1");
    const id = await distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h", now: new Date("2026-10-05T12:00:00Z") });
    expect(id).toBe("shadow-1");
    expect(rpc).toHaveBeenCalledWith("distribute_lead_shadow", expect.objectContaining({ p_handoff_event_id: "h", p_sla_due_at: "2026-10-05T12:15:00.000Z" }));
  });
  it("com a real ligada, ignora a sombra", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: { lead_distribution_enabled: true, lead_distribution_shadow_enabled: true } } as any);
    const { db, rpc } = rpcDb("real-1");
    await distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h" });
    expect(rpc).toHaveBeenCalledWith("distribute_lead", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("distribute_lead_shadow", expect.anything());
  });
  it("não chama o banco com tudo desligado", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: {} } as any);
    const { db, rpc } = rpcDb();
    expect(await distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h" })).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("chama distribute_lead com o prazo calculado e o contexto", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: { lead_distribution_enabled: true } } as any);
    const { db, rpc } = rpcDb("assign-1");
    const id = await distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h", now: new Date("2026-10-05T12:00:00Z"), context: { operation: "financing" } });
    expect(id).toBe("assign-1");
    expect(rpc).toHaveBeenCalledWith("distribute_lead", {
      p_organization_id: "o", p_conversation_id: "c", p_handoff_event_id: "h",
      p_sla_due_at: "2026-10-05T12:15:00.000Z", p_context: { operation: "financing" },
    });
  });
  it("propaga o erro do banco para o chamador decidir", async () => {
    vi.mocked(getOrganizationById).mockResolvedValue({ settings: { lead_distribution_enabled: true } } as any);
    const { db } = rpcDb(null, { message: "boom" });
    await expect(distributeLeadForHandoff(db, { organizationId: "o", conversationId: "c", handoffEventId: "h" })).rejects.toEqual({ message: "boom" });
  });
});

describe("RPC wrappers", () => {
  it("redistributeAssignment envia o novo prazo em ISO", async () => {
    const { db, rpc } = rpcDb("new");
    await redistributeAssignment(db, "a1", new Date("2026-10-05T12:15:00Z"));
    expect(rpc).toHaveBeenCalledWith("redistribute_assignment", { p_assignment_id: "a1", p_new_sla_due_at: "2026-10-05T12:15:00.000Z" });
  });
  it("acceptAssignment e recordHumanMessage mapeiam os parâmetros", async () => {
    const a = rpcDb(true);
    expect(await acceptAssignment(a.db, { assignmentId: "a", actorUserId: "u", actorIsAdmin: false })).toBe(true);
    expect(a.rpc).toHaveBeenCalledWith("accept_assignment", { p_assignment_id: "a", p_actor: "u", p_actor_is_admin: false });
    const b = rpcDb("a");
    await recordHumanMessage(b.db, { organizationId: "o", conversationId: "c", at: new Date("2026-10-05T12:00:00Z"), authorUserId: null, via: "phone_echo" });
    expect(b.rpc).toHaveBeenCalledWith("record_human_message", { p_organization_id: "o", p_conversation_id: "c", p_at: "2026-10-05T12:00:00.000Z", p_author: null, p_via: "phone_echo" });
  });
});

/** Cadeia do supabase-js: cada filtro devolve a própria consulta; o resultado sai em maybeSingle()/await. */
const queryDb = (result: { data: unknown; error: unknown }) => {
  const calls: Array<[string, unknown[]]> = [];
  const q: any = {};
  for (const m of ["select", "eq", "in", "is", "limit"]) q[m] = (...args: unknown[]) => { calls.push([m, args]); return q; };
  q.maybeSingle = () => Promise.resolve(result);
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  const from = vi.fn().mockReturnValue(q);
  return { db: { from } as any, from, calls };
};

describe("consultas usadas pelo requestHuman (C1)", () => {
  it("getActiveAssignmentRepUserId devolve o usuário do vendedor da atribuição ativa da conversa", async () => {
    const { db, from, calls } = queryDb({ data: { rep_id: "r1", sales_reps: { user_id: "u1" } }, error: null });
    expect(await getActiveAssignmentRepUserId(db, "o", "c")).toBe("u1");
    expect(from).toHaveBeenCalledWith("lead_assignments");
    expect(calls).toEqual(expect.arrayContaining([["eq", ["organization_id", "o"]], ["eq", ["conversation_id", "c"]], ["in", ["status", ["pending", "accepted"]]]]));
  });
  it("getActiveAssignmentRepUserId devolve null sem atribuição ativa e propaga erro", async () => {
    expect(await getActiveAssignmentRepUserId(queryDb({ data: null, error: null }).db, "o", "c")).toBeNull();
    await expect(getActiveAssignmentRepUserId(queryDb({ data: null, error: { message: "x" } }).db, "o", "c")).rejects.toEqual({ message: "x" });
  });
  it("hasOpenDistributionException procura exceção não resolvida da conversa", async () => {
    const yes = queryDb({ data: [{ id: "e1" }], error: null });
    expect(await hasOpenDistributionException(yes.db, "o", "c")).toBe(true);
    expect(yes.calls).toEqual(expect.arrayContaining([["eq", ["organization_id", "o"]], ["eq", ["conversation_id", "c"]], ["eq", ["status", "exception"]], ["is", ["resolved_at", null]]]));
    expect(await hasOpenDistributionException(queryDb({ data: [], error: null }).db, "o", "c")).toBe(false);
  });
});

describe("recordDistributionError (I2)", () => {
  it("chama record_distribution_error com os parâmetros", async () => {
    const { db, rpc } = rpcDb("exc-1");
    expect(await recordDistributionError(db, { organizationId: "o", conversationId: "c", handoffEventId: "h", message: "boom" })).toBe("exc-1");
    expect(rpc).toHaveBeenCalledWith("record_distribution_error", { p_organization_id: "o", p_conversation_id: "c", p_handoff_event_id: "h", p_message: "boom" });
  });
  it("propaga o erro (quem chama decide engolir)", async () => {
    await expect(recordDistributionError(rpcDb(null, { message: "down" }).db, { organizationId: "o", conversationId: "c", handoffEventId: "h", message: "m" })).rejects.toEqual({ message: "down" });
  });
});

describe("computeEscalationDueAt (2x o SLA em minutos úteis)", () => {
  it("estouro na sexta 17:45 (SP) escala na segunda 08:15; dentro do expediente é só 2x", () => {
    expect(computeEscalationDueAt({ lead_sla_minutes: 15 }, new Date("2026-10-23T20:45:00Z")).toISOString()).toBe("2026-10-26T11:15:00.000Z"); // sexta 17:45 + 30 min úteis
    expect(computeEscalationDueAt({ lead_sla_minutes: 15 }, new Date("2026-10-26T12:00:00Z")).toISOString()).toBe("2026-10-26T12:30:00.000Z");
  });
});

describe("listSlaAlerts: só atribuições ainda sem resposta", () => {
  const base = (id: string, o: Record<string, unknown> = {}) => ({
    id, organization_id: "org", conversation_id: `conv-${id}`, contact_id: `ct-${id}`, reason: "existing_owner",
    assigned_at: "2026-10-27T12:00:00Z", handoff_at: "2026-10-27T11:59:00Z", first_human_message_at: null, accepted_at: null, ...o,
  });
  // Fake do query builder: cada tabela devolve as linhas dadas; filtros são ignorados (a função filtra em memória).
  const inCalls: number[] = [];
  const fake = (tables: Record<string, any[]>) => {
    const builder = (rows: any[]) => { const b: any = { select: () => b, eq: () => b, in: (_c: string, ids: string[]) => { inCalls.push(ids.length); return b; }, gte: () => b, or: () => b, order: () => b, range: async (a: number, z: number) => ({ data: rows.slice(a, z + 1), error: null }) }; return b; };
    return { from: (t: string) => builder(tables[t] ?? []) } as any;
  };
  const run = async (assignments: any[], extra: Record<string, any[]> = {}) =>
    (await listSlaAlerts(fake({ lead_assignments: assignments, conversations: assignments.map((a) => ({ id: a.conversation_id, status: "open" })), ...extra }), "org")).map((a: any) => a.id);

  it("mantém só a atribuição realmente sem resposta", async () => {
    expect(await run([base("a")])).toEqual(["a"]);
  });
  it("some quando há mensagem human_agent depois do handoff (resposta pelo celular), mas não uma anterior", async () => {
    const as = [base("a"), base("b")];
    expect(await run(as, { messages: [{ conversation_id: "conv-a", created_at: "2026-10-27T12:30:00Z" }, { conversation_id: "conv-b", created_at: "2026-10-27T11:00:00Z" }] })).toEqual(["b"]);
  });
  it("atribuição manual conta a mensagem desde assigned_at, não desde o handoff", async () => {
    const m = base("m", { reason: "manual", handoff_at: "2026-10-27T10:00:00Z" });
    expect(await run([m], { messages: [{ conversation_id: "conv-m", created_at: "2026-10-27T11:00:00Z" }] })).toEqual(["m"]);
  });
  it("some com first_human_message_at, accepted_at, conversa encerrada, nota, ligação, atividade comercial ou negócio ganho", async () => {
    const as = [base("fh", { first_human_message_at: "2026-10-27T12:10:00Z" }), base("ac", { accepted_at: "2026-10-27T12:10:00Z" }), base("cl"), base("nt"), base("ca"), base("co"), base("wo"), base("keep")];
    const out = await listSlaAlerts(fake({
      lead_assignments: as,
      conversations: as.map((a) => ({ id: a.conversation_id, status: a.id === "cl" ? "closed" : "open" })),
      conversation_notes: [{ conversation_id: "conv-nt", created_at: "2026-10-27T12:20:00Z" }],
      opportunities: [
        { id: "o-co", contact_id: "ct-co", status: "open", last_commercial_activity_at: "2026-10-27T12:40:00Z", updated_at: null },
        { id: "o-wo", contact_id: "ct-wo", status: "won", last_commercial_activity_at: null, updated_at: "2026-10-27T12:50:00Z" },
        { id: "o-ca", contact_id: "ct-ca", status: "open", last_commercial_activity_at: "2026-10-27T10:00:00Z", updated_at: null },
      ],
      sales_call_logs: [{ contact_id: null, opportunity_id: "o-ca", called_at: "2026-10-27T12:30:00Z" }],
    }), "org");
    expect(out.map((a: any) => a.id)).toEqual(["keep"]);
  });
  it("sem alertas não consulta as demais tabelas", async () => {
    const from = vi.fn((t: string) => { const b: any = { select: () => b, eq: () => b, order: () => b, range: async () => ({ data: [], error: null }) }; return b; });
    expect(await listSlaAlerts({ from } as any, "org")).toEqual([]);
    expect(from).toHaveBeenCalledTimes(1);
  });
  it("mais de 100 atribuições: ids em lotes de até 100 e leitura paginada além de 1000 linhas", async () => {
    inCalls.length = 0;
    const as = Array.from({ length: 1250 }, (_, i) => base(`n${i}`));
    const answeredIds = new Set(["n7", "n1200"]);
    const out = await listSlaAlerts(fake({
      lead_assignments: as, conversations: as.map((a) => ({ id: a.conversation_id, status: answeredIds.has(a.id) ? "closed" : "open" })),
    }), "org");
    expect(out).toHaveLength(1248); // as 1250 passam da primeira página de 1000 e as duas encerradas somem
    expect(inCalls.length).toBeGreaterThan(0);
    expect(Math.max(...inCalls)).toBeLessThanOrEqual(100);
  });
});
