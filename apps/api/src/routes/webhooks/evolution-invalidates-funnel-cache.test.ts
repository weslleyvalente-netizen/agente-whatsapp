import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";

// A mensagem recebida (do cliente ou eco do celular) descarta o cache do funil da organização.
delete process.env.WEBHOOK_SECRET;
const invalidate = vi.fn();
vi.mock("../../services/sales-workspace.service.js", () => ({ invalidateSalesWorkspaceCache: (...a: unknown[]) => invalidate(...a) }));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  resolveUnresponsiveTasksOnReply: async () => undefined,
  getInstanceByInstanceId: async () => ({ id: "i", organization_id: "org-1", active_agent_id: "agent-1" }),
  updateConversation: async () => undefined,
  getIgnoredContact: async () => null,
  createHandoffEvent: async () => ({ id: "h" }),
  getOrganizationById: async () => ({ id: "org-1", settings: {} }),
  getOpenHandoffEvent: async () => null,
  markFirstHumanReply: async () => undefined,
  findPendingOutboundMessages: async () => [],
  setMessageEvolutionId: async () => undefined,
  recordHumanMessage: async () => null,
}));
const saveMessage = vi.fn();
vi.mock("../../services/conversation.service.js", () => ({ ensureConversation: async () => ({ conversation: { id: "conv-1", is_human_takeover: false }, contact: { id: "c1", ai_disabled: true }, isNew: false }) }));
vi.mock("../../services/message.service.js", () => ({ saveMessage: (...a: unknown[]) => saveMessage(...a) }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: async () => undefined }));
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: async () => undefined }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: async () => undefined }));

const payload = (fromMe: boolean) => ({ event: "messages.upsert", instance: "instance-name", data: { key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe, id: "evo-1" }, message: { conversation: "Quero a proposta" }, messageType: "conversation" } });
async function post(fromMe: boolean) {
  const app = Fastify(); await app.register(evolutionWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: payload(fromMe) }); await app.close(); return r;
}
beforeEach(() => { vi.clearAllMocks(); });

describe("webhook da Evolution invalida o cache do funil", () => {
  it("mensagem do cliente gravada invalida a organização", async () => {
    saveMessage.mockResolvedValue({ id: "m1" });
    expect((await post(false)).statusCode).toBe(200);
    expect(invalidate).toHaveBeenCalledWith("org-1");
  });
  it("mensagem duplicada não invalida", async () => {
    saveMessage.mockResolvedValue(null);
    await post(false);
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("eco do celular (fromMe) gravado invalida a organização", async () => {
    saveMessage.mockResolvedValue({ id: "m2" });
    await post(true);
    expect(invalidate).toHaveBeenCalledWith("org-1");
  });
});
