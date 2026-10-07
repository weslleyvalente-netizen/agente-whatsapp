import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
const m = vi.hoisted(() => ({
  role: { value: "agent" }, getOpenTasksWithScoreInputs: vi.fn(), getOrganizationById: vi.fn(), getPendingHandoffs: vi.fn(), listSalesReps: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({ ...m, getAdminClient: () => ({}) }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "marina-user", memberships: [{ organization_id: "org-1", role: m.role.value }] }; } }));
import routes from "./index.js";
const row = (id: string, assignee: string | null, owner?: string | null) => ({
  task: { id, type: "other", title: id, description: "", reason: null, priority: "medium", due_date: "2026-10-01", conversation_id: null, opportunity_id: owner !== undefined ? "o" : null, assignee_id: assignee, status: "pending" },
  contactName: null, contactPhone: "", opportunity: owner !== undefined ? { operation: "x", stage: "y", credit_amount: null, sale_amount: null, bid_amount: null, waiting_on: null, waiting_on_until: null, last_progress_at: null, last_interaction_at: null, created_at: "2026-10-01", owner_id: owner } : null, qualificationUrgency: null,
});
async function today() { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "GET", url: "/organizations/org-1/dashboard/today" }); await app.close(); return r.json().items.map((i: any) => i.taskId).sort(); }
beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "agent";
  m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } });
  m.getPendingHandoffs.mockResolvedValue([]);
  m.listSalesReps.mockResolvedValue([{ user_id: "marina-user" }, { user_id: "marcio-user" }]);
  m.getOpenTasksWithScoreInputs.mockResolvedValue([row("outra", "marcio-user"), row("minha", "marina-user"), row("livre", null), row("dono-outro", null, "marcio-user"), row("dono-meu", "marcio-user", "marina-user")]);
});
describe("dashboard/today visibility", () => {
  it("vendedor não recebe tarefas de outro vendedor (dono do negócio tem prioridade)", async () => {
    expect(await today()).toEqual(["dono-meu", "livre", "minha"]);
  });
  it("gestor recebe todas", async () => { m.role.value = "admin"; expect(await today()).toHaveLength(5); });
  it("flag desligada não restringe", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: false } }); expect(await today()).toHaveLength(5);
  });
});
