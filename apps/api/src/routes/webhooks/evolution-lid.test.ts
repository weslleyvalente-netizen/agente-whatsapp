import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes from "./evolution.js";
import { lidPhoneResolver } from "../../services/lid-phone-map.js";

// Após reconexão o Evolution entrega remoteJid "<n>@lid" e o número real em remoteJidAlt.
delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), getIgnoredContact: vi.fn(), ensureConversation: vi.fn(), saveMessage: vi.fn(),
  enqueueProcessMessage: vi.fn(), findMessagesByRemoteJid: vi.fn(),
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
  lidPhoneResolver.reset();
  m.findMessagesByRemoteJid.mockResolvedValue([]);
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", instance_name: "inst-name", organization_id: "org-1", active_agent_id: "agent-1" });
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

  it("@lid sem alt e sem nada no Evolution mantém o remoteJid (comportamento atual)", async () => {
    await post(payload({ remoteJid: "90000000000001@lid" }));
    expect(m.findMessagesByRemoteJid).toHaveBeenCalledWith("inst-name", "90000000000001@lid", expect.any(Number), expect.any(AbortSignal));
    expect(m.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({ phone: "90000000000001@lid" }));
  });

  it("@lid sem alt: lookup no Evolution acha o telefone e depois fica em cache", async () => {
    m.findMessagesByRemoteJid.mockResolvedValue([{ key: { remoteJid: "90000000000002@lid", remoteJidAlt: "5511911112222@s.whatsapp.net", fromMe: false, id: "a" } }]);
    await post(payload({ remoteJid: "90000000000002@lid" }));
    await post(payload({ remoteJid: "90000000000002@lid", id: "evo-2" }));
    expect(m.ensureConversation).toHaveBeenNthCalledWith(1, expect.objectContaining({ phone: "5511911112222" }));
    expect(m.ensureConversation).toHaveBeenNthCalledWith(2, expect.objectContaining({ phone: "5511911112222" }));
    expect(m.findMessagesByRemoteJid).toHaveBeenCalledTimes(1);
  });

  it("mensagem COM alt alimenta o cache para a próxima SEM alt", async () => {
    await post(payload({ remoteJid: "90000000000003@lid", remoteJidAlt: "5511933334444@s.whatsapp.net" }));
    await post(payload({ remoteJid: "90000000000003@lid", id: "evo-2" }));
    expect(m.ensureConversation).toHaveBeenLastCalledWith(expect.objectContaining({ phone: "5511933334444" }));
    expect(m.findMessagesByRemoteJid).not.toHaveBeenCalled();
  });

  it("erro do Evolution não derruba o webhook", async () => {
    m.findMessagesByRemoteJid.mockRejectedValue(new Error("evolution fora"));
    const r = await post(payload({ remoteJid: "90000000000004@lid" }));
    expect(r.statusCode).toBe(200);
    expect(m.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({ phone: "90000000000004@lid" }));
  });

  it("timeout do Evolution no webhook: responde 200 e segue com o remoteJid", async () => {
    m.findMessagesByRemoteJid.mockImplementation(() => new Promise(() => {}));
    const r = await post(payload({ remoteJid: "90000000000005@lid" }));
    expect(r.statusCode).toBe(200);
    expect(m.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({ phone: "90000000000005@lid" }));
  }, 10_000);

  it("alt igual ao número da instância é ignorado", async () => {
    m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", instance_name: "inst-name", phone_number: "+55 62 9681-8769", organization_id: "org-1", active_agent_id: "agent-1" });
    await post(payload({ remoteJid: "90000000000006@lid", remoteJidAlt: "556296818769@s.whatsapp.net" }));
    expect(m.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({ phone: "90000000000006@lid" }));
  });

  it("eco fromMe com remoteJid 0@s.whatsapp.net é ignorado", async () => {
    const r = await post(payload({ remoteJid: "0@s.whatsapp.net", fromMe: true }));
    expect(r.json()).toMatchObject({ skipped: "system_message" });
    expect(m.ensureConversation).not.toHaveBeenCalled();
    expect(m.saveMessage).not.toHaveBeenCalled();
  });

  it("notificação de sistema 0@s.whatsapp.net é ignorada como grupo: nada gravado", async () => {
    const r = await post(payload({ remoteJid: "0@s.whatsapp.net" }));
    expect(r.json()).toMatchObject({ skipped: "system_message" });
    expect(m.getInstanceByInstanceId).not.toHaveBeenCalled();
    expect(m.ensureConversation).not.toHaveBeenCalled();
    expect(m.saveMessage).not.toHaveBeenCalled();
    expect(m.enqueueProcessMessage).not.toHaveBeenCalled();
  });
});
