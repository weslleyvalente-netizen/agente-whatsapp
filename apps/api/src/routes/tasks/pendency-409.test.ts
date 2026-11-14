import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// pendency_type que a tarefa não tem: 409 e NADA é alterado — mesmo quando resta uma só pendência (antes virava conclusão da tarefa inteira).
const m = vi.hoisted(() => ({
  getTaskById: vi.fn(), updateTask: vi.fn(), addTaskEvent: vi.fn(), closeSinglePendency: vi.fn(), reschedulePendency: vi.fn(), getOpenTasksByConversation: vi.fn(),
  getOrganizationById: vi.fn(), getConversationById: vi.fn(), getQualificationByConversationId: vi.fn(), listSalesReps: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({ ...m, getAdminClient: () => ({}), decryptCpf: vi.fn() }));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey: vi.fn(), generateTaskFollowupSuggestion: vi.fn() }));
vi.mock("../../services/task-followup.service.js", () => ({ resolveTaskFollowupEligibility: vi.fn(), sendTaskFollowup: vi.fn(), getFollowupTouchInfo: vi.fn() }));
vi.mock("../../services/followup-audio-context.service.js", () => ({ prepareFollowupAudioContext: vi.fn() }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "marina", memberships: [{ organization_id: "org-1", role: "agent" }] }; } }));
import routes from "./index.js";

const notFound = () => Object.assign(new Error("A tarefa não tem a pendência run_quote."), { name: "PendencyNotFoundError" });
const post = async (url: string, body: object) => { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "POST", url, payload: body }); await app.close(); return r; };

beforeEach(() => {
  vi.clearAllMocks();
  m.getTaskById.mockResolvedValue({ id: "t1", organization_id: "org-1", contact_id: "c", opportunity_id: null, type: "return_customer", consolidated_pendencies: [] });
  m.closeSinglePendency.mockRejectedValue(notFound()); m.reschedulePendency.mockRejectedValue(notFound());
});
describe("pendency_type inexistente", () => {
  it.each([["complete", {}], ["cancel", {}], ["reschedule", { due_date: "2026-11-20" }]])("%s: 409 e nenhuma escrita", async (action, extra) => {
    const r = await post(`/tasks/t1/${action}`, { pendency_type: "run_quote", ...extra });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("não tem a pendência");
    expect(m.updateTask).not.toHaveBeenCalled(); expect(m.addTaskEvent).not.toHaveBeenCalled();
  });
});
