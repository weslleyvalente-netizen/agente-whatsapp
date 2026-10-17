import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes, { resolveReplayCreatedAt, REPLAY_TIMESTAMP_HEADER } from "./evolution.js";
import { REPLAY_TOKEN } from "../../lib/replay-token.js";

process.env.WEBHOOK_SECRET = "test-secret";

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), getIgnoredContact: vi.fn(), ensureConversation: vi.fn(),
  saveMessage: vi.fn(), enqueueProcessMessage: vi.fn(),
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
vi.mock("../../services/lead-origin.service.js", () => ({ recordLeadOrigin: vi.fn() }));
vi.mock("../../services/lead-human-message.js", () => ({ trackFirstHumanMessage: vi.fn() }));

describe("resolveReplayCreatedAt", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  it("sem o cabeçalho devolve undefined (fluxo normal)", () => {
    expect(resolveReplayCreatedAt({}, 1760657400, now)).toBeUndefined();
  });
  it("com o cabeçalho devolve o horário original em ISO", () => {
    expect(resolveReplayCreatedAt({ [REPLAY_TIMESTAMP_HEADER]: REPLAY_TOKEN }, 1760657400, now)).toBe("2025-10-16T23:30:00.000Z");
  });
  it("sem token válido (ou com valor '1') o cabeçalho é ignorado", () => {
    expect(resolveReplayCreatedAt({ [REPLAY_TIMESTAMP_HEADER]: "1" }, 1760657400, now)).toBeUndefined();
    expect(resolveReplayCreatedAt({ [REPLAY_TIMESTAMP_HEADER]: "x".repeat(REPLAY_TOKEN.length) }, 1760657400, now)).toBeUndefined();
  });
  it("sem WEBHOOK_SECRET o cabeçalho é ignorado, mesmo com o token certo", () => {
    const saved = process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_SECRET;
    expect(resolveReplayCreatedAt({ [REPLAY_TIMESTAMP_HEADER]: REPLAY_TOKEN }, 1760657400, now)).toBeUndefined();
    process.env.WEBHOOK_SECRET = saved;
  });
  it("ignora timestamp ausente, inválido ou no futuro", () => {
    const h = { [REPLAY_TIMESTAMP_HEADER]: REPLAY_TOKEN };
    expect(resolveReplayCreatedAt(h, undefined, now)).toBeUndefined();
    expect(resolveReplayCreatedAt(h, NaN, now)).toBeUndefined();
    expect(resolveReplayCreatedAt(h, now / 1000 + 3600, now)).toBeUndefined();
  });
});

describe("webhook — replay preserva created_at", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", organization_id: "org", active_agent_id: "ag" });
    m.getIgnoredContact.mockResolvedValue(null);
    m.ensureConversation.mockResolvedValue({ conversation: { id: "c1", is_human_takeover: false }, contact: { id: "ct", ai_disabled: false }, isNew: false });
    m.saveMessage.mockResolvedValue({ id: "m1", role: "contact", created_at: "x" });
  });
  const payload = { event: "messages.upsert", instance: "inst", data: { key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: false, id: "E1" }, message: { conversation: "oi" }, messageType: "conversation", messageTimestamp: 1760657400 } };

  async function post(headers: Record<string, string>) {
    const app = Fastify();
    await app.register(evolutionWebhookRoutes);
    const res = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { apikey: "test-secret", ...headers }, payload });
    await app.close();
    return res;
  }

  it("com o cabeçalho passa createdAt original e ainda enfileira a IA", async () => {
    const res = await post({ [REPLAY_TIMESTAMP_HEADER]: REPLAY_TOKEN });
    expect(res.statusCode).toBe(200);
    expect(m.saveMessage.mock.calls[0][0].createdAt).toBe("2025-10-16T23:30:00.000Z");
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });
  it("webhook ignora o cabeçalho de replay sem o token (forjado)", async () => {
    await post({ [REPLAY_TIMESTAMP_HEADER]: "1" });
    expect(m.saveMessage.mock.calls[0][0].createdAt).toBeUndefined();
  });
  it("sem o cabeçalho não passa createdAt (comportamento inalterado)", async () => {
    await post({});
    expect(m.saveMessage.mock.calls[0][0].createdAt).toBeUndefined();
  });
});
