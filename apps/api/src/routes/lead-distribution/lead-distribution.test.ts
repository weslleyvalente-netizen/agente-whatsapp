import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  assignmentOrg: { value: "org" as string | null },
  getAdminClient: vi.fn(() => ({ from: () => { const c: any = { select: () => c, eq: () => c, maybeSingle: async () => ({ data: m.assignmentOrg.value ? { organization_id: m.assignmentOrg.value } : null, error: null }) }; return c; } })), getOrganizationById: vi.fn(), getSalesRepByUser: vi.fn(), listSalesReps: vi.fn(),
  setRepAvailability: vi.fn(), acceptAssignment: vi.fn(), listOpenExceptions: vi.fn(), manualAssignLead: vi.fn(),
  listAssignmentsForContact: vi.fn(), listSlaAlerts: vi.fn(), listContactsByIds: vi.fn(), getAssignmentForNudge: vi.fn(), getLastNudgeAt: vi.fn(), recordNudge: vi.fn(), sendPushToUser: vi.fn(), isPushConfigured: vi.fn(), claimPushDedupe: vi.fn(), releasePushDedupe: vi.fn(), computeSlaDueAt: vi.fn(() => new Date("2026-10-05T12:15:00Z")),
}));
vi.mock("@aula-agente/database", () => m);
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async () => {} }));
import Fastify from "fastify";
import routes from "./index.js";

async function app(role: string, userId = "u1", orgId = "org") {
  const f = Fastify();
  f.addHook("preHandler", async (req: any) => { req.user = { id: userId, email: "x", memberships: [{ organization_id: orgId, role }] }; req.userRole = role; });
  await f.register(routes);
  return f;
}
beforeEach(() => { vi.clearAllMocks(); m.assignmentOrg.value = "org"; m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } }); });

describe("PATCH availability", () => {
  const ORG = "22222222-2222-4222-8222-222222222222";
  const REP = "33333333-3333-4333-8333-333333333333";
  const OTHER = "44444444-4444-4444-8444-444444444444";
  const url = (org = ORG, rep = REP) => `/organizations/${org}/sales-reps/${rep}/availability`;
  it("vendedor muda o próprio estado", async () => {
    m.getSalesRepByUser.mockResolvedValue({ id: REP, user_id: "u1" });
    m.setRepAvailability.mockResolvedValue({ id: REP, availability: "paused" });
    const res = await (await app("agent", "u1", ORG)).inject({ method: "PATCH", url: url(), payload: { availability: "paused" } });
    expect(res.statusCode).toBe(200);
    expect(m.setRepAvailability).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, repId: REP, availability: "paused" });
  });
  it("vendedor não muda o estado de outro; gestor muda", async () => {
    m.getSalesRepByUser.mockResolvedValue({ id: OTHER, user_id: "u1" });
    expect((await (await app("agent", "u1", ORG)).inject({ method: "PATCH", url: url(), payload: { availability: "out" } })).statusCode).toBe(403);
    m.setRepAvailability.mockResolvedValue({ id: REP });
    expect((await (await app("admin", "u1", ORG)).inject({ method: "PATCH", url: url(), payload: { availability: "out" } })).statusCode).toBe(200);
  });
  it("recusa valor inválido", async () => {
    const res = await (await app("admin", "u1", ORG)).inject({ method: "PATCH", url: url(), payload: { availability: "ferias" } });
    expect(res.statusCode).toBe(400);
  });
  it("repId ou organizationId que não são UUID devolvem 400 sem tocar no banco", async () => {
    expect((await (await app("admin", "u1", ORG)).inject({ method: "PATCH", url: url(ORG, "rep1"), payload: { availability: "out" } })).statusCode).toBe(400);
    expect((await (await app("admin", "u1", "org")).inject({ method: "PATCH", url: url("org", REP), payload: { availability: "out" } })).statusCode).toBe(400);
    expect(m.setRepAvailability).not.toHaveBeenCalled();
    expect(m.getSalesRepByUser).not.toHaveBeenCalled();
  });
  it("vendedor inexistente devolve 404 em vez de 500", async () => {
    m.setRepAvailability.mockRejectedValue({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
    const res = await (await app("admin", "u1", ORG)).inject({ method: "PATCH", url: url(), payload: { availability: "out" } });
    expect(res.statusCode).toBe(404);
  });
  it("outro erro do banco continua 500", async () => {
    m.setRepAvailability.mockRejectedValue({ code: "XX000", message: "boom" });
    const res = await (await app("admin", "u1", ORG)).inject({ method: "PATCH", url: url(), payload: { availability: "out" } });
    expect(res.statusCode).toBe(500);
  });
});

