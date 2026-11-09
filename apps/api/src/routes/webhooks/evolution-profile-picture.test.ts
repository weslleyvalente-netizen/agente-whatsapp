import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";
import { lidPhoneResolver } from "../../services/lid-phone-map.js";

// Após reconexão o Evolution entrega remoteJid "<n>@lid" e o número real em remoteJidAlt.
delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), getIgnoredContact: vi.fn(), ensureConversation: vi.fn(), saveMessage: vi.fn(),
  enqueueProcessMessage: vi.fn(), findMessagesByRemoteJid: vi.fn(), enqueueFetchProfilePicture: vi.fn(),
}));
vi.mock("../../services/evolution.service.js", () => ({ findMessagesByRemoteJid: m.findMessagesByRemoteJid }));
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
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: m.enqueueProcessMessage, enqueueStoreCustomerAudio: async () => undefined, enqueueFetchProfilePicture: m.enqueueFetchProfilePicture }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: async () => undefined }));

const payload = (key: Record<string, unknown>) => ({
  event: "messages.upsert", instance: "inst",
  data: { key: { fromMe: false, id: "evo-1", ...key }, message: { conversation: "oi" }, messageType: "conversation" },
});
async function post(p: unknown) {
  const app = Fastify(); await app.register(evolutionWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: p as any }); await app.close(); return r;
}
const contactRow = (over: Record<string, unknown> = {}) => ({ id: "c1", phone: "5511999990000", ai_disabled: false, profile_picture_path: null, profile_picture_checked_at: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  lidPhoneResolver.reset();
  m.findMessagesByRemoteJid.mockResolvedValue([]);
  m.enqueueFetchProfilePicture.mockResolvedValue(undefined);
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", instance_name: "inst-name", organization_id: "org-1", active_agent_id: "agent-1" });
  m.getIgnoredContact.mockResolvedValue(null);
  m.saveMessage.mockResolvedValue({ id: "msg-1", role: "contact", created_at: "2026-11-06T15:00:00Z" });
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false }, contact: contactRow(), isNew: false });
});

const key = { remoteJid: "5511999990000@s.whatsapp.net" };

describe("webhook: busca da foto de perfil", () => {
  it("contato novo com telefone numerico enfileira a busca", async () => {
    await post(payload(key));
    expect(m.enqueueFetchProfilePicture).toHaveBeenCalledWith({
      contactId: "c1", organizationId: "org-1", instanceId: "i1", phone: "5511999990000",
    });
  });

  it("contato sem a chave profile_picture_checked_at (migration nao rodada): nao enfileira", async () => {
    const { profile_picture_checked_at: _omit, ...withoutKey } = contactRow({});
    m.ensureConversation.mockResolvedValue({
      conversation: { id: "conv-1", is_human_takeover: false }, contact: withoutKey, isNew: false,
    });
    await post(payload(key));
    expect(m.enqueueFetchProfilePicture).not.toHaveBeenCalled();
  });

  it("chave presente com null (nunca buscado): enfileira", async () => {
    m.ensureConversation.mockResolvedValue({
      conversation: { id: "conv-1", is_human_takeover: false },
      contact: contactRow({ profile_picture_path: null, profile_picture_checked_at: null }), isNew: false,
    });
    await post(payload(key));
    expect(m.enqueueFetchProfilePicture).toHaveBeenCalledTimes(1);
  });

  it("checado ha 1 h sem foto: nao enfileira", async () => {
    m.ensureConversation.mockResolvedValue({
      conversation: { id: "conv-1", is_human_takeover: false },
      contact: contactRow({ profile_picture_path: null, profile_picture_checked_at: new Date(Date.now() - 3600_000).toISOString() }),
      isNew: false,
    });
    await post(payload(key));
    expect(m.enqueueFetchProfilePicture).not.toHaveBeenCalled();
  });

  it("telefone @lid: nao enfileira", async () => {
    m.ensureConversation.mockResolvedValue({
      conversation: { id: "conv-1", is_human_takeover: false }, contact: contactRow({ phone: "90000000000001@lid" }), isNew: false,
    });
    await post(payload({ remoteJid: "90000000000001@lid" }));
    expect(m.enqueueFetchProfilePicture).not.toHaveBeenCalled();
  });

  it("contato ignorado (no_store e minimal_record): nao enfileira", async () => {
    m.getIgnoredContact.mockResolvedValue({ retention_mode: "no_store" });
    await post(payload(key));
    m.getIgnoredContact.mockResolvedValue({ retention_mode: "minimal_record" });
    await post(payload({ ...key, id: "evo-2" }));
    expect(m.enqueueFetchProfilePicture).not.toHaveBeenCalled();
  });

  it("eco fromMe (role nao contact): nao enfileira", async () => {
    m.saveMessage.mockResolvedValue({ id: "msg-2", role: "user", created_at: "2026-11-06T15:00:00Z" });
    await post(payload({ ...key, fromMe: true }));
    expect(m.enqueueFetchProfilePicture).not.toHaveBeenCalled();
  });

  it("falha ao enfileirar: responde 200 e salva a mensagem", async () => {
    m.enqueueFetchProfilePicture.mockRejectedValue(new Error("redis fora"));
    const r = await post(payload(key));
    expect(r.statusCode).toBe(200);
    expect(m.saveMessage).toHaveBeenCalled();
  });
});
