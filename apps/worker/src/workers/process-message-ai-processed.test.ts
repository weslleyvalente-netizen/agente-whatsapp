import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  processor: null as null | ((job: any) => Promise<void>),
  getConversationById: vi.fn(), evaluateAfterHours: vi.fn(), runAgent: vi.fn(),
  createMessage: vi.fn(), updateConversation: vi.fn(), sendAdd: vi.fn(),
  getRecentMessages: vi.fn(), getLastContactMessage: vi.fn(), getAgentById: vi.fn(), markMessagesAiProcessed: vi.fn(),
}));
vi.mock("bullmq", () => ({ Worker: class { constructor(_q: string, fn: any) { m.processor = fn; } on() {} } }));
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getSendMessageQueue: () => ({ add: m.sendAdd }) }));
vi.mock("@aula-agente/database", () => ({
  syncSalesPipeline: async () => undefined, getAdminClient: () => ({}),
  getAgentById: m.getAgentById, markMessagesAiProcessed: m.markMessagesAiProcessed,
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

const contactMsg = { id: "m1", role: "contact", content: "ok, obrigado", media_type: null, created_at: "2026-10-10T15:00:00Z", conversation_id: "c" };
const conv = (ai = false) => ({ id: "c", is_human_takeover: false, evolution_instance_id: "i", contact_id: "ct", wa_contacts: { phone: "55", name: "N", ai_disabled: ai } });
const job = { data: { conversationId: "c", messageId: "m1", agentId: "a", organizationId: "o" } };
const result = (text: string) => ({ text, model: "x", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cacheStatus: "none", latencyMs: 1, toolCalls: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  m.getAgentById.mockResolvedValue({ id: "a", is_active: true, provider: "anthropic", model: "x", tools_config: {} });
  m.getRecentMessages.mockResolvedValue([contactMsg]);
  m.getLastContactMessage.mockResolvedValue(contactMsg);
  m.getConversationById.mockResolvedValue(conv());
  m.runAgent.mockResolvedValue(result("Temos sim!"));
  m.createMessage.mockResolvedValue({ id: "r1" });
  m.markMessagesAiProcessed.mockResolvedValue(1);
  startProcessMessageWorker();
});

describe("process-message marca ai_processed_at em toda saída normal", () => {
  it.each([
    ["resposta enviada", () => {}],
    ["silêncio deliberado (resposta vazia)", () => m.runAgent.mockResolvedValue(result(""))],
    ["agente inativo", () => m.getAgentById.mockResolvedValue({ id: "a", is_active: false })],
    ["IA desativada para o contato", () => m.getConversationById.mockResolvedValue(conv(true))],
    ["nada pendente", () => m.getRecentMessages.mockResolvedValue([])],
  ])("%s", async (_n, setup) => {
    setup();
    await m.processor!(job);
    expect(m.markMessagesAiProcessed).toHaveBeenCalledTimes(1);
    expect(m.markMessagesAiProcessed).toHaveBeenCalledWith({}, "c", expect.any(Date), expect.any(String));
  });
  it("exceção (o BullMQ tenta de novo): NÃO marca", async () => {
    m.runAgent.mockRejectedValue(new Error("llm down"));
    await expect(m.processor!(job)).rejects.toThrow();
    expect(m.markMessagesAiProcessed).not.toHaveBeenCalled();
  });
  it("falha ao marcar não derruba o job", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.markMessagesAiProcessed.mockRejectedValue(new Error("db"));
    await expect(m.processor!(job)).resolves.toBeUndefined();
  });
  it("L1: marca que nunca resolve não prende o job (teto ~2 s)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.markMessagesAiProcessed.mockImplementation(() => new Promise(() => {}));
    const t0 = Date.now();
    await expect(m.processor!(job)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 8000);
});
