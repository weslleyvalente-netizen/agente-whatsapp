import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";

// Após reconexão o Evolution entrega remoteJid "<n>@lid" e o número real em remoteJidAlt.
delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), getIgnoredContact: vi.fn(), ensureConversation: vi.fn(), saveMessage: vi.fn(),
  enqueueProcessMessage: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  resolveUnresponsiveTasksOnReply: async () => undefined,
  getInstanceByInstanceId: m.getInstanceByInstanceId,
  getIgnoredContact: m.getIgnoredContact,
  updateConversation: async () => undefined, createHandoffEvent: async () => ({ id: "h" }),
  getOrganizationById: async () => ({ settings: {} }),
  getOpenHandoffEvent: async () => null, markFirstHumanReply: async () => undefined,
  findPendingOutboundMessages: async () => [], setMessageEvolutionId: async () => undefined,
  stampMessageMetadata: async () => undefined, upsertContact: async () => undefined,
}));
vi.mock("../../services/conversation.service.js", () => ({ ensureConversation: m.ensureConversation }));
vi.mock("../../services/message.service.js", () => ({ saveMessage: m.saveMessage }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: async () => undefined }));
vi.mock("../../services/lead-origin.service.js", () => ({ recordLeadOrigin: async () => undefined }));
vi.mock("../../services/lead-human-message.js", () => ({ trackFirstHumanMessage: async () => undefined }));
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: m.enqueueProcessMessage, enqueueStoreCustomerAudio: async () => undefined }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: async () => undefined }));

const payload = (key: Record<string, unknown>) => ({
  event: "messages.upsert", instance: "inst",
  data: { key: { fromMe: false, id: "evo-1", ...key }, message: { conversation: "oi" }, messageType: "conversation" },
});
const lidKey = { remoteJid: "85801266339926@lid", participant: "", remoteJidAlt: "556296818769@s.whatsapp.net", addressingMode: "lid" };
async function post(p: unknown) {
  const app = Fastify(); await app.register(evolutionWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: p as any }); await app.close(); return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", organization_id: "org-1", active_agent_id: "agent-1" });
  m.getIgnoredContact.mockResolvedValue(null);
  m.saveMessage.mockResolvedValue({ id: "msg-1", role: "contact", created_at: "2026-11-06T15:00:00Z" });
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false }, contact: { id: "c1", ai_disabled: false }, isNew: false });
});

describe("webhook: contato entregue como @lid", () => {
  it("@lid com alt de número ignorado (no_store) -> ignored_contact e nada gravado", async () => {
    m.getIgnoredContact.mockImplementation(async (_db: unknown, _org: string, phone: string) =>
      phone === "556296818769" ? { retention_mode: "no_store" } : null);
    const r = await post(payload(lidKey));
    expect(r.json()).toMatchObject({ skipped: "ignored_contact" });
    expect(m.getIgnoredContact).toHaveBeenCalledWith({}, "org-1", "556296818769");
    expect(m.ensureConversation).not.toHaveBeenCalled();
    expect(m.saveMessage).not.toHaveBeenCalled();
  });

  it("@lid com alt de número normal -> ensureConversation recebe o número real", async () => {
    await post(payload(lidKey));
    expect(m.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({ phone: "556296818769" }));
  });

  it("eco fromMe com @lid também usa o número real", async () => {
    await post(payload({ ...lidKey, fromMe: true }));
    expect(m.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({ phone: "556296818769" }));
  });

  it("payload antigo sem remoteJidAlt segue igual", async () => {
    await post(payload({ remoteJid: "5511999990000@s.whatsapp.net" }));
    expect(m.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({ phone: "5511999990000" }));
  });

  it("@lid sem alt mantém o remoteJid (comportamento atual)", async () => {
    await post(payload({ remoteJid: "85801266339926@lid" }));
    expect(m.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({ phone: "85801266339926@lid" }));
  });
});
