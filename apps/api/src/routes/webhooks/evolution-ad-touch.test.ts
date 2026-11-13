import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";

process.env.WEBHOOK_SECRET = "test-secret";

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), getIgnoredContact: vi.fn(), ensureConversation: vi.fn(),
  saveMessage: vi.fn(), enqueueProcessMessage: vi.fn(), recordLeadOrigin: vi.fn(), recordAdTouch: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  getInstanceByInstanceId: m.getInstanceByInstanceId,
  getIgnoredContact: m.getIgnoredContact,
  resolveUnresponsiveTasksOnReply: async () => undefined,
  updateConversation: vi.fn(), createHandoffEvent: vi.fn(), getOrganizationById: vi.fn(),
  getOpenHandoffEvent: vi.fn(), markFirstHumanReply: vi.fn(),
  findPendingOutboundMessages: async () => [], setMessageEvolutionId: async () => undefined,
}));
vi.mock("../../services/conversation.service.js", () => ({ ensureConversation: m.ensureConversation }));
vi.mock("../../services/message.service.js", () => ({ saveMessage: m.saveMessage }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: vi.fn() }));
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: m.enqueueProcessMessage, enqueueStoreCustomerAudio: vi.fn() }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: vi.fn() }));
vi.mock("../../services/lead-origin.service.js", () => ({ recordLeadOrigin: m.recordLeadOrigin }));
vi.mock("../../services/lead-ad-touch.service.js", () => ({ recordAdTouch: m.recordAdTouch }));
vi.mock("../../services/lead-human-message.js", () => ({ trackFirstHumanMessage: vi.fn() }));

const AD = { title: "Seu próximo carro", body: "Consórcio", sourceId: "999", sourceUrl: "https://www.instagram.com/p/AAA/", sourceType: "ad", ctwaClid: "clid" };
const TS = 1763046000; // 2025-11-13T15:00:00Z

const payload = (over: Record<string, unknown> = {}, key: Record<string, unknown> = {}) => ({
  event: "messages.upsert", instance: "inst",
  data: {
    key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: false, id: "WAMID1", ...key },
    message: { conversation: "Olá! Posso ter mais informações sobre isso?" }, messageType: "conversation", messageTimestamp: TS,
    contextInfo: { externalAdReply: AD }, ...over,
  },
});

async function post(body: unknown) {
  const app = Fastify();
  await app.register(evolutionWebhookRoutes);
  const res = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { apikey: "test-secret" }, payload: body as never });
  await app.close();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", organization_id: "org-1", active_agent_id: "ag" });
  m.getIgnoredContact.mockResolvedValue(null);
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false }, contact: { id: "ct-1", ai_disabled: false }, isNew: true });
  m.saveMessage.mockResolvedValue({ id: "m1", role: "contact", created_at: "2026-11-13T15:00:00Z" });
  m.recordLeadOrigin.mockResolvedValue(undefined);
  m.recordAdTouch.mockResolvedValue("recorded");
});

describe("webhook: origem estruturada por anúncio", () => {
  it("grava o toque com organização, contato, conversa, id da mensagem, horário original e o anúncio", async () => {
    const res = await post(payload());
    expect(res.statusCode).toBe(200);
    expect(m.recordAdTouch).toHaveBeenCalledTimes(1);
    const arg = m.recordAdTouch.mock.calls[0][1];
    expect(arg).toMatchObject({ organizationId: "org-1", contactId: "ct-1", conversationId: "conv-1", evolutionMessageId: "WAMID1", ad: AD });
    expect(arg.touchedAt.toISOString()).toBe(new Date(TS * 1000).toISOString());
  });

  it("o selo de origem existente continua sendo gravado (nada muda no card)", async () => {
    await post(payload());
    expect(m.recordLeadOrigin).toHaveBeenCalledTimes(1);
  });

  it("também reconhece o anúncio dentro de extendedTextMessage", async () => {
    await post(payload({ contextInfo: undefined, message: { extendedTextMessage: { text: "oi", contextInfo: { externalAdReply: AD } } }, messageType: "extendedTextMessage" }));
    expect(m.recordAdTouch).toHaveBeenCalledTimes(1);
    expect(m.recordAdTouch.mock.calls[0][1].ad).toMatchObject({ sourceId: "999" });
  });

  it("sem contexto de anúncio não chama o registro", async () => {
    await post(payload({ contextInfo: undefined }));
    expect(m.recordAdTouch).not.toHaveBeenCalled();
  });

  it("mensagem enviada pela loja (fromMe) não gera toque", async () => {
    await post(payload({}, { fromMe: true }));
    expect(m.recordAdTouch).not.toHaveBeenCalled();
  });

  it("contato com registro mínimo (ignorado) não gera toque", async () => {
    m.getIgnoredContact.mockResolvedValue({ retention_mode: "minimal_record" });
    await post(payload());
    expect(m.recordAdTouch).not.toHaveBeenCalled();
  });

  it("falha ao gravar o toque não derruba o recebimento: a mensagem segue para a IA", async () => {
    m.recordAdTouch.mockRejectedValue(new Error("relation lead_ad_touches does not exist"));
    const res = await post(payload());
    expect(res.statusCode).toBe(200);
    expect(m.saveMessage).toHaveBeenCalledTimes(1);
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });

  it("horário ausente usa o momento atual", async () => {
    await post(payload({ messageTimestamp: undefined }));
    expect(Math.abs(m.recordAdTouch.mock.calls[0][1].touchedAt.getTime() - Date.now())).toBeLessThan(5000);
  });
});
