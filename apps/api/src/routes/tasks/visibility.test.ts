import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
const m = vi.hoisted(() => ({
  role: { value: "agent" }, flag: { value: true },
  getTaskById: vi.fn(), getConversationById: vi.fn(), getQualificationByConversationId: vi.fn(), getOrganizationById: vi.fn(), listSalesReps: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({ ...m, getAdminClient: () => ({}), decryptCpf: vi.fn() }));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey: vi.fn(), generateTaskFollowupSuggestion: vi.fn() }));
vi.mock("../../services/task.service.js", () => ({ completeTask: vi.fn(), rescheduleTask: vi.fn(), cancelTask: vi.fn(), updateTask: vi.fn(), startTask: vi.fn(), reopenTask: vi.fn() }));
vi.mock("../../services/task-followup.service.js", () => ({ resolveTaskFollowupEligibility: vi.fn(), sendTaskFollowup: vi.fn(), getFollowupTouchInfo: vi.fn() }));
vi.mock("../../services/followup-audio-context.service.js", () => ({ prepareFollowupAudioContext: vi.fn() }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "marina-user", memberships: [{ organization_id: "org-1", role: m.role.value }] }; } }));
import routes from "./index.js";
async function get() { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "GET", url: "/tasks/t/details" }); await app.close(); return r; }
const task = (assignee: string | null) => m.getTaskById.mockResolvedValue({ id: "t", organization_id: "org-1", assignee_id: assignee, conversation_id: null });
beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "agent"; m.flag.value = true;
  m.getOrganizationById.mockImplementation(async () => ({ settings: { lead_distribution_enabled: m.flag.value } }));
  m.listSalesReps.mockResolvedValue([{ user_id: "marina-user" }, { user_id: "marcio-user" }]);
});
describe("task details visibility", () => {
  it("vendedor não vê a tarefa de outro vendedor", async () => {
    task("marcio-user"); const r = await get();
    expect(r.statusCode).toBe(403); expect(r.json()).toEqual({ error: "Este lead pertence a outro vendedor" });
  });
  it.each([["própria", "marina-user"], ["sem responsável", null], ["responsável legado", "conta-compartilhada"]])("vendedor vê a tarefa %s", async (_l, a) => { task(a as any); expect((await get()).statusCode).toBe(200); });
  it("gestor vê tudo; flag desligada não restringe", async () => {
    task("marcio-user"); m.role.value = "admin"; expect((await get()).statusCode).toBe(200);
    m.role.value = "agent"; m.flag.value = false; expect((await get()).statusCode).toBe(200);
  });
});
