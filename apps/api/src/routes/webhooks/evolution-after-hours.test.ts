import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";

delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), ensureConversation: vi.fn(), saveMessage: vi.fn(),
  enqueueProcessMessage: vi.fn(), getOrganizationById: vi.fn(), getOpenHandoffEvent: vi.fn(),
  updateConversation: vi.fn(), createHandoffEvent: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  resolveUnresponsiveTasksOnReply: async () => undefined,
  getInstanceByInstanceId: m.getInstanceByInstanceId,
  getIgnoredContact: async () => null,
  updateConversation: m.updateConversation, createHandoffEvent: m.createHandoffEvent,
  getOrganizationById: m.getOrganizationById,
  getOpenHandoffEvent: m.getOpenHandoffEvent, markFirstHumanReply: async () => undefined,
  findPendingOutboundMessages: async () => [], setMessageEvolutionId: async () => undefined,
}));
vi.mock("../../services/conversation.service.js", () => ({ ensureConversation: m.ensureConversation }));
vi.mock("../../services/message.service.js", () => ({ saveMessage: m.saveMessage }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: async () => undefined }));
vi.mock("../../services/lead-origin.service.js", () => ({ recordLeadOrigin: async () => undefined }));
vi.mock("../../services/lead-human-message.js", () => ({ trackFirstHumanMessage: async () => undefined }));
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: m.enqueueProcessMessage, enqueueStoreCustomerAudio: async () => undefined }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: async () => undefined }));

const text = {
  event: "messages.upsert", instance: "inst",
  data: { key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: false, id: "evo-1" }, message: { conversation: "oi" }, messageType: "conversation" },
};
async function post(payload: unknown) {
  const app = Fastify(); await app.register(evolutionWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: payload as any }); await app.close(); return r;
}
const NIGHT = "2026-10-10T15:00:00Z"; // sábado 12:00 BRT
const DAY = "2026-10-09T15:00:00Z"; // sexta 12:00 BRT
const conv = (takeover: boolean, ai = false) =>
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: takeover }, contact: { id: "c1", ai_disabled: ai }, isNew: false });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NIGHT));
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", organization_id: "org-1", active_agent_id: "agent-1" });
  conv(true);
  m.saveMessage.mockResolvedValue({ id: "msg-1", role: "contact", created_at: "2026-10-10T15:00:00Z" });
  m.getOrganizationById.mockResolvedValue({ settings: { ai_after_hours_pending_enabled: true } });
  m.getOpenHandoffEvent.mockResolvedValue({ id: "h1" });
});
afterEach(() => vi.useRealTimers());

describe("webhook: modo noite", () => {
  it("takeover por requestHuman aberto fora do horário -> enfileira com o sinal, sem mexer em takeover/handoff", async () => {
    const r = await post(text);
    expect(r.json()).toMatchObject({ ok: true, messageId: "msg-1" });
    expect(m.enqueueProcessMessage).toHaveBeenCalledWith(expect.objectContaining({ afterHoursPending: true, conversationId: "conv-1" }));
    expect(m.updateConversation).not.toHaveBeenCalled();
    expect(m.createHandoffEvent).not.toHaveBeenCalled();
  });
  it("no horário comercial continua pulando", async () => {
    vi.setSystemTime(new Date(DAY));
    expect((await post(text)).json()).toMatchObject({ skipped: "human_takeover" });
    expect(m.enqueueProcessMessage).not.toHaveBeenCalled();
  });
  it("takeover manual (sem handoff request_human aberto) continua pulando", async () => {
    m.getOpenHandoffEvent.mockResolvedValue(null);
    expect((await post(text)).json()).toMatchObject({ skipped: "human_takeover" });
    expect(m.enqueueProcessMessage).not.toHaveBeenCalled();
  });
  it("ai_disabled pula", async () => {
    conv(true, true);
    expect((await post(text)).json()).toHaveProperty("skipped");
    expect(m.enqueueProcessMessage).not.toHaveBeenCalled();
  });
  it("flag desligada pula (e nem consulta handoff)", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: {} });
    expect((await post(text)).json()).toMatchObject({ skipped: "human_takeover" });
    expect(m.getOpenHandoffEvent).not.toHaveBeenCalled();
  });
  it("erro na consulta falha fechado (silêncio como antes)", async () => {
    m.getOpenHandoffEvent.mockRejectedValue(new Error("db"));
    expect((await post(text)).json()).toMatchObject({ skipped: "human_takeover" });
  });
  it("sem takeover: fluxo normal sem sinal", async () => {
    conv(false);
    await post(text);
    expect(m.enqueueProcessMessage).toHaveBeenCalledWith(expect.not.objectContaining({ afterHoursPending: true }));
  });
});
