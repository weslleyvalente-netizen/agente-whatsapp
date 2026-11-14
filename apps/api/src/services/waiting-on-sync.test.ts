import { describe, expect, it, vi } from "vitest";

const getOrg = vi.fn();
vi.mock("@aula-agente/database", () => ({ getOrganizationById: (...a: unknown[]) => getOrg(...a) }));
import { syncWaitingOnAfterCustomerReply, syncWaitingOnAfterHumanCompletion } from "./waiting-on-sync.js";
import { AWAITING_CUSTOMER_NEXT_ACTION, HANDOFF_AUTO_NEXT_ACTION } from "@aula-agente/shared";

function world(o: { enabled?: boolean | string; opps?: any[]; humanMsgs?: any[]; otherTasks?: any[]; throws?: boolean } = {}) {
  getOrg.mockReset(); getOrg.mockResolvedValue({ settings: { waiting_on_sync_enabled: "enabled" in o ? o.enabled : true } });
  const updates: any[] = [];
  const opps = o.opps ?? [{ id: "op1", contact_id: "ct1", status: "open", stage: "decision_negotiation", waiting_on: "team", next_action: HANDOFF_AUTO_NEXT_ACTION }];
  const db: any = {
    from: (t: string) => {
      const result = () => (o.throws ? { data: null, error: { message: "boom" } } : { data: t === "opportunities" ? opps : t === "messages" ? (o.humanMsgs ?? [{ id: "m" }]) : (o.otherTasks ?? []), error: null });
      const c: any = {
        select: () => c, eq: () => c, in: () => c, or: () => c, neq: () => c, gt: () => c, limit: () => Promise.resolve(result()),
        update: (v: any) => { const guards: any[] = []; const u: any = { eq: (k: string, val: unknown) => { guards.push([k, val]); return u; }, then: (res: any) => { updates.push({ v, guards }); res({ error: null }); } }; return u; },
        then: (res: any) => res(result()),
      };
      return c;
    },
  };
  return { db, updates };
}
const task = (over: any = {}) => ({ id: "t1", organization_id: "org", contact_id: "ct1", conversation_id: "conv1", opportunity_id: "op1", type: "return_customer", created_at: "2026-11-13T19:02:36Z", consolidated_pendencies: [], ...over });

