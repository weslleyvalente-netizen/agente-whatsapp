import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
const m = vi.hoisted(() => ({
  role: { value: "agent" }, listOpenOpportunitiesForConversation: vi.fn(), getOrganizationById: vi.fn(), listSalesReps: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  ...m, getAdminClient: () => ({}), decryptCpf: vi.fn(), getUnidentifiedSalesContacts: vi.fn(), getOpportunityById: vi.fn(), getContactById: vi.fn(),
  getQualificationByConversationId: vi.fn(), getOpportunityEvents: vi.fn(), getOpenTasksByContact: vi.fn(),
}));
vi.mock("../../services/sales-workspace.service.js", () => ({ enrichSalesWorkspace: vi.fn(), getSalesTasksWithoutOpenBusiness: vi.fn() }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "marina-user", memberships: [{ organization_id: "org-1", role: m.role.value }] }; } }));
import routes from "./index.js";
const CONV = "3f2b8c1e-5d4a-4e9b-8a7c-1234567890ab";
async function get(url: string) { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "GET", url }); await app.close(); return r; }
const opp = (id: string, owner: string | null, at: string | null) => ({ id, owner_id: owner, last_interaction_at: at });
beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "agent";
  m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } });
  m.listSalesReps.mockResolvedValue([{ user_id: "marina-user" }, { user_id: "marcio-user" }]);
});
describe("funnel-target", () => {
  it("devolve o negócio aberto do contato, filtrando pela organização", async () => {
    m.listOpenOpportunitiesForConversation.mockResolvedValue([opp("o1", "marina-user", "2026-01-01")]);
    const r = await get(`/organizations/org-1/conversations/${CONV}/funnel-target`);
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ opportunity_id: "o1" });
    expect(m.listOpenOpportunitiesForConversation).toHaveBeenCalledWith(expect.anything(), "org-1", CONV);
  });
  it("com vários abertos, prefere o com dono e interação mais recente", async () => {
    m.listOpenOpportunitiesForConversation.mockResolvedValue([opp("sem-dono", null, "2026-05-01"), opp("antigo", "marina-user", "2026-01-01"), opp("recente", "marina-user", "2026-03-01")]);
    expect((await get(`/organizations/org-1/conversations/${CONV}/funnel-target`)).json()).toEqual({ opportunity_id: "recente" });
  });
  it("sem negócio aberto devolve null", async () => {
    m.listOpenOpportunitiesForConversation.mockResolvedValue([]);
    expect((await get(`/organizations/org-1/conversations/${CONV}/funnel-target`)).json()).toEqual({ opportunity_id: null });
  });
  it("vendedor não recebe o negócio de outro vendedor", async () => {
    m.listOpenOpportunitiesForConversation.mockResolvedValue([opp("o1", "marcio-user", "2026-01-01")]);
    expect((await get(`/organizations/org-1/conversations/${CONV}/funnel-target`)).json()).toEqual({ opportunity_id: null });
  });
  it("gestor recebe o negócio de qualquer vendedor", async () => {
    m.role.value = "admin"; m.listOpenOpportunitiesForConversation.mockResolvedValue([opp("o1", "marcio-user", "2026-01-01")]);
    expect((await get(`/organizations/org-1/conversations/${CONV}/funnel-target`)).json()).toEqual({ opportunity_id: "o1" });
  });
  it("nega outra organização sem consultar nada", async () => {
    const r = await get(`/organizations/org-2/conversations/${CONV}/funnel-target`);
    expect(r.statusCode).toBe(403); expect(m.listOpenOpportunitiesForConversation).not.toHaveBeenCalled();
  });
  it("rejeita conversa que não é UUID", async () => {
    const r = await get("/organizations/org-1/conversations/abc/funnel-target");
    expect(r.statusCode).toBe(400); expect(m.listOpenOpportunitiesForConversation).not.toHaveBeenCalled();
  });
});