describe("accept", () => {
  it("passa o ator e se é gestor", async () => {
    m.acceptAssignment.mockResolvedValue(true);
    const res = await (await app("agent")).inject({ method: "POST", url: "/lead-assignments/11111111-1111-4111-8111-111111111111/accept?organizationId=org" });
    expect(res.json()).toEqual({ accepted: true });
    expect(m.acceptAssignment).toHaveBeenCalledWith(expect.anything(), { assignmentId: "11111111-1111-4111-8111-111111111111", actorUserId: "u1", actorIsAdmin: false });
  });
  it("devolve 403 quando o banco recusa o ator", async () => {
    m.acceptAssignment.mockRejectedValue({ message: "Somente o vendedor atribuído (ou um admin) pode assumir o lead" });
    const res = await (await app("agent")).inject({ method: "POST", url: "/lead-assignments/11111111-1111-4111-8111-111111111111/accept?organizationId=org" });
    expect(res.statusCode).toBe(403);
  });
});

describe("accept: isolamento entre organizações", () => {
  const url = "/lead-assignments/11111111-1111-4111-8111-111111111111/accept?organizationId=org";
  it("admin de outra org não aceita a atribuição (ignora o parâmetro da query)", async () => {
    m.assignmentOrg.value = "other";
    const res = await (await app("admin")).inject({ method: "POST", url });
    expect(res.statusCode).toBe(403);
    expect(m.acceptAssignment).not.toHaveBeenCalled();
  });
  it("id desconhecido devolve 404", async () => {
    m.assignmentOrg.value = null;
    const res = await (await app("admin")).inject({ method: "POST", url });
    expect(res.statusCode).toBe(404);
    expect(m.acceptAssignment).not.toHaveBeenCalled();
  });
  it("membro da org correta, mesmo sem query, aceita", async () => {
    m.acceptAssignment.mockResolvedValue(true);
    const res = await (await app("admin")).inject({ method: "POST", url: "/lead-assignments/11111111-1111-4111-8111-111111111111/accept" });
    expect(res.json()).toEqual({ accepted: true });
    expect(m.acceptAssignment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorIsAdmin: true }));
  });
});

describe("não membro", () => {
  it("é barrado nas rotas de leitura e de gestor", async () => {
    const f = Fastify();
    f.addHook("preHandler", async (req: any) => { req.user = { id: "u9", email: "x", memberships: [{ organization_id: "outra", role: "owner" }] }; });
    await f.register(routes);
    for (const url of ["/organizations/org/sales-reps", "/organizations/org/lead-assignments/exceptions", "/organizations/org/lead-assignments/sla-alerts"]) {
      expect((await f.inject({ method: "GET", url })).statusCode).toBe(403);
    }
    expect((await f.inject({ method: "POST", url: "/organizations/org/lead-assignments/manual", payload: { conversationId: "11111111-1111-4111-8111-111111111111", repId: "22222222-2222-4222-8222-222222222222" } })).statusCode).toBe(403);
  });
  it("membro lê a lista de vendedores", async () => {
    m.listSalesReps.mockResolvedValue([{ id: "r" }]);
    expect((await (await app("agent")).inject({ method: "GET", url: "/organizations/org/sales-reps" })).json()).toEqual([{ id: "r" }]);
  });
});