describe("syncWaitingOnAfterHumanCompletion", () => {
  it("caso Romario: humano conclui o atendimento do repasse e já respondeu => 'Aguardando' vira cliente, com guarda otimista (só se ainda for team + texto automático)", async () => {
    const w = world();
    expect(await syncWaitingOnAfterHumanCompletion(w.db, task())).toBe("set_customer");
    expect(w.updates).toHaveLength(1);
    expect(w.updates[0].v).toEqual({ waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION });
    expect(w.updates[0].guards).toEqual(expect.arrayContaining([["id", "op1"], ["waiting_on", "team"], ["next_action", HANDOFF_AUTO_NEXT_ACTION]]));
  });
  it.each([false, "true", 1, undefined])("só liga com true literal (%s)", async (v) => {
    const w = world({ enabled: v as any }); expect(await syncWaitingOnAfterHumanCompletion(w.db, task())).toBe("disabled"); expect(w.updates).toHaveLength(0);
  });
  it("concluiu sem ter respondido o cliente: não muda", async () => {
    const w = world({ humanMsgs: [] }); expect(await syncWaitingOnAfterHumanCompletion(w.db, task())).toBe("no_human_reply"); expect(w.updates).toHaveLength(0);
  });
  it("sem conversa na tarefa: não há prova de resposta", async () => {
    const w = world(); expect(await syncWaitingOnAfterHumanCompletion(w.db, task({ conversation_id: null }))).toBe("no_human_reply");
  });
  it("outra obrigação aberta no negócio: não muda", async () => {
    const w = world({ otherTasks: [{ id: "t2" }] }); expect(await syncWaitingOnAfterHumanCompletion(w.db, task())).toBe("other_open_tasks"); expect(w.updates).toHaveLength(0);
  });
  it("não era a tarefa de atendimento: não muda; consolidada que a carrega: muda", async () => {
    expect(await syncWaitingOnAfterHumanCompletion(world().db, task({ type: "request_documents" }))).toBe("not_attendance_task");
    expect(await syncWaitingOnAfterHumanCompletion(world().db, task({ type: "customer_nudge", consolidated_pendencies: [{ type: "return_customer" }] }))).toBe("set_customer");
  });
  it("contato com vários negócios abertos e tarefa sem negócio: não adivinha", async () => {
    const two = [{ id: "a", contact_id: "ct1", status: "open", stage: "x", waiting_on: "team", next_action: HANDOFF_AUTO_NEXT_ACTION }, { id: "b", contact_id: "ct1", status: "open", stage: "x", waiting_on: "team", next_action: HANDOFF_AUTO_NEXT_ACTION }];
    const w = world({ opps: two }); expect(await syncWaitingOnAfterHumanCompletion(w.db, task({ opportunity_id: null }))).toBe("no_single_open_opportunity");
  });
  it("próxima ação editada por humano ou etapa da equipe: não muda", async () => {
    const edited = world({ opps: [{ id: "op1", contact_id: "ct1", status: "open", stage: "documentation", waiting_on: "team", next_action: "Ligar amanhã" }] });
    expect(await syncWaitingOnAfterHumanCompletion(edited.db, task())).toBe("next_action_edited");
    const sim = world({ opps: [{ id: "op1", contact_id: "ct1", status: "open", stage: "awaiting_simulation", waiting_on: "team", next_action: HANDOFF_AUTO_NEXT_ACTION }] });
    expect(await syncWaitingOnAfterHumanCompletion(sim.db, task())).toBe("team_owned_stage");
  });
  it("erro de banco nunca lança (a conclusão da tarefa é a operação principal)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await syncWaitingOnAfterHumanCompletion(world({ throws: true }).db, task())).toBe("error"); spy.mockRestore();
  });
});

describe("syncWaitingOnAfterCustomerReply", () => {
  const waitingCustomer = [{ id: "op1", contact_id: "ct1", status: "open", stage: "x", waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION }];
  const reply = (content: string | null, role = "contact") => ({ organizationId: "org", contactId: "ct1", role, content });
  it("resposta substantiva devolve a bola à equipe, com guarda otimista", async () => {
    const w = world({ opps: waitingCustomer });
    expect(await syncWaitingOnAfterCustomerReply(w.db, reply("Pode ser, qual o valor da entrada?"))).toBe("set_team");
    expect(w.updates[0].v).toEqual({ waiting_on: "team", next_action: "Responder ao cliente" });
    expect(w.updates[0].guards).toEqual(expect.arrayContaining([["waiting_on", "customer"], ["next_action", AWAITING_CUSTOMER_NEXT_ACTION]]));
  });
  it("'ok' ou mensagem do vendedor não transfere nada", async () => {
    const a = world({ opps: waitingCustomer }); expect(await syncWaitingOnAfterCustomerReply(a.db, reply("ok"))).toBe("not_substantive"); expect(a.updates).toHaveLength(0);
    const b = world({ opps: waitingCustomer }); expect(await syncWaitingOnAfterCustomerReply(b.db, reply("quero fechar sim", "human_agent"))).toBe("not_customer");
  });
  it("'Aguardando cliente' definido manualmente nunca é desfeito", async () => {
    const w = world({ opps: [{ ...waitingCustomer[0], next_action: "Aguardar documentos" }] });
    expect(await syncWaitingOnAfterCustomerReply(w.db, reply("mandei os documentos agora, pode conferir?"))).toBe("not_auto_waiting"); expect(w.updates).toHaveLength(0);
  });
  it("flag desligada: nada", async () => {
    const w = world({ enabled: false, opps: waitingCustomer }); expect(await syncWaitingOnAfterCustomerReply(w.db, reply("qual o valor?"))).toBe("disabled");
  });
});
