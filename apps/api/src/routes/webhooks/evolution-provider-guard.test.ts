import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({ getInstanceByInstanceId: vi.fn(), saveMessage: vi.fn(), ensureConversation: vi.fn(), applyMessageDeliveryStatus: vi.fn() }));
vi.mock("../../services/evolution.service.js", () => ({ findMessagesByRemoteJid: async () => [] }));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}), resolveUnresponsiveTasksOnReply: async () => undefined,
  getInstanceByInstanceId: m.getInstanceByInstanceId, getIgnoredContact: async () => null, applyMessageDeliveryStatus: m.applyMessageDeliveryStatus,
  updateConversation: async () => undefined, createHandoffEvent: async () => ({ id: "h" }), getOrganizationById: async () => ({ settings: {} }),
  getOpenHandoffEvent: async () => null, markFirstHumanReply: async () => undefined, findPendingOutboundMessages: async () => [],
  setMessageEvolutionId: async () => undefined, stampMessageMetadata: async () => undefined, upsertContact: async () => undefined,
}));
vi.mock("../../services/conversation.service.js", () => ({ ensureConversation: m.ensureConversation }));
vi.mock("../../services/message.service.js", () => ({ saveMessage: m.saveMessage }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: async () => undefined }));
vi.mock("../../services/lead-origin.service.js", () => ({ recordLeadOrigin: async () => undefined }));
vi.mock("../../services/lead-human-message.js", () => ({ trackFirstHumanMessage: async () => undefined }));
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: async () => undefined, enqueueStoreCustomerAudio: async () => undefined }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: async () => undefined }));

import evolutionWebhookRoutes, { PROVIDER_RELAY_HEADER } from "./evolution.js";
import { REPLAY_TOKEN } from "../../lib/replay-token.js";

const payload = { event: "messages.upsert", instance: "inst", data: { key: { remoteJid: "5562999990000@s.whatsapp.net", fromMe: false, id: "E1" }, message: { conversation: "oi" }, messageType: "conversation" } };
async function post(body: unknown, headers: Record<string, string> = {}) {
  const app = Fastify(); await app.register(evolutionWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: body as any, headers }); await app.close(); return r;
}
const withProvider = (provider?: string) =>
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", instance_name: "inst", organization_id: "org-1", active_agent_id: "agent-1", ...(provider ? { provider } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
  m.saveMessage.mockResolvedValue({ id: "msg-1", role: "contact", created_at: new Date().toISOString() });
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false }, contact: { id: "c1", ai_disabled: false }, isNew: false });
  m.applyMessageDeliveryStatus.mockResolvedValue(true);
});

describe("trava de provedor na rota da Evolution", () => {
  it("instância em uazapi + POST direto da Evolution: ignorado", async () => {
    withProvider("uazapi");
    expect((await post(payload)).json()).toMatchObject({ skipped: "inactive_provider" });
    expect(m.saveMessage).not.toHaveBeenCalled();
  });

  it("instância sem provider (antes da migração): fluxo normal", async () => {
    withProvider();
    await post(payload);
    expect(m.saveMessage).toHaveBeenCalledTimes(1);
  });

  it("instância em evolution + repasse da UAZAPI: ignorado", async () => {
    withProvider("evolution");
    expect((await post(payload, { [PROVIDER_RELAY_HEADER]: REPLAY_TOKEN })).json()).toMatchObject({ skipped: "inactive_provider" });
    expect(m.saveMessage).not.toHaveBeenCalled();
  });

  it("cabeçalho de repasse com valor errado é tratado como Evolution", async () => {
    withProvider("uazapi");
    expect((await post(payload, { [PROVIDER_RELAY_HEADER]: "falso" })).json()).toMatchObject({ skipped: "inactive_provider" });
    withProvider("evolution");
    await post(payload, { [PROVIDER_RELAY_HEADER]: "falso" });
    expect(m.saveMessage).toHaveBeenCalledTimes(1);
  });

  it("status de entrega da Evolution para instância em uazapi não é gravado", async () => {
    withProvider("uazapi");
    await post({ event: "messages.update", instance: "inst", data: { keyId: "E1", status: "READ", fromMe: true } });
    await new Promise((r) => setTimeout(r, 50));
    expect(m.applyMessageDeliveryStatus).not.toHaveBeenCalled();
  });
});
