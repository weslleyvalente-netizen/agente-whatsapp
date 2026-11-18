import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes, { resetInternalPhoneCache } from "./evolution.js";

delete process.env.WEBHOOK_SECRET;

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), ensureConversation: vi.fn(), saveMessage: vi.fn(), enqueueProcessMessage: vi.fn(),
  getOrganizationById: vi.fn(), stampMessageMetadata: vi.fn(), updateConversation: vi.fn(), claimHumanTakeover: vi.fn(), hasOutboundMessageAfter: vi.fn(),
  listManagerUserIds: vi.fn(), sendPushToUser: vi.fn(), syncContactToCrm: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  resolveUnresponsiveTasksOnReply: async () => undefined,
  getInstanceByInstanceId: m.getInstanceByInstanceId,
  getIgnoredContact: async () => null,
  updateConversation: m.updateConversation, createHandoffEvent: async () => ({ id: "h" }),
  getOrganizationById: m.getOrganizationById,
  getOpenHandoffEvent: async () => null, markFirstHumanReply: async () => undefined,
  findPendingOutboundMessages: async () => [], setMessageEvolutionId: async () => undefined,
  stampMessageMetadata: m.stampMessageMetadata,
  hasOutboundMessageAfter: m.hasOutboundMessageAfter, claimHumanTakeover: m.claimHumanTakeover,
  listManagerUserIds: m.listManagerUserIds, sendPushToUser: m.sendPushToUser,
}));
vi.mock("../../services/conversation.service.js", () => ({ ensureConversation: m.ensureConversation }));
vi.mock("../../services/message.service.js", () => ({ saveMessage: m.saveMessage }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: async () => undefined }));
vi.mock("../../services/lead-origin.service.js", () => ({ recordLeadOrigin: async () => undefined }));
vi.mock("../../services/lead-human-message.js", () => ({ trackFirstHumanMessage: async () => undefined }));
vi.mock("../../lib/queue.js", () => ({ enqueueProcessMessage: m.enqueueProcessMessage, enqueueStoreCustomerAudio: async () => undefined }));
vi.mock("../../integrations/crm-sync.js", () => ({ syncContactToCrm: m.syncContactToCrm }));

const nowSec = () => Math.floor(Date.now() / 1000);
const payload = (ts: number | undefined) => ({
  event: "messages.upsert", instance: "inst",
  data: { key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: false, id: "evo-1" }, message: { conversation: "oi" }, messageType: "conversation", ...(ts === undefined ? {} : { messageTimestamp: ts }) },
});
async function post(p: unknown) {
  const app = Fastify(); await app.register(evolutionWebhookRoutes);
  const r = await app.inject({ method: "POST", url: "/webhooks/evolution", payload: p as any }); await app.close(); return r;
}
const conv = (over: Record<string, unknown> = {}, isNew = false) =>
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false, assigned_to: null, ...over }, contact: { id: "c1", ai_disabled: false }, isNew });
const settings = (s: Record<string, unknown>) => m.getOrganizationById.mockResolvedValue({ settings: s });

beforeEach(() => {
  vi.clearAllMocks(); resetInternalPhoneCache();
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", organization_id: "org-1", active_agent_id: "agent-1" });
  settings({ stale_message_guard_mode: "on" });
  m.saveMessage.mockResolvedValue({ id: "msg-1", role: "contact", created_at: "2026-11-18T19:00:00Z" });
  m.stampMessageMetadata.mockResolvedValue(undefined); m.updateConversation.mockResolvedValue(undefined); m.claimHumanTakeover.mockResolvedValue(true);
  m.hasOutboundMessageAfter.mockResolvedValue(false);
  m.listManagerUserIds.mockResolvedValue(["mgr-1"]); m.sendPushToUser.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
  m.enqueueProcessMessage.mockResolvedValue(undefined); m.syncContactToCrm.mockResolvedValue(undefined);
  conv();
});

