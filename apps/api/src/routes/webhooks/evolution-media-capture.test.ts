import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";

// Imagem/vídeo/documento do cliente é enfileirado para captura; falha ao enfileirar nunca derruba o recebimento.
delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), getIgnoredContact: vi.fn(), ensureConversation: vi.fn(), saveMessage: vi.fn(),
  enqueueProcessMessage: vi.fn(), enqueueStoreCustomerAudio: vi.fn(), enqueueStoreChatMedia: vi.fn(),
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
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: m.enqueueProcessMessage, enqueueStoreCustomerAudio: m.enqueueStoreCustomerAudio, enqueueStoreChatMedia: m.enqueueStoreChatMedia }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: async () => undefined }));

const base = { event: "messages.upsert", instance: "inst" };
const key = { remoteJid: "5511999990000@s.whatsapp.net", fromMe: false, id: "evo-1" };
const image = { ...base, data: { key, message: { imageMessage: { caption: "foto" } }, messageType: "imageMessage" } };
const video = { ...base, data: { key, message: { videoMessage: {} }, messageType: "videoMessage" } };
const doc = { ...base, data: { key, message: { documentMessage: { fileName: "a.pdf" } }, messageType: "documentMessage" } };
const wrappedDoc = { ...base, data: { key, message: { documentWithCaptionMessage: { message: { documentMessage: { caption: "contrato", fileName: "a.pdf" } } } }, messageType: "documentWithCaptionMessage" } };
const wrappedDocNoCaption = { ...base, data: { key, message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "b.pdf" } } } }, messageType: "documentWithCaptionMessage" } };
const fromMeImage = { ...image, data: { ...image.data, key: { ...key, fromMe: true } } };
const text = { ...base, data: { key, message: { conversation: "oi" }, messageType: "conversation" } };
const expected = { messageId: "msg-1", conversationId: "conv-1", organizationId: "org-1" };

async function post(payload: unknown) {
  const app = Fastify(); await app.register(evolutionWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: payload as Record<string, unknown> }); await app.close(); return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", organization_id: "org-1", active_agent_id: "agent-1" });
  m.getIgnoredContact.mockResolvedValue(null);
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false }, contact: { id: "c1", ai_disabled: false }, isNew: false });
  m.saveMessage.mockResolvedValue({ id: "msg-1", role: "contact", created_at: "2026-10-16T12:00:00Z" });
  m.enqueueStoreChatMedia.mockResolvedValue(undefined);
});

describe("webhook: captura de mídia do cliente", () => {
  it.each([["imagem", image], ["vídeo", video], ["documento", doc]])("enfileira a captura de %s", async (_n, payload) => {
    const r = await post(payload);
    expect(r.statusCode).toBe(200);
    expect(m.enqueueStoreChatMedia).toHaveBeenCalledWith(expected);
    expect(m.enqueueStoreCustomerAudio).not.toHaveBeenCalled();
  });

  it("enfileira mesmo com atendimento humano ativo", async () => {
    m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: true }, contact: { id: "c1", ai_disabled: false }, isNew: false });
    await post(image);
    expect(m.enqueueStoreChatMedia).toHaveBeenCalledTimes(1);
  });

  it("falha ao enfileirar não derruba o recebimento nem a IA", async () => {
    m.enqueueStoreChatMedia.mockRejectedValue(new Error("redis down"));
    const r = await post(image);
    expect(r.statusCode).toBe(200);
    expect(m.saveMessage).toHaveBeenCalled();
    expect(m.enqueueProcessMessage).toHaveBeenCalled();
  });

  it("não enfileira para texto", async () => {
    await post(text);
    expect(m.enqueueStoreChatMedia).not.toHaveBeenCalled();
  });

  it("não enfileira para contato ignorado (no_store e minimal_record)", async () => {
    m.getIgnoredContact.mockResolvedValue({ retention_mode: "no_store" }); await post(image);
    expect(m.saveMessage).not.toHaveBeenCalled();
    m.getIgnoredContact.mockResolvedValue({ retention_mode: "minimal_record" }); await post(image);
    expect(m.saveMessage).toHaveBeenCalledTimes(1);
    expect(m.enqueueStoreChatMedia).not.toHaveBeenCalled();
  });

  it("segunda entrega da mesma mensagem é descartada pela dedupe, sem novo enqueue", async () => {
    m.saveMessage.mockResolvedValueOnce({ id: "msg-1", role: "contact", created_at: "x" }).mockResolvedValueOnce(null);
    await post(image);
    const r = await post(image);
    expect(r.json()).toMatchObject({ skipped: "duplicate" });
    expect(m.enqueueStoreChatMedia).toHaveBeenCalledTimes(1);
  });

  it("documento com legenda (documentWithCaptionMessage) é salvo como document e enfileirado uma vez", async () => {
    await post(wrappedDoc);
    expect(m.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "document", content: "contrato" }));
    expect(m.enqueueStoreChatMedia).toHaveBeenCalledTimes(1);
    expect(m.enqueueStoreChatMedia).toHaveBeenCalledWith(expected);
  });

  it("documento com legenda sem caption usa o nome do arquivo", async () => {
    await post(wrappedDocNoCaption);
    expect(m.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "document", content: "b.pdf" }));
  });

  it("documento com legenda de contato no_store não enfileira", async () => {
    m.getIgnoredContact.mockResolvedValue({ retention_mode: "no_store" });
    await post(wrappedDoc);
    expect(m.enqueueStoreChatMedia).not.toHaveBeenCalled();
  });

  it("imagem enviada por nós (fromMe) não enfileira", async () => {
    await post(fromMeImage);
    expect(m.enqueueStoreChatMedia).not.toHaveBeenCalled();
  });
});
