import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes, { resetInternalPhoneCache, samePhone } from "./evolution.js";

delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), ensureConversation: vi.fn(), saveMessage: vi.fn(), enqueueProcessMessage: vi.fn(),
  getOrganizationById: vi.fn(), stampMessageMetadata: vi.fn(), order: [] as string[],
}));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  resolveUnresponsiveTasksOnReply: async () => undefined,
  getInstanceByInstanceId: m.getInstanceByInstanceId,
  getIgnoredContact: async () => null,
  updateConversation: async () => undefined, createHandoffEvent: async () => ({ id: "h" }),
  getOrganizationById: m.getOrganizationById,
  getOpenHandoffEvent: async () => null, markFirstHumanReply: async () => undefined,
  findPendingOutboundMessages: async () => [], setMessageEvolutionId: async () => undefined,
  stampMessageMetadata: m.stampMessageMetadata,
}));
vi.mock("../../services/conversation.service.js", () => ({ ensureConversation: m.ensureConversation }));
vi.mock("../../services/message.service.js", () => ({ saveMessage: m.saveMessage }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: async () => undefined }));
vi.mock("../../services/lead-origin.service.js", () => ({ recordLeadOrigin: async () => undefined }));
vi.mock("../../services/lead-human-message.js", () => ({ trackFirstHumanMessage: async () => undefined }));
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: m.enqueueProcessMessage, enqueueStoreCustomerAudio: async () => undefined }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: async () => undefined }));

const payload = (jid: string, fromMe = false) => ({
  event: "messages.upsert", instance: "inst",
  data: { key: { remoteJid: `${jid}@s.whatsapp.net`, fromMe, id: "evo-1" }, message: { conversation: "oi" }, messageType: "conversation" },
});
async function post(p: unknown) {
  const app = Fastify(); await app.register(evolutionWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: p as any }); await app.close(); return r;
}
const conv = (takeover: boolean, ai = false) =>
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: takeover }, contact: { id: "c1", ai_disabled: ai }, isNew: false });

beforeEach(() => {
  vi.clearAllMocks(); m.order.length = 0; resetInternalPhoneCache();
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", organization_id: "org-1", active_agent_id: "agent-1" });
  m.getOrganizationById.mockResolvedValue({ settings: { health_alert_phone: "+55 (11) 98888-7777", handoff_notification_phone: "5521977776666" } });
  m.saveMessage.mockResolvedValue({ id: "msg-1", role: "contact", created_at: "2026-10-10T15:00:00Z" });
  m.stampMessageMetadata.mockImplementation(async () => { m.order.push("stamp"); });
  m.enqueueProcessMessage.mockImplementation(async () => { m.order.push("enqueue"); });
  conv(false);
});

describe("webhook: marca ai_routed_at", () => {
  it("grava a marca ANTES de enfileirar", async () => {
    await post(payload("5511999990000"));
    expect(m.stampMessageMetadata).toHaveBeenCalledWith({}, "msg-1", { ai_routed_at: expect.any(String) });
    expect(m.order).toEqual(["stamp", "enqueue"]);
  });
  it("falha na marca não impede o atendimento", async () => {
    m.stampMessageMetadata.mockRejectedValue(new Error("db"));
    await post(payload("5511999990000"));
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });
  it("mensagens puladas (takeover, ai_disabled) não recebem a marca", async () => {
    conv(true); await post(payload("5511999990000"));
    conv(false, true); await post(payload("5511999990000"));
    expect(m.stampMessageMetadata).not.toHaveBeenCalled();
    expect(m.enqueueProcessMessage).not.toHaveBeenCalled();
  });
});

describe("webhook: telefones internos de aviso são contato ignorado", () => {
  it.each([["5511988887777"], ["11988887777"], ["5521977776666"]])("%s (alerta de saúde / handoff) -> ignored_contact, nada gravado", async (jid) => {
    const r = await post(payload(jid));
    expect(r.json()).toMatchObject({ skipped: "ignored_contact" });
    expect(m.ensureConversation).not.toHaveBeenCalled();
    expect(m.saveMessage).not.toHaveBeenCalled();
    expect(m.enqueueProcessMessage).not.toHaveBeenCalled();
  });
  it("eco (fromMe) do aviso para o telefone interno também é ignorado", async () => {
    expect((await post(payload("5511988887777", true))).json()).toMatchObject({ skipped: "ignored_contact" });
    expect(m.saveMessage).not.toHaveBeenCalled();
  });
  it("cliente comum segue normal; falha ao ler a organização falha aberto", async () => {
    expect((await post(payload("5511999990000"))).json()).toMatchObject({ ok: true, messageId: "msg-1" });
    resetInternalPhoneCache(); m.getOrganizationById.mockRejectedValue(new Error("db"));
    expect((await post(payload("5511999990000"))).json()).toMatchObject({ ok: true });
  });
  it("samePhone compara dígitos normalizados", () => {
    expect(samePhone("+55 (11) 98888-7777", "5511988887777")).toBe(true);
    expect(samePhone("", "5511988887777")).toBe(false);
    expect(samePhone("5511988887777", "5511988887778")).toBe(false);
  });
});
