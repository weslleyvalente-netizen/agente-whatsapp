import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  processor: null as null | ((job: any) => Promise<void>),
  getConversationById: vi.fn(), evaluateAfterHours: vi.fn(), runAgent: vi.fn(), createMessage: vi.fn(), updateConversation: vi.fn(), sendAdd: vi.fn(),
  getRecentMessages: vi.fn(), getLastContactMessage: vi.fn(), getAgentById: vi.fn(), markMessagesAiProcessed: vi.fn(),
  getOrganizationById: vi.fn(), stampMessageMetadata: vi.fn(), hasOutboundMessageAfter: vi.fn(), claimHumanTakeover: vi.fn(), hasHumanMessageAfter: vi.fn(),
  listManagerUserIds: vi.fn(), sendPushToUser: vi.fn(),
}));
vi.mock("bullmq", () => ({ Worker: class { constructor(_q: string, fn: any) { m.processor = fn; } on() {} } }));
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getSendMessageQueue: () => ({ add: m.sendAdd }) }));
vi.mock("@aula-agente/database", () => ({
  syncSalesPipeline: async () => undefined, getAdminClient: () => ({}),
  getAgentById: m.getAgentById, markMessagesAiProcessed: m.markMessagesAiProcessed,
  getRecentMessages: m.getRecentMessages, getConversationById: m.getConversationById, getLastContactMessage: m.getLastContactMessage,
  createMessage: m.createMessage, updateConversation: m.updateConversation, updateMessageContent: async () => undefined,
  recordAiUsageEvent: async () => undefined, getInstanceById: async () => ({ id: "i", instance_name: "inst" }),
  getOrganizationById: m.getOrganizationById, stampMessageMetadata: m.stampMessageMetadata, hasOutboundMessageAfter: m.hasOutboundMessageAfter,
  claimHumanTakeover: m.claimHumanTakeover, hasHumanMessageAfter: m.hasHumanMessageAfter, listManagerUserIds: m.listManagerUserIds, sendPushToUser: m.sendPushToUser,
}));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey: async () => "k", resolveElevenLabsApiKey: async () => "k", runAgent: m.runAgent }));
vi.mock("../lib/lock.js", () => ({ acquireConversationLock: async () => "l", releaseConversationLock: async () => undefined }));
vi.mock("../lib/after-hours.js", () => ({ evaluateAfterHours: m.evaluateAfterHours }));
vi.mock("../lib/audio-transcription.js", () => ({ transcribeAudioMessage: vi.fn() }));
vi.mock("../lib/image-description.js", () => ({ describeImageMessage: vi.fn() }));
vi.mock("../lib/audio-generation.js", () => ({ generateSpeech: vi.fn(), isSimpleEnoughForAudio: () => false }));

import { startProcessMessageWorker } from "./process-message.js";

const NOW = new Date("2026-11-18T19:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const msg = (id: string, createdMinAgo: number, originalMinAgo?: number) => ({
  id, role: "contact", content: "oi", media_type: null, created_at: ago(createdMinAgo), conversation_id: "c",
  metadata: originalMinAgo === undefined ? null : { wa_original_at: ago(originalMinAgo) },
});
const conv = (over: Record<string, unknown> = {}) => ({ id: "c", is_human_takeover: false, assigned_to: null, evolution_instance_id: "i", contact_id: "ct", wa_contacts: { phone: "55", name: "N", ai_disabled: false }, ...over });
const job = { data: { conversationId: "c", messageId: "m1", agentId: "a", organizationId: "o" } };
const result = (text: string) => ({ text, model: "x", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cacheStatus: "none", latencyMs: 1, toolCalls: [] });
const setMode = (mode?: string, minutes?: number) => m.getOrganizationById.mockResolvedValue({ settings: { ...(mode ? { stale_message_guard_mode: mode } : {}), ...(minutes ? { stale_message_guard_minutes: minutes } : {}) } });
const setPending = (...ms: any[]) => { m.getRecentMessages.mockResolvedValue(ms); m.getLastContactMessage.mockResolvedValue(ms[ms.length - 1]); };

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  m.getAgentById.mockResolvedValue({ id: "a", is_active: true, provider: "anthropic", model: "x", tools_config: {} });
  m.getConversationById.mockResolvedValue(conv()); m.runAgent.mockResolvedValue(result("Temos sim!")); m.createMessage.mockResolvedValue({ id: "r1" });
  m.markMessagesAiProcessed.mockResolvedValue(1); setMode("on"); setPending(msg("m1", 180, 185));
  m.hasOutboundMessageAfter.mockResolvedValue(false); m.hasHumanMessageAfter.mockResolvedValue(false); m.stampMessageMetadata.mockResolvedValue(undefined);
  m.claimHumanTakeover.mockResolvedValue(true); m.listManagerUserIds.mockResolvedValue(["mgr"]); m.sendPushToUser.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
  startProcessMessageWorker();
});
afterEach(() => vi.useRealTimers());

