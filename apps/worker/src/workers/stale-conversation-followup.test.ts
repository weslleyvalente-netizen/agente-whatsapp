import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regressão do incidente de 13/11: a resposta da MarIAna que FALHOU ao enviar (send_failed_at) contava como "resposta entregue" e o
// follow-up automático ("Ficou alguma dúvida?") saía para um cliente que nunca recebeu a primeira mensagem.
// Roda o PROCESSADOR REAL do worker (capturado do BullMQ) com o banco, a fila e o modelo simulados.
const h = vi.hoisted(() => {
  const db = {
    hasFrozenContact: vi.fn(), getAllOrganizations: vi.fn(), getAgentsByOrganization: vi.fn(), getStaleWaitingConversations: vi.fn(), getStalePricedConversations: vi.fn(),
    getConversationById: vi.fn(), getRecentMessages: vi.fn(), getLastContactMessage: vi.fn(), getOpenTaskByConversation: vi.fn(), getOpenTaskByContactAndType: vi.fn(),
    getLatestTaskByConversationAndType: vi.fn(), getTaskEvents: vi.fn(), hasOpportunitySignalTask: vi.fn(), getOpenOpportunitiesByContact: vi.fn(), getStalledNegotiationEvidence: vi.fn(),
    createTaskWithDedup: vi.fn(), updateConversation: vi.fn(), addTaskEvent: vi.fn(), createMessage: vi.fn(), getAdminClient: vi.fn(), OPEN_TASK_STATUSES: ["pending", "in_progress", "rescheduled"],
  };
  return { db, captured: { processor: null as null | (() => Promise<unknown>) }, sendAdd: vi.fn(), runAgent: vi.fn() };
});
vi.mock("bullmq", () => ({ Worker: class { constructor(_n: string, processor: () => Promise<unknown>) { h.captured.processor = processor; } on() { return this; } } }));
vi.mock("@aula-agente/queue", () => ({
  getRedisConnection: () => ({}), getStaleConversationFollowupQueue: () => ({ upsertJobScheduler: vi.fn() }), getSendMessageQueue: () => ({ add: h.sendAdd }),
}));
vi.mock("@aula-agente/database", () => h.db);
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey: vi.fn().mockResolvedValue("k"), runAgent: h.runAgent }));
vi.mock("../lib/lock.js", () => ({ acquireConversationLock: vi.fn().mockResolvedValue("lock"), releaseConversationLock: vi.fn() }));
vi.mock("./low-intent-followup.js", () => ({ runLowIntentCadenceCheck: vi.fn().mockResolvedValue(new Set<string>()) }));
vi.mock("./libera-cred-resumption.js", () => ({ runLiberaCredResumptionCheck: vi.fn().mockResolvedValue({ created: 0, escalated: 0, suggestedLost: 0 }) }));
vi.mock("./scheduled-ad-closure.js", () => ({ runScheduledAdClosureCheck: vi.fn().mockResolvedValue([]) }));
vi.mock("./silence-retirement.js", () => ({ runSilenceRetirementCheck: vi.fn().mockResolvedValue(0) }));

import { startStaleConversationFollowupWorker } from "./stale-conversation-followup.js";

const NOW = new Date("2026-11-16T15:00:00Z"); // 12:00 em São Paulo
const org = { id: "org", settings: {} };
const agent = { id: "a1", is_active: true, provider: "anthropic", tools_config: { followup_automatico: { ativo: true, primeiro_followup_horas: 1, segundo_followup_horas: 23, janela_inicio_hora: 0, janela_fim_hora: 24 } } };
const conv = { id: "c1", contact_id: "ct1", created_at: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() };
const failed = { role: "agent", metadata: { send_failed_at: "2026-11-16T12:00:05Z", send_error: "Evolution API send error 400: Connection Closed" } };
const delivered = { role: "agent", evolution_message_id: "EVO-1", metadata: { model: "claude" } };

async function runTick() { startStaleConversationFollowupWorker(); await h.captured.processor!(); }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  Object.values(h.db).forEach((f) => typeof f === "function" && (f as ReturnType<typeof vi.fn>).mockReset());
  h.sendAdd.mockReset(); h.runAgent.mockReset();
  h.db.getAdminClient.mockReturnValue({});
  h.db.getAllOrganizations.mockResolvedValue([org]); h.db.getAgentsByOrganization.mockResolvedValue([agent]);
  h.db.getStaleWaitingConversations.mockResolvedValue([conv]); h.db.getStalePricedConversations.mockResolvedValue([]);
  h.db.hasFrozenContact.mockResolvedValue(false);
  h.db.getLastContactMessage.mockResolvedValue({ created_at: new Date(NOW.getTime() - 2 * 3_600_000).toISOString() });
  h.db.getLatestTaskByConversationAndType.mockResolvedValue(null); h.db.getTaskEvents.mockResolvedValue([]);
  h.db.getOpenTaskByConversation.mockResolvedValue(null); h.db.getOpenTaskByContactAndType.mockResolvedValue(null);
  h.db.getConversationById.mockResolvedValue({ id: "c1", is_human_takeover: false, evolution_instance_id: "inst", wa_contacts: { phone: "5511999999999", ai_disabled: false, name: "X" } });
  h.db.getOpenOpportunitiesByContact.mockResolvedValue([]);
  h.db.createMessage.mockResolvedValue({ id: "m-new" }); h.db.createTaskWithDedup.mockResolvedValue({ task: { id: "t1" } });
  h.runAgent.mockResolvedValue({ text: "Oi! Ficou alguma dúvida?", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cacheStatus: "miss", latencyMs: 1, toolCalls: [] });
});
afterEach(() => vi.useRealTimers());

// getRecentMessages(db, id, 1) é a leitura da "última mensagem" (1ª ao varrer, 2ª depois do lock); (db, id, 20) é o histórico para o modelo.
const lastMessages = (...seq: Array<object | null>) => {
  let i = 0;
  h.db.getRecentMessages.mockImplementation(async (_db: unknown, _id: string, limit: number) => (limit === 1 ? [seq[Math.min(i++, seq.length - 1)] ?? undefined].filter(Boolean) : []));
};

describe("stale-conversation-followup: mensagem que falhou ao enviar não conta como entregue", () => {
  it("CONTROLE: última mensagem da IA entregue e cliente em silêncio => o follow-up automático sai", async () => {
    lastMessages(delivered);
    await runTick();
    expect(h.runAgent).toHaveBeenCalledTimes(1); expect(h.sendAdd).toHaveBeenCalledTimes(1);
    expect(h.sendAdd.mock.calls[0][1]).toMatchObject({ conversationId: "c1", messageId: "m-new" });
  });
  it("última mensagem da IA com send_failed_at: NÃO há follow-up (o cliente nunca recebeu a primeira resposta)", async () => {
    lastMessages(failed);
    await runTick();
    expect(h.runAgent).not.toHaveBeenCalled(); expect(h.sendAdd).not.toHaveBeenCalled(); expect(h.db.createMessage).not.toHaveBeenCalled(); expect(h.db.createTaskWithDedup).not.toHaveBeenCalled();
  });
  it("a mensagem falha só DEPOIS do lock (2ª leitura): também não envia", async () => {
    lastMessages(delivered, failed);
    await runTick();
    expect(h.runAgent).not.toHaveBeenCalled(); expect(h.sendAdd).not.toHaveBeenCalled();
  });
  it("mensagem humana como última continua não elegível (comportamento existente)", async () => {
    lastMessages({ role: "human_agent", metadata: null });
    await runTick();
    expect(h.sendAdd).not.toHaveBeenCalled();
  });
});
