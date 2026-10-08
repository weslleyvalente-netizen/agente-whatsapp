import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
const m = vi.hoisted(() => ({
  role: { value: "agent" }, flag: { value: true },
  getOpportunityById: vi.fn(), getContactById: vi.fn(), getQualificationByConversationId: vi.fn(), getOpportunityEvents: vi.fn(), getOpenTasksByContact: vi.fn(),
  getOrganizationById: vi.fn(), listSalesReps: vi.fn(), getSalesTasksWithoutOpenBusiness: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({ ...m, getAdminClient: () => ({ from: () => { const c: any = { select: () => c, eq: () => c, order: () => c, limit: () => c, maybeSingle: async () => ({ data: null, error: null }) }; return c; } }), decryptCpf: vi.fn(), getUnidentifiedSalesContacts: vi.fn() }));
vi.mock("../../services/sales-workspace.service.js", () => ({ enrichSalesWorkspace: vi.fn(), getSalesTasksWithoutOpenBusiness: m.getSalesTasksWithoutOpenBusiness }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "marina-user", memberships: [{ organization_id: "org-1", role: m.role.value }] }; } }));
import routes from "./index.js";
const reps = [{ user_id: "marina-user" }, { user_id: "marcio-user" }];
async function get(url: string) { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "GET", url }); await app.close(); return r; }
beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "agent"; m.flag.value = true;
  m.getOrganizationById.mockImplementation(async () => ({ settings: { lead_distribution_enabled: m.flag.value, sales_action_queue_enabled: true } }));
  m.listSalesReps.mockResolvedValue(reps);
  m.getContactById.mockResolvedValue({ id: "c", organization_id: "org-1", name: "Ana", phone: "1" });
  m.getOpportunityEvents.mockResolvedValue([]); m.getOpenTasksByContact.mockResolvedValue([]);
});
describe("opportunity details visibility", () => {
  const opp = (owner: string | null) => m.getOpportunityById.mockResolvedValue({ id: "o", organization_id: "org-1", contact_id: "c", owner_id: owner });
  it("vendedor não vê o lead de outro vendedor", async () => {
    opp("marcio-user"); const r = await get("/opportunities/o/details");
    expect(r.statusCode).toBe(403); expect(r.json()).toEqual({ error: "Este lead pertence a outro vendedor" }); expect(m.getContactById).not.toHaveBeenCalled();
  });
  it.each([["próprio", "marina-user"], ["sem dono", null], ["dono legado", "conta-compartilhada"]])("vendedor vê o lead %s", async (_l, owner) => {
    opp(owner as any); expect((await get("/opportunities/o/details")).statusCode).toBe(200);
  });
  it("gestor vê tudo", async () => { m.role.value = "admin"; opp("marcio-user"); expect((await get("/opportunities/o/details")).statusCode).toBe(200); });
  it("com a flag desligada nada é restrito", async () => { m.flag.value = false; opp("marcio-user"); expect((await get("/opportunities/o/details")).statusCode).toBe(200); });
});
describe("pending-tasks visibility", () => {
  const tasks = [{ id: "t1", assignee_id: "marcio-user" }, { id: "t2", assignee_id: "marina-user" }, { id: "t3", assignee_id: null }, { id: "t4", assignee_id: "legado" }];
  beforeEach(() => m.getSalesTasksWithoutOpenBusiness.mockResolvedValue(tasks));
  it("vendedor não vê tarefa de outro vendedor", async () => {
    expect((await get("/organizations/org-1/opportunities/pending-tasks")).json().map((t: any) => t.id)).toEqual(["t2", "t3", "t4"]);
  });
  it("gestor e flag desligada veem tudo", async () => {
    m.role.value = "owner"; expect((await get("/organizations/org-1/opportunities/pending-tasks")).json()).toHaveLength(4);
    m.role.value = "agent"; m.flag.value = false; expect((await get("/organizations/org-1/opportunities/pending-tasks")).json()).toHaveLength(4);
  });
});