describe("histórico do contato", () => {
  const ORG = "33333333-3333-4333-8333-333333333333", C = "44444444-4444-4444-8444-444444444444";
  const url = `/organizations/${ORG}/contacts/${C}/lead-assignments`;
  const f = async (role: string) => {
    const x = Fastify();
    x.addHook("preHandler", async (req: any) => { req.user = { id: "marina-user", email: "x", memberships: [{ organization_id: ORG, role }] }; });
    await x.register(routes); return x;
  };
  const reps = [{ id: "r1", user_id: "marina-user" }, { id: "r2", user_id: "marcio-user" }];
  beforeEach(() => { m.listSalesReps.mockResolvedValue(reps); });
  it("esconde o histórico do lead de outro vendedor", async () => {
    m.listAssignmentsForContact.mockResolvedValue([{ id: "h", rep_id: "r2" }]);
    expect((await (await f("agent")).inject({ method: "GET", url })).json()).toEqual([]);
  });
  it("mostra o próprio, o sem dono e o de quem já passou pelo vendedor", async () => {
    m.listAssignmentsForContact.mockResolvedValue([{ id: "h", rep_id: "r1" }]);
    expect((await (await f("agent")).inject({ method: "GET", url })).json()).toHaveLength(1);
    m.listAssignmentsForContact.mockResolvedValue([]);
    expect((await (await f("agent")).inject({ method: "GET", url })).json()).toEqual([]);
    m.listAssignmentsForContact.mockResolvedValue([{ id: "a", rep_id: "r1" }, { id: "b", rep_id: "r2" }]);
    expect((await (await f("agent")).inject({ method: "GET", url })).json()).toHaveLength(2);
  });
  it("sem linha em sales_reps, o histórico de outro vendedor segue oculto", async () => {
    m.listSalesReps.mockResolvedValue([{ id: "r2", user_id: "marcio-user" }]);
    m.listAssignmentsForContact.mockResolvedValue([{ id: "h", rep_id: "r2" }]);
    expect((await (await f("agent")).inject({ method: "GET", url })).json()).toEqual([]);
  });
  it("flag desligada ou gestor veem tudo", async () => {
    m.listAssignmentsForContact.mockResolvedValue([{ id: "h", rep_id: "r2" }]);
    m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: false } });
    expect((await (await f("agent")).inject({ method: "GET", url })).json()).toHaveLength(1);
    m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } });
    expect((await (await f("admin")).inject({ method: "GET", url })).json()).toHaveLength(1);
  });
  it("recusa ids que não são uuid", async () => {
    expect((await (await f("agent")).inject({ method: "GET", url: `/organizations/${ORG}/contacts/xx/lead-assignments` })).statusCode).toBe(400);
  });
});

describe("alertas de SLA (gestor)", () => {
  it("só gestor lê os atrasos de carteira", async () => {
    expect((await (await app("agent")).inject({ method: "GET", url: "/organizations/org/lead-assignments/sla-alerts" })).statusCode).toBe(403);
    m.listSlaAlerts.mockResolvedValue([{ id: "s1", contact_id: "c1" }]);
    m.listContactsByIds.mockResolvedValue([{ id: "c1", name: "Ana", phone: "5511" }]);
    expect((await (await app("admin")).inject({ method: "GET", url: "/organizations/org/lead-assignments/sla-alerts" })).json()).toEqual([{ id: "s1", contact_id: "c1", contact_name: "Ana", contact_phone: "5511" }]);
  });
  it("enriquece em lote: sem nome, @lid e contato não encontrado", async () => {
    m.listSlaAlerts.mockResolvedValue([{ id: "a", contact_id: "c1" }, { id: "b", contact_id: "c2" }, { id: "c", contact_id: "c3" }]);
    m.listContactsByIds.mockResolvedValue([{ id: "c1", name: null, phone: "5511999" }, { id: "c2", name: null, phone: "123@lid" }]);
    const res = (await (await app("admin")).inject({ method: "GET", url: "/organizations/org/lead-assignments/sla-alerts" })).json();
    expect(m.listContactsByIds).toHaveBeenCalledTimes(1);
    expect(m.listContactsByIds).toHaveBeenCalledWith(expect.anything(), "org", ["c1", "c2", "c3"]);
    expect(res.map((r: any) => [r.contact_name, r.contact_phone])).toEqual([[null, "5511999"], [null, "123@lid"], [null, null]]);
  });
  it("lista vazia não consulta contatos", async () => {
    m.listSlaAlerts.mockResolvedValue([]);
    expect((await (await app("admin")).inject({ method: "GET", url: "/organizations/org/lead-assignments/sla-alerts" })).json()).toEqual([]);
    expect(m.listContactsByIds).not.toHaveBeenCalled();
  });
});