const noAi = () => { expect(m.runAgent).not.toHaveBeenCalled(); expect(m.createMessage).not.toHaveBeenCalled(); expect(m.sendAdd).not.toHaveBeenCalled(); };

describe("worker: guarda de mensagem atrasada no processamento", () => {
  it("on + original de 3 h: a IA nem roda; vai para humano e avisa os gestores (sem dono)", async () => {
    await m.processor!(job);
    noAi();
    expect(m.claimHumanTakeover).toHaveBeenCalledWith({}, "c", NOW.toISOString());
    expect(m.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(m.listManagerUserIds).toHaveBeenCalledWith({}, "o");
    expect(m.stampMessageMetadata).toHaveBeenCalledWith({}, "m1", { stale_guard: expect.objectContaining({ source: "worker", action: "hold_and_human" }) });
    expect(m.markMessagesAiProcessed).toHaveBeenCalledTimes(1); // job termina normal: sem retry em loop
  });
  it("fila atrasada SEM timestamp original: usa a hora de gravação e também retém", async () => {
    setPending(msg("m1", 120));
    await m.processor!(job);
    noAi(); expect(m.claimHumanTakeover).toHaveBeenCalledTimes(1);
  });
  it("com vendedor: avisa o vendedor, não os gestores", async () => {
    m.getConversationById.mockResolvedValue(conv({ assigned_to: "seller-1" }));
    await m.processor!(job);
    expect(m.sendPushToUser).toHaveBeenCalledWith({}, "seller-1", expect.any(Object), { organizationId: "o" });
    expect(m.listManagerUserIds).not.toHaveBeenCalled();
  });
  it("retry/reinjeção do varredor: o MESMO job rodando de novo não repete push nem takeover (takeover já ligado)", async () => {
    await m.processor!(job);
    m.getConversationById.mockResolvedValue(conv({ is_human_takeover: true }));
    m.evaluateAfterHours.mockResolvedValue({ run: false });
    await m.processor!(job); await m.processor!(job);
    noAi(); expect(m.sendPushToUser).toHaveBeenCalledTimes(1); expect(m.claimHumanTakeover).toHaveBeenCalledTimes(1);
  });
  it("jobs concorrentes da mesma conversa: só quem ligou o takeover avisa", async () => {
    m.claimHumanTakeover.mockResolvedValueOnce(true).mockResolvedValue(false);
    await Promise.all([m.processor!(job), m.processor!(job), m.processor!(job)]);
    noAi(); expect(m.sendPushToUser).toHaveBeenCalledTimes(1);
  });
  it("várias mensagens no lote: velhas + uma NOVA do cliente => a IA responde o lote (idade pela mais recente)", async () => {
    setPending(msg("m1", 200, 205), msg("m2", 190, 195), msg("m3", 1, 1));
    await m.processor!(job);
    expect(m.runAgent).toHaveBeenCalledTimes(1); expect(m.createMessage).toHaveBeenCalledTimes(1);
    expect(m.claimHumanTakeover).not.toHaveBeenCalled();
  });
  it("várias mensagens no lote, TODAS velhas: nenhuma resposta e um único aviso", async () => {
    setPending(msg("m1", 200, 205), msg("m2", 190, 195), msg("m3", 150, 160));
    await m.processor!(job);
    noAi(); expect(m.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(m.stampMessageMetadata).toHaveBeenCalledTimes(1); expect(m.stampMessageMetadata.mock.calls[0][1]).toBe("m3");
  });
  it("já respondida depois do horário original: IA não responde, sem takeover nem aviso", async () => {
    m.hasOutboundMessageAfter.mockResolvedValue(true);
    await m.processor!(job);
    noAi(); expect(m.claimHumanTakeover).not.toHaveBeenCalled(); expect(m.sendPushToUser).not.toHaveBeenCalled();
  });
  it("modo on com TODAS as leituras de apoio falhando: a IA continua sem responder", async () => {
    for (const f of [m.hasOutboundMessageAfter, m.stampMessageMetadata, m.claimHumanTakeover, m.listManagerUserIds, m.sendPushToUser]) f.mockRejectedValue(new Error("db"));
    await m.processor!(job);
    noAi();
  });
  it("off/ausente: comportamento de antes (a IA responde mesmo a mensagem velha)", async () => {
    setMode(undefined);
    await m.processor!(job);
    expect(m.runAgent).toHaveBeenCalledTimes(1); expect(m.createMessage).toHaveBeenCalledTimes(1); expect(m.claimHumanTakeover).not.toHaveBeenCalled();
  });
  it("shadow: a IA responde como hoje e a sombra é registrada", async () => {
    setMode("shadow");
    await m.processor!(job);
    expect(m.createMessage).toHaveBeenCalledTimes(1); expect(m.claimHumanTakeover).not.toHaveBeenCalled();
    expect(m.stampMessageMetadata).toHaveBeenCalledWith({}, "m1", { stale_guard: expect.objectContaining({ mode: "shadow", would: "hold_and_human" }) });
  });
  it("falha ao ler a configuração: segue como hoje", async () => {
    m.getOrganizationById.mockRejectedValue(new Error("db"));
    await m.processor!(job);
    expect(m.createMessage).toHaveBeenCalledTimes(1);
  });
  it("mensagem recente: fluxo normal e nenhuma leitura de configuração", async () => {
    setPending(msg("m1", 1, 1));
    await m.processor!(job);
    expect(m.createMessage).toHaveBeenCalledTimes(1); expect(m.getOrganizationById).not.toHaveBeenCalled();
  });
});

describe("worker: releitura do estado antes de enviar", () => {
  beforeEach(() => { setPending(msg("m1", 5, 5)); });
  it("humano respondeu durante a geração (sem takeover gravado): descarta a resposta da IA", async () => {
    m.hasHumanMessageAfter.mockResolvedValue(true);
    await m.processor!(job);
    expect(m.runAgent).toHaveBeenCalledTimes(1); expect(m.createMessage).not.toHaveBeenCalled(); expect(m.sendAdd).not.toHaveBeenCalled();
    expect(m.hasHumanMessageAfter).toHaveBeenCalledWith({}, "c", msg("m1", 5, 5).created_at);
  });
  it("takeover ligado durante a geração: descarta (já existia)", async () => {
    m.runAgent.mockImplementation(async () => { m.getConversationById.mockResolvedValue(conv({ is_human_takeover: true })); return result("oi"); });
    await m.processor!(job);
    expect(m.createMessage).not.toHaveBeenCalled();
  });
  it("a mensagem ficou atrasada DURANTE a geração (30 min depois): descarta e chama humano uma vez", async () => {
    setMode("on", 10); setPending(msg("m1", 8, 8));
    m.runAgent.mockImplementation(async () => { vi.setSystemTime(new Date(NOW.getTime() + 30 * 60_000)); return result("resposta tardia"); });
    await m.processor!(job);
    expect(m.runAgent).toHaveBeenCalledTimes(1); expect(m.createMessage).not.toHaveBeenCalled(); expect(m.sendAdd).not.toHaveBeenCalled();
    expect(m.claimHumanTakeover).toHaveBeenCalledTimes(1); expect(m.sendPushToUser).toHaveBeenCalledTimes(1);
  });
  it("falha ao ler se humano respondeu: não bloqueia (o takeover relido já protege o caso comum)", async () => {
    m.hasHumanMessageAfter.mockRejectedValue(new Error("db"));
    await m.processor!(job);
    expect(m.createMessage).toHaveBeenCalledTimes(1);
  });
  it("conversa sem nada de errado: responde normalmente", async () => {
    await m.processor!(job);
    expect(m.createMessage).toHaveBeenCalledTimes(1); expect(m.sendAdd).toHaveBeenCalledTimes(1);
  });
});