describe("webhook: proteção contra mensagem atrasada", () => {
  it("on + mensagem de 3 h: grava, NÃO enfileira para a IA, NÃO marca ai_routed_at, passa para humano e avisa gestores (contato sem vendedor)", async () => {
    const r = await post(payload(nowSec() - 3 * 3600));
    expect(r.json()).toMatchObject({ ok: true, messageId: "msg-1", skipped: "stale_message" });
    expect(m.saveMessage).toHaveBeenCalledTimes(1); // preservada
    expect(m.enqueueProcessMessage).not.toHaveBeenCalled();
    expect(m.stampMessageMetadata).not.toHaveBeenCalledWith({}, "msg-1", expect.objectContaining({ ai_routed_at: expect.anything() }));
    expect(m.stampMessageMetadata).toHaveBeenCalledWith({}, "msg-1", { stale_guard: expect.objectContaining({ mode: "on", action: "hold_and_human" }) });
    expect(m.claimHumanTakeover).toHaveBeenCalledWith({}, "conv-1", expect.any(String));
    expect(m.updateConversation).not.toHaveBeenCalled(); // não mexe em dono/distribuição
    expect(m.listManagerUserIds).toHaveBeenCalledWith({}, "org-1");
    expect(m.sendPushToUser).toHaveBeenCalledWith({}, "mgr-1", expect.objectContaining({ tag: "stale-guard-conv-1" }), { organizationId: "org-1" });
  });
  it("on + contato com vendedor: avisa o vendedor, não os gestores", async () => {
    conv({ assigned_to: "seller-9" });
    await post(payload(nowSec() - 3 * 3600));
    expect(m.sendPushToUser).toHaveBeenCalledWith({}, "seller-9", expect.any(Object), { organizationId: "org-1" });
    expect(m.listManagerUserIds).not.toHaveBeenCalled();
  });
  it("on + já respondida depois do horário original: IA não responde e não vira takeover", async () => {
    m.hasOutboundMessageAfter.mockResolvedValue(true);
    const r = await post(payload(nowSec() - 3 * 3600));
    expect(r.json()).toMatchObject({ skipped: "stale_message" });
    expect(m.enqueueProcessMessage).not.toHaveBeenCalled();
    expect(m.claimHumanTakeover).not.toHaveBeenCalled();
  });
  it("on + takeover já ligado por outra mensagem do lote (claim=false): retém e NÃO avisa de novo", async () => {
    m.claimHumanTakeover.mockResolvedValue(false);
    await post(payload(nowSec() - 3 * 3600));
    expect(m.enqueueProcessMessage).not.toHaveBeenCalled();
    expect(m.sendPushToUser).not.toHaveBeenCalled();
  });
  it("on + contato novo atrasado: continua sincronizando com o CRM", async () => {
    conv({}, true);
    await post(payload(nowSec() - 3 * 3600));
    expect(m.syncContactToCrm).toHaveBeenCalledTimes(1);
  });
  it("on + mensagem recente: fluxo normal (marca e enfileira); não lê a configuração por causa da proteção", async () => {
    const r = await post(payload(nowSec() - 30));
    expect(r.json()).toMatchObject({ ok: true, messageId: "msg-1" });
    expect(r.json().skipped).toBeUndefined();
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
    expect(m.hasOutboundMessageAfter).not.toHaveBeenCalled();
  });
  it("on + sem messageTimestamp: fluxo normal (nunca retém sem prova de atraso)", async () => {
    await post(payload(undefined));
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
    expect(m.claimHumanTakeover).not.toHaveBeenCalled();
  });
  it("on + timestamp muito no futuro (relógio errado): fluxo normal", async () => {
    await post(payload(nowSec() + 3600));
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });
  it("shadow + mensagem de 3 h: IA responde como hoje; só registra", async () => {
    settings({ stale_message_guard_mode: "shadow" });
    await post(payload(nowSec() - 3 * 3600));
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
    expect(m.claimHumanTakeover).not.toHaveBeenCalled();
    expect(m.sendPushToUser).not.toHaveBeenCalled();
    expect(m.stampMessageMetadata).toHaveBeenCalledWith({}, "msg-1", { stale_guard: expect.objectContaining({ mode: "shadow", would: "hold_and_human" }) });
  });
  it("off/ausente + mensagem de 3 h: comportamento idêntico ao de antes", async () => {
    settings({});
    await post(payload(nowSec() - 3 * 3600));
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
    expect(m.claimHumanTakeover).not.toHaveBeenCalled();
    expect(m.stampMessageMetadata).toHaveBeenCalledTimes(1); // só ai_routed_at, como antes
  });
  it("falha ao ler a organização: segue como hoje", async () => {
    m.getOrganizationById.mockRejectedValue(new Error("db"));
    await post(payload(nowSec() - 3 * 3600));
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });
  it("webhook duplicado: nada é reprocessado e a proteção nem é avaliada", async () => {
    m.saveMessage.mockResolvedValue(null);
    const r = await post(payload(nowSec() - 3 * 3600));
    expect(r.json()).toMatchObject({ skipped: "duplicate" });
    expect(m.hasOutboundMessageAfter).not.toHaveBeenCalled();
    expect(m.claimHumanTakeover).not.toHaveBeenCalled();
  });
  it("conversa já em takeover não passa pela IA (como hoje) e a proteção não roda", async () => {
    conv({ is_human_takeover: true });
    const r = await post(payload(nowSec() - 3 * 3600));
    expect(r.json()).toMatchObject({ skipped: "human_takeover" });
    expect(m.hasOutboundMessageAfter).not.toHaveBeenCalled();
  });
});