describe("Cutucar vendedor (gestor)", () => {
  const ORG = "22222222-2222-4222-8222-222222222222";
  const AID = "55555555-5555-4555-8555-555555555555";
  const CONV = "66666666-6666-4666-8666-666666666666";
  const url = `/organizations/${ORG}/lead-assignments/${AID}/nudge`;
  const NOW = new Date("2026-11-09T12:00:00Z");
  const assignment = (over: Record<string, unknown> = {}) => ({ id: AID, conversation_id: CONV, contact_id: "c1", rep_id: "r1", status: "pending", sla_action: "alert", sla_breached: true, sla_due_at: "2026-11-09T09:30:00Z", assigned_at: "2026-11-09T08:30:00Z", ...over });
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    m.getAssignmentForNudge.mockResolvedValue(assignment());
    m.listSalesReps.mockResolvedValue([{ id: "r1", user_id: "ru1", display_name: "Marina" }]);
    m.listContactsByIds.mockResolvedValue([{ id: "c1", name: "Ana Souza", phone: "5511" }]);
    m.isPushConfigured.mockReturnValue(true);
    m.getLastNudgeAt.mockResolvedValue(null);
    m.claimPushDedupe.mockResolvedValue(true); m.releasePushDedupe.mockResolvedValue(undefined); m.recordNudge.mockResolvedValue(undefined);
    m.sendPushToUser.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("não gestor recebe 403 sem tocar no banco", async () => {
    expect((await (await app("agent", "u1", ORG)).inject({ method: "POST", url })).statusCode).toBe(403);
    expect(m.sendPushToUser).not.toHaveBeenCalled();
  });
  it("atribuição inexistente: 404", async () => {
    m.getAssignmentForNudge.mockResolvedValue(null);
    expect((await (await app("admin", "u1", ORG)).inject({ method: "POST", url })).statusCode).toBe(404);
  });
  it("não pendente: 409", async () => {
    for (const over of [{ status: "accepted" }, { sla_breached: false }, { sla_action: "redistribute" }]) {
      m.getAssignmentForNudge.mockResolvedValue(assignment(over));
      const res = await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("Este alerta não está mais pendente");
    }
  });
  it("vendedor sem usuário: 409", async () => {
    m.listSalesReps.mockResolvedValue([{ id: "r1", user_id: null, display_name: "Marina" }]);
    const res = await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/usuário/);
  });
  it("push não configurado: 503", async () => {
    m.isPushConfigured.mockReturnValue(false);
    expect((await (await app("admin", "u1", ORG)).inject({ method: "POST", url })).statusCode).toBe(503);
    expect(m.sendPushToUser).not.toHaveBeenCalled();
  });
  it("tocado há menos de 2 h: 429 com retryAfterMinutes", async () => {
    m.getLastNudgeAt.mockResolvedValue(new Date(NOW.getTime() - 90 * 60_000));
    const res = await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
    expect(res.statusCode).toBe(429);
    expect(res.json().retryAfterMinutes).toBe(30);
    expect(m.getLastNudgeAt).toHaveBeenCalledWith(expect.anything(), `nudge:${AID}:`);
    expect(m.sendPushToUser).not.toHaveBeenCalled();
  });
  it("tocado há mais de 2 h: libera", async () => {
    m.getLastNudgeAt.mockResolvedValue(new Date(NOW.getTime() - 121 * 60_000));
    expect((await (await app("admin", "u1", ORG)).inject({ method: "POST", url })).statusCode).toBe(200);
  });
  it("envia com título, corpo, url e tag, e registra o toque", async () => {
    const res = await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
    expect(res.json()).toEqual({ status: "sent", delivered: 1, nudgedAt: NOW.toISOString() });
    expect(m.sendPushToUser).toHaveBeenCalledWith(expect.anything(), "ru1", {
      title: "Cliente esperando resposta", body: "Marina, responda Ana Souza: prazo vencido há 2 h",
      url: `/opportunities?conversa=${CONV}`, tag: `nudge-${AID}`,
    }, { organizationId: ORG });
    expect(m.recordNudge).toHaveBeenCalledWith(expect.anything(), `nudge:${AID}:`, "ru1", NOW);
  });
  it("pedido simultâneo (trava já tomada): 429 sem enviar; a trava é liberada ao terminar", async () => {
    m.claimPushDedupe.mockResolvedValue(false);
    const res = await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
    expect(res.statusCode).toBe(429);
    expect(m.sendPushToUser).not.toHaveBeenCalled();
    m.claimPushDedupe.mockResolvedValue(true);
    expect((await (await app("admin", "u1", ORG)).inject({ method: "POST", url })).statusCode).toBe(200);
    expect(m.claimPushDedupe).toHaveBeenLastCalledWith(expect.anything(), `nudge-lock:nudge:${AID}:`, "ru1");
    expect(m.releasePushDedupe).toHaveBeenCalledWith(expect.anything(), [`nudge-lock:nudge:${AID}:`]);
  });
  it("trava liberada também quando o envio lança ou cai no 429", async () => {
    m.sendPushToUser.mockRejectedValue(new Error("x"));
    expect((await (await app("admin", "u1", ORG)).inject({ method: "POST", url })).statusCode).toBe(500);
    expect(m.releasePushDedupe).toHaveBeenCalledTimes(1);
    m.getLastNudgeAt.mockResolvedValue(new Date(NOW.getTime() - 60_000));
    await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
    expect(m.releasePushDedupe).toHaveBeenCalledTimes(2);
  });
  it("falha de envio (endpoints com erro) é distinguida de sem aparelho e não registra", async () => {
    m.sendPushToUser.mockResolvedValue({ sent: 0, removed: 0, failed: 2 });
    expect((await (await app("admin", "u1", ORG)).inject({ method: "POST", url })).json()).toEqual({ status: "failed", delivered: 0 });
    expect(m.recordNudge).not.toHaveBeenCalled();
  });
  it("falha ao gravar o toque depois de enviar: continua 200 sent", async () => {
    m.recordNudge.mockRejectedValue(new Error("db"));
    const res = await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("sent");
  });
  it("sem aparelho: devolve no_device e NÃO registra o toque", async () => {
    m.sendPushToUser.mockResolvedValue({ sent: 0, removed: 0, failed: 0 });
    const res = await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
    expect(res.json()).toEqual({ status: "no_device", delivered: 0 });
    expect(m.recordNudge).not.toHaveBeenCalled();
  });
});

