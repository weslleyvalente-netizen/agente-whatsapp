import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  assignmentOrg: { value: "org" as string | null },
  getAdminClient: vi.fn(() => ({ from: () => { const c: any = { select: () => c, eq: () => c, maybeSingle: async () => ({ data: m.assignmentOrg.value ? { organization_id: m.assignmentOrg.value } : null, error: null }) }; return c; } })), getOrganizationById: vi.fn(), getSalesRepByUser: vi.fn(), listSalesReps: vi.fn(),
  setRepAvailability: vi.fn(), acceptAssignment: vi.fn(), listOpenExceptions: vi.fn(), manualAssignLead: vi.fn(),
  listAssignmentsForContact: vi.fn(), listSlaAlerts: vi.fn(), computeSlaDueAt: vi.fn(() => new Date("2026-10-05T12:15:00Z")),
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
    m.listSlaAlerts.mockResolvedValue([{ id: "s1" }]);
    expect((await (await app("admin")).inject({ method: "GET", url: "/organizations/org/lead-assignments/sla-alerts" })).json()).toEqual([{ id: "s1" }]);
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
