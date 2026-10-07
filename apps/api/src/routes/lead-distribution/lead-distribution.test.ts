import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})), getOrganizationById: vi.fn(), getSalesRepByUser: vi.fn(), listSalesReps: vi.fn(),
  setRepAvailability: vi.fn(), acceptAssignment: vi.fn(), listOpenExceptions: vi.fn(), manualAssignLead: vi.fn(),
  listAssignmentsForContact: vi.fn(), listSlaAlerts: vi.fn(), computeSlaDueAt: vi.fn(() => new Date("2026-10-05T12:15:00Z")),
}));
vi.mock("@aula-agente/database", () => m);
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async () => {} }));
import Fastify from "fastify";
import routes from "./index.js";

async function app(role: string, userId = "u1") {
  const f = Fastify();
  f.addHook("preHandler", async (req: any) => { req.user = { id: userId, email: "x", memberships: [{ organization_id: "org", role }] }; req.userRole = role; });
  await f.register(routes);
  return f;
}
beforeEach(() => { vi.clearAllMocks(); m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } }); });

describe("PATCH availability", () => {
  it("vendedor muda o próprio estado", async () => {
    m.getSalesRepByUser.mockResolvedValue({ id: "rep1", user_id: "u1" });
    m.setRepAvailability.mockResolvedValue({ id: "rep1", availability: "paused" });
    const res = await (await app("agent")).inject({ method: "PATCH", url: "/organizations/org/sales-reps/rep1/availability", payload: { availability: "paused" } });
    expect(res.statusCode).toBe(200);
    expect(m.setRepAvailability).toHaveBeenCalledWith(expect.anything(), { organizationId: "org", repId: "rep1", availability: "paused" });
  });
  it("vendedor não muda o estado de outro; gestor muda", async () => {
    m.getSalesRepByUser.mockResolvedValue({ id: "repX", user_id: "u1" });
    expect((await (await app("agent")).inject({ method: "PATCH", url: "/organizations/org/sales-reps/rep1/availability", payload: { availability: "out" } })).statusCode).toBe(403);
    m.setRepAvailability.mockResolvedValue({ id: "rep1" });
    expect((await (await app("admin")).inject({ method: "PATCH", url: "/organizations/org/sales-reps/rep1/availability", payload: { availability: "out" } })).statusCode).toBe(200);
  });
  it("recusa valor inválido", async () => {
    const res = await (await app("admin")).inject({ method: "PATCH", url: "/organizations/org/sales-reps/rep1/availability", payload: { availability: "ferias" } });
    expect(res.statusCode).toBe(400);
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