describe("Cutucar todos (gestor)", () => {
  const ORG = "22222222-2222-4222-8222-222222222222";
  const url = `/organizations/${ORG}/lead-assignments/nudge-all`;
  const NOW = new Date("2026-11-09T12:00:00Z");
  const alert = (id: string, rep: string | null, contact: string) => ({ id, rep_id: rep, contact_id: contact, conversation_id: `conv-${id}`, sla_due_at: "2026-11-09T09:00:00Z", assigned_at: "2026-11-09T08:00:00Z" });
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    m.isPushConfigured.mockReturnValue(true);
    m.getLastNudgeAt.mockResolvedValue(null);
    m.claimPushDedupe.mockResolvedValue(true); m.releasePushDedupe.mockResolvedValue(undefined); m.recordNudge.mockResolvedValue(undefined);
    m.sendPushToUser.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
    m.listSalesReps.mockResolvedValue([
      { id: "r1", user_id: "ru1", display_name: "Marina" }, { id: "r2", user_id: "ru2", display_name: "Marcio" }, { id: "r3", user_id: null, display_name: "Sem User" },
    ]);
    m.listContactsByIds.mockResolvedValue(["a", "b", "c", "d", "e"].map((n) => ({ id: `c${n}`, name: `Cliente ${n}`, phone: "1" })));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("não gestor: 403; sem push: 503", async () => {
    expect((await (await app("agent", "u1", ORG)).inject({ method: "POST", url })).statusCode).toBe(403);
    m.isPushConfigured.mockReturnValue(false);
    expect((await (await app("admin", "u1", ORG)).inject({ method: "POST", url })).statusCode).toBe(503);
  });
  it("agrupa por vendedor, máximo 3 nomes e 'e mais N'", async () => {
    m.listSlaAlerts.mockResolvedValue([alert("1", "r1", "ca"), alert("2", "r1", "cb"), alert("3", "r1", "cc"), alert("4", "r1", "cd"), alert("5", "r1", "ce"), alert("6", "r2", "ca")]);
    const res = await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
    expect(res.json().results).toEqual([
      { repId: "r1", repName: "Marina", count: 5, status: "sent" }, { repId: "r2", repName: "Marcio", count: 1, status: "sent" },
    ]);
    expect(m.sendPushToUser).toHaveBeenCalledTimes(2);
    expect(m.sendPushToUser).toHaveBeenNthCalledWith(1, expect.anything(), "ru1", {
      title: "Cliente esperando resposta", body: "Marina, 5 clientes esperando resposta: Cliente a, Cliente b, Cliente c e mais 2", url: "/opportunities", tag: "nudge-rep-r1",
    }, { organizationId: ORG });
    expect(m.sendPushToUser.mock.calls[1][2].body).toBe("Marcio, 1 cliente esperando resposta: Cliente a");
    expect(m.recordNudge).toHaveBeenCalledWith(expect.anything(), "nudge-rep:r1:", "ru1", NOW);
  });
  it("falha de envio num vendedor aparece como failed e os demais seguem", async () => {
    m.listSlaAlerts.mockResolvedValue([alert("1", "r1", "ca"), alert("2", "r2", "cb")]);
    m.sendPushToUser.mockResolvedValueOnce({ sent: 0, removed: 0, failed: 1 }).mockResolvedValueOnce({ sent: 1, removed: 0, failed: 0 });
    const res = await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
    expect(res.json().results.map((r: any) => r.status)).toEqual(["failed", "sent"]);
  });
  it("resultado por vendedor: rate_limited, no_device e no_user", async () => {
    m.listSlaAlerts.mockResolvedValue([alert("1", "r1", "ca"), alert("2", "r2", "cb"), alert("3", "r3", "cc")]);
    m.getLastNudgeAt.mockImplementation(async (_db: unknown, prefix: string) => (prefix === "nudge-rep:r1:" ? new Date(NOW.getTime() - 60 * 60_000) : null));
    m.sendPushToUser.mockResolvedValue({ sent: 0, removed: 0, failed: 0 });
    const res = await (await app("admin", "u1", ORG)).inject({ method: "POST", url });
    expect(res.json().results).toEqual([
      { repId: "r1", repName: "Marina", count: 1, status: "rate_limited", retryAfterMinutes: 60 },
      { repId: "r2", repName: "Marcio", count: 1, status: "no_device" },
      { repId: "r3", repName: "Sem User", count: 1, status: "no_user" },
    ]);
    expect(m.recordNudge).not.toHaveBeenCalled();
  });
});

