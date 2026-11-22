import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
const m = vi.hoisted(() => ({
  role: { value: "admin" }, getOrganizationById: vi.fn(), getOpportunitiesByOrganization: vi.fn(), enrichSalesWorkspace: vi.fn(), loadUrgentSources: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({ getAdminClient: () => ({}), getOrganizationById: m.getOrganizationById, getOpportunitiesByOrganization: m.getOpportunitiesByOrganization, listSalesReps: vi.fn(), decryptCpf: vi.fn(), getUnidentifiedSalesContacts: vi.fn() }));
vi.mock("../../services/sales-workspace.service.js", () => ({ enrichSalesWorkspace: m.enrichSalesWorkspace, getSalesTasksWithoutOpenBusiness: vi.fn(), attachContactState: vi.fn() }));
vi.mock("../../services/urgent-cards.service.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), loadUrgentSources: m.loadUrgentSources }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "u", memberships: [{ organization_id: "org-1", role: m.role.value }] }; } }));
import routes from "./index.js";

async function get(url: string) { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "GET", url }); await app.close(); return r; }
const card = (contact: string, o: Record<string, unknown> = {}) => ({ id: `op-${contact}`, contact_id: contact, status: "open", created_at: "2026-11-01", stage: "qualification", waiting_on: null, next_action_due_date: null, sales_state: { readyForHuman: false, customerReplied: false, humanPending: false, taskCount: 0 }, ...o });
const recent = new Date(Date.now() - 60 * 60_000).toISOString();
const assignment = (contact: string) => ({ contact_id: contact, conversation_id: `conv-${contact}`, handoff_at: recent, assigned_at: recent, reason: "round_robin" });

beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "admin";
  m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } }); // urgent_cards_enabled desligada
  m.getOpportunitiesByOrganization.mockResolvedValue([card("a"), card("b")]);
  m.enrichSalesWorkspace.mockImplementation(async (_db: unknown, _org: string, rows: unknown[]) => rows);
});

describe("GET /organizations/:id/urgent-coverage", () => {
  it("usa o pipeline do funil (cards enriquecidos, visão de gestor) e prova urgente na fila certa mesmo com a flag desligada", async () => {
    m.loadUrgentSources.mockResolvedValue({ alerts: [assignment("a")], exceptions: [assignment("sem-negocio")], promises: [] });
    const r = await get("/organizations/org-1/urgent-coverage");
    expect(r.statusCode).toBe(200);
    expect(m.enrichSalesWorkspace).toHaveBeenCalledWith({}, "org-1", expect.any(Array), true, { enabled: true, viewer: { mode: "all" } });
    expect(r.json()).toEqual({ total: 2, covered: 1, urgentCardsEnabled: false,
      uncovered: [{ contactId: "sem-negocio", conversationId: "conv-sem-negocio", reason: "exception", problem: "no_open_card" }] });
  });
  it("vendedor não acessa", async () => {
    m.role.value = "agent";
    m.loadUrgentSources.mockResolvedValue({ alerts: [], exceptions: [], promises: [] });
    expect((await get("/organizations/org-1/urgent-coverage")).statusCode).toBe(403);
  });
});
