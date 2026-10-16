import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";

// Todo áudio recebido do cliente é enfileirado para captura, mesmo com atendimento humano ativo
// ou IA desativada, e falha ao enfileirar nunca derruba o recebimento.
delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), getIgnoredContact: vi.fn(), ensureConversation: vi.fn(), saveMessage: vi.fn(),
  enqueueProcessMessage: vi.fn(), enqueueStoreCustomerAudio: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  resolveUnresponsiveTasksOnReply: async () => undefined,
  getInstanceByInstanceId: m.getInstanceByInstanceId,
  getIgnoredContact: m.getIgnoredContact,
  updateConversation: async () => undefined, createHandoffEvent: async () => undefined, getOrganizationById: async () => ({ settings: {} }),
  getOpenHandoffEvent: async () => null, markFirstHumanReply: async () => undefined,
  findPendingOutboundMessages: async () => [], setMessageEvolutionId: async () => undefined,
  upsertContact: async () => undefined,
}));
vi.mock("../../services/conversation.service.js", () => ({ ensureConversation: m.ensureConversation }));
vi.mock("../../services/message.service.js", () => ({ saveMessage: m.saveMessage }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: async () => undefined }));
vi.mock("../../services/lead-origin.service.js", () => ({ recordLeadOrigin: async () => undefined }));
vi.mock("../../services/lead-human-message.js", () => ({ trackFirstHumanMessage: async () => undefined }));
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: m.enqueueProcessMessage, enqueueStoreCustomerAudio: m.enqueueStoreCustomerAudio }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: async () => undefined }));

const audio = {
  event: "messages.upsert", instance: "inst",
  data: { key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: false, id: "evo-1" }, message: { audioMessage: { seconds: 7 } }, messageType: "audioMessage" },
};
const text = { ...audio, data: { ...audio.data, message: { conversation: "oi" }, messageType: "conversation" } };

async function post(payload: unknown) {
  const app = Fastify(); await app.register(evolutionWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: payload as any }); await app.close(); return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", organization_id: "org-1", active_agent_id: "agent-1" });
  m.getIgnoredContact.mockResolvedValue(null);
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false }, contact: { id: "c1", ai_disabled: false }, isNew: false });
  m.saveMessage.mockResolvedValue({ id: "msg-1", role: "contact", created_at: "2026-10-16T12:00:00Z" });
  m.enqueueStoreCustomerAudio.mockResolvedValue(undefined);
});

describe("webhook: captura de áudio do cliente", () => {
  it("enfileira a captura e segue o fluxo normal da IA", async () => {
    const r = await post(audio);
    expect(r.statusCode).toBe(200);
    expect(m.enqueueStoreCustomerAudio).toHaveBeenCalledWith({ messageId: "msg-1", conversationId: "conv-1", organizationId: "org-1" });
    expect(m.enqueueProcessMessage).toHaveBeenCalled();
  });

  it("enfileira mesmo com atendimento humano ativo", async () => {
    m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: true }, contact: { id: "c1", ai_disabled: false }, isNew: false });
    const r = await post(audio);
    expect(r.json()).toMatchObject({ skipped: "human_takeover" });
    expect(m.enqueueStoreCustomerAudio).toHaveBeenCalledTimes(1);
    expect(m.enqueueProcessMessage).not.toHaveBeenCalled();
  });

  it("enfileira mesmo com IA desativada para o contato", async () => {
    m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false }, contact: { id: "c1", ai_disabled: true }, isNew: false });
    await post(audio);
    expect(m.enqueueStoreCustomerAudio).toHaveBeenCalledTimes(1);
  });

  it("falha ao enfileirar não derruba o recebimento nem a IA", async () => {
    m.enqueueStoreCustomerAudio.mockRejectedValue(new Error("redis down"));
    const r = await post(audio);
    expect(r.statusCode).toBe(200);
    expect(m.enqueueProcessMessage).toHaveBeenCalled();
  });

  it("não enfileira para mensagem de texto, webhook duplicado nem contato ignorado (minimal_record)", async () => {
    await post(text);
    m.saveMessage.mockResolvedValue(null); await post(audio);
    m.saveMessage.mockResolvedValue({ id: "msg-2", role: "contact", created_at: "x" });
    m.getIgnoredContact.mockResolvedValue({ retention_mode: "minimal_record" }); await post(audio);
    expect(m.enqueueStoreCustomerAudio).not.toHaveBeenCalled();
  });
});