describe("fila de exceções e reatribuição manual (gestor)", () => {
  it("vendedor não acessa", async () => {
    expect((await (await app("agent")).inject({ method: "GET", url: "/organizations/org/lead-assignments/exceptions" })).statusCode).toBe(403);
    expect((await (await app("agent")).inject({ method: "POST", url: "/organizations/org/lead-assignments/manual", payload: { conversationId: "11111111-1111-4111-8111-111111111111", repId: "22222222-2222-4222-8222-222222222222" } })).statusCode).toBe(403);
  });
  it("gestor lista e reatribui com novo prazo", async () => {
    m.listOpenExceptions.mockResolvedValue([{ id: "e1" }]);
    expect((await (await app("admin")).inject({ method: "GET", url: "/organizations/org/lead-assignments/exceptions" })).json()).toEqual([{ id: "e1" }]);
    m.manualAssignLead.mockResolvedValue("a9");
    const res = await (await app("owner")).inject({ method: "POST", url: "/organizations/org/lead-assignments/manual", payload: { conversationId: "11111111-1111-4111-8111-111111111111", repId: "22222222-2222-4222-8222-222222222222" } });
    expect(res.json()).toEqual({ assignmentId: "a9" });
    expect(m.manualAssignLead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: "org", actorUserId: "u1", slaDueAt: new Date("2026-10-05T12:15:00Z") }));
  });
});
