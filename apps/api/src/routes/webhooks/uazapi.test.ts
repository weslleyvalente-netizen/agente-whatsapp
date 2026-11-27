import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import Fastify from "fastify";

delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), getInstanceByInstanceName: vi.fn(), getIgnoredContact: vi.fn(), ensureConversation: vi.fn(),
  saveMessage: vi.fn(), enqueueProcessMessage: vi.fn(), applyMessageDeliveryStatus: vi.fn(),
}));
vi.mock("../../services/evolution.service.js", () => ({ findMessagesByRemoteJid: async () => [] }));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  resolveUnresponsiveTasksOnReply: async () => undefined,
  getInstanceByInstanceId: m.getInstanceByInstanceId, getInstanceByInstanceName: m.getInstanceByInstanceName,
  getIgnoredContact: m.getIgnoredContact, applyMessageDeliveryStatus: m.applyMessageDeliveryStatus,
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

import evolutionWebhookRoutes from "./evolution.js";
import uazapiWebhookRoutes from "./uazapi.js";
import { encryptInstanceToken } from "@aula-agente/agent-runtime";
import { lidPhoneResolver } from "../../services/lid-phone-map.js";
import { getWebhookPulse, resetWebhookPulses } from "../../services/webhook-pulse.js";

let logs: string[];
async function post(body: unknown) {
  logs = [];
  const stream = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
  const app = Fastify({ logger: { level: "info", stream } });
  await app.register(evolutionWebhookRoutes);
  await app.register(uazapiWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/uazapi", payload: body as any });
  await app.close();
  return r;
}

const textEvent = (token = "tok-1", extra: Record<string, unknown> = {}) => ({
  EventType: "messages", owner: "5562900000000", token, BaseUrl: "https://x.uazapi.com", instanceName: "weslley",
  message: {
    id: "r1", messageid: "MSG1", chatid: "5562999990000@s.whatsapp.net", sender: "5562999990000@s.whatsapp.net", senderName: "Cliente",
    fromMe: false, isGroup: false, messageType: "Conversation", text: "Olá", messageTimestamp: Date.now(), ...extra,
  },
});

let instance: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("UAZAPI_ADMIN_TOKEN", "admin-1");
  lidPhoneResolver.reset();
  resetWebhookPulses();
  instance = { id: "i1", instance_id: "weslley", instance_name: "weslley", organization_id: "org-1", active_agent_id: "agent-1",
    provider: "uazapi", provider_token_encrypted: encryptInstanceToken("tok-1") };
  m.getInstanceByInstanceName.mockImplementation(async () => instance);
  m.getInstanceByInstanceId.mockImplementation(async () => instance);
  m.getIgnoredContact.mockResolvedValue(null);
  m.applyMessageDeliveryStatus.mockResolvedValue(true);
  m.saveMessage.mockResolvedValue({ id: "msg-1", role: "contact", created_at: new Date().toISOString() });
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false }, contact: { id: "c1", ai_disabled: false }, isNew: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /webhooks/uazapi", () => {
  it("token certo: grava pelo fluxo de sempre e aciona a IA uma vez", async () => {
    const r = await post(textEvent());
    expect(r.statusCode).toBe(200);
    expect(m.saveMessage).toHaveBeenCalledTimes(1);
    expect(m.saveMessage.mock.calls[0][0]).toMatchObject({ content: "Olá" });
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });

  it("token errado: 401 e nada gravado", async () => {
    const r = await post(textEvent("outro"));
    expect(r.statusCode).toBe(401);
    expect(m.saveMessage).not.toHaveBeenCalled();
  });

  it("instância sem token guardado: 401", async () => {
    instance.provider_token_encrypted = null;
    expect((await post(textEvent())).statusCode).toBe(401);
    expect(m.saveMessage).not.toHaveBeenCalled();
  });

  it("instância ainda em evolution: 200 inactive_provider e nada gravado", async () => {
    instance.provider = "evolution";
    const r = await post(textEvent());
    expect(r.json()).toMatchObject({ skipped: "inactive_provider" });
    expect(m.saveMessage).not.toHaveBeenCalled();
  });

  it("instância desconhecida: 200 unknown_instance", async () => {
    m.getInstanceByInstanceName.mockResolvedValue(null);
    expect((await post(textEvent())).json()).toMatchObject({ skipped: "unknown_instance" });
  });

  it("pulso do webhook (monitor do provedor): evento autenticado registra; token errado ou instância desconhecida não", async () => {
    await post(textEvent("outro"));
    expect(getWebhookPulse("i1")).toBeNull();
    m.getInstanceByInstanceName.mockResolvedValueOnce(null);
    await post(textEvent());
    expect(getWebhookPulse("i1")).toBeNull();
    await post({ EventType: "messages_update", token: "tok-1", instanceName: "weslley", type: "ReadReceipt", state: "Read", event: { MessageIDs: ["A1"] } });
    expect(getWebhookPulse("i1")).toMatchObject({ lastEventType: "messages_update" });
    expect(getWebhookPulse("i1")!.lastEventAt.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("recibo de leitura com dois ids grava o status dos dois", async () => {
    const r = await post({ EventType: "messages_update", token: "tok-1", instanceName: "weslley", type: "ReadReceipt", state: "Read", event: { MessageIDs: ["A1", "A2"] } });
    expect(r.json()).toMatchObject({ ok: true, statuses: 2 });
    await vi.waitFor(() => expect(m.applyMessageDeliveryStatus).toHaveBeenCalledTimes(2));
    expect(m.applyMessageDeliveryStatus.mock.calls.map((c) => c[1].evolutionMessageId).sort()).toEqual(["A1", "A2"]);
  });

  it("grupo: 200 group", async () => {
    expect((await post(textEvent("tok-1", { isGroup: true, chatid: "1@g.us" }))).json()).toMatchObject({ skipped: "group" });
  });

  it("log de forma não traz o texto nem o telefone", async () => {
    await post(textEvent());
    const shapeLog = logs.find((l) => l.includes("uazapi_event_shape"));
    expect(shapeLog).toBeDefined();
    expect(shapeLog).not.toContain("Olá");
    expect(shapeLog).not.toContain("5562999990000");
    expect(logs.join("")).not.toContain("tok-1");
  });
});
