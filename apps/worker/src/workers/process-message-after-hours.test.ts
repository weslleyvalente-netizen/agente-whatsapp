import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  processor: null as null | ((job: any) => Promise<void>),
  getConversationById: vi.fn(), evaluateAfterHours: vi.fn(), runAgent: vi.fn(),
  createMessage: vi.fn(), updateConversation: vi.fn(), sendAdd: vi.fn(),
  getRecentMessages: vi.fn(), getLastContactMessage: vi.fn(),
}));
vi.mock("bullmq", () => ({ Worker: class { constructor(_q: string, fn: any) { m.processor = fn; } on() {} } }));
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getSendMessageQueue: () => ({ add: m.sendAdd }) }));
vi.mock("@aula-agente/database", () => ({
  syncSalesPipeline: async () => undefined, getAdminClient: () => ({}),
  getAgentById: async () => ({ id: "a", is_active: true, provider: "anthropic", model: "x", tools_config: {} }),
  getRecentMessages: m.getRecentMessages, getConversationById: m.getConversationById, getLastContactMessage: m.getLastContactMessage,
  createMessage: m.createMessage, updateConversation: m.updateConversation, updateMessageContent: async () => undefined,
  recordAiUsageEvent: async () => undefined, getInstanceById: async () => ({ id: "i", instance_name: "inst" }),
}));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey: async () => "k", resolveElevenLabsApiKey: async () => "k", runAgent: m.runAgent }));
vi.mock("../lib/lock.js", () => ({ acquireConversationLock: async () => "l", releaseConversationLock: async () => undefined }));
vi.mock("../lib/after-hours.js", () => ({ evaluateAfterHours: m.evaluateAfterHours }));
vi.mock("../lib/audio-transcription.js", () => ({ transcribeAudioMessage: vi.fn() }));
vi.mock("../lib/image-description.js", () => ({ describeImageMessage: vi.fn() }));
vi.mock("../lib/audio-generation.js", () => ({ generateSpeech: vi.fn(), isSimpleEnoughForAudio: () => false }));

import { startProcessMessageWorker } from "./process-message.js";

const contactMsg = { id: "m1", role: "contact", content: "tem Fazer?", media_type: null, created_at: "2026-10-10T15:00:00Z", conversation_id: "c" };
const conv = (takeover: boolean) => ({ id: "c", is_human_takeover: takeover, evolution_instance_id: "i", contact_id: "ct", wa_contacts: { phone: "55", name: "N", ai_disabled: false } });
const job = { data: { conversationId: "c", messageId: "m1", agentId: "a", organizationId: "o", afterHoursPending: true } };
const result = { text: "Temos sim!", model: "x", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cacheStatus: "none", latencyMs: 1, toolCalls: [] };

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  m.getRecentMessages.mockResolvedValue([contactMsg]);
  m.getLastContactMessage.mockResolvedValue(contactMsg);
  m.runAgent.mockResolvedValue(result);
  m.createMessage.mockResolvedValue({ id: "r1" });
  m.evaluateAfterHours.mockResolvedValue({ run: true, capped: false, handedAt: "x" });
  startProcessMessageWorker();
});

describe("process-message em modo noite", () => {
  it("takeover + modo noite: roda a IA com afterHoursPending, envia, grava marca e não mexe em takeover/status", async () => {
    m.getConversationById.mockResolvedValue(conv(true));
    await m.processor!(job);
    expect(m.runAgent).toHaveBeenCalledWith(expect.objectContaining({ afterHoursPending: true }));
    expect(m.createMessage).toHaveBeenCalledWith({}, expect.objectContaining({ role: "agent", metadata: expect.objectContaining({ after_hours_pending: true }) }));
    expect(m.sendAdd).toHaveBeenCalled();
    for (const call of m.updateConversation.mock.calls) {
      expect(call[2]).not.toHaveProperty("is_human_takeover");
      expect(call[2]).not.toHaveProperty("human_takeover_at");
      expect(call[2]).not.toHaveProperty("status");
    }
  });
  it("takeover fora do modo noite (horário comercial / takeover manual): pula como antes", async () => {
    m.getConversationById.mockResolvedValue(conv(true));
    m.evaluateAfterHours.mockResolvedValue({ run: false });
    await m.processor!(job);
    expect(m.runAgent).not.toHaveBeenCalled();
  });
  it("limite por conversa estourado: silêncio", async () => {
    m.getConversationById.mockResolvedValue(conv(true));
    m.evaluateAfterHours.mockResolvedValue({ run: true, capped: true, handedAt: "x" });
    await m.processor!(job);
    expect(m.runAgent).not.toHaveBeenCalled();
  });
  it("humano respondeu no meio da geração: descarta", async () => {
    m.getConversationById.mockResolvedValue(conv(true));
    m.evaluateAfterHours.mockResolvedValueOnce({ run: true, capped: false, handedAt: "x" }).mockResolvedValueOnce({ run: false });
    await m.processor!(job);
    expect(m.runAgent).toHaveBeenCalled();
    expect(m.sendAdd).not.toHaveBeenCalled();
  });
  it("sem takeover: fluxo normal, sem modo noite", async () => {
    m.getConversationById.mockResolvedValue(conv(false));
    await m.processor!(job);
    expect(m.evaluateAfterHours).not.toHaveBeenCalled();
    expect(m.runAgent).toHaveBeenCalledWith(expect.objectContaining({ afterHoursPending: false }));
    expect(m.updateConversation).toHaveBeenCalledWith({}, "c", expect.objectContaining({ status: "waiting" }));
    expect(m.createMessage.mock.calls[0][1].metadata).not.toHaveProperty("after_hours_pending");
  });
});
