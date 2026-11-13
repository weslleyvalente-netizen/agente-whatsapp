import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import evolutionWebhookRoutes, { adTouchConfig, AD_TOUCH_TIMEOUT_MS } from "./evolution.js";

process.env.WEBHOOK_SECRET = "test-secret";

const m = vi.hoisted(() => ({
  getInstanceByInstanceId: vi.fn(), getIgnoredContact: vi.fn(), ensureConversation: vi.fn(),
  saveMessage: vi.fn(), enqueueProcessMessage: vi.fn(), recordLeadOrigin: vi.fn(), recordAdTouch: vi.fn(),
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
vi.mock("../../services/lead-origin.service.js", () => ({ recordLeadOrigin: m.recordLeadOrigin }));
vi.mock("../../services/lead-ad-touch.service.js", () => ({ recordAdTouch: m.recordAdTouch }));
vi.mock("../../services/lead-human-message.js", () => ({ trackFirstHumanMessage: vi.fn() }));

const AD = { title: "Seu próximo carro", body: "Consórcio", sourceId: "999", sourceUrl: "https://www.instagram.com/p/AAA/", sourceType: "ad", ctwaClid: "clid" };
const TS = 1763046000; // 2025-11-13T15:00:00Z

const payload = (over: Record<string, unknown> = {}, key: Record<string, unknown> = {}) => ({
  event: "messages.upsert", instance: "inst",
  data: {
    key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: false, id: "WAMID1", ...key },
    message: { conversation: "Olá! Posso ter mais informações sobre isso?" }, messageType: "conversation", messageTimestamp: TS,
    contextInfo: { externalAdReply: AD }, ...over,
  },
});

const logs: Array<Record<string, any>> = [];
const logStream = { write: (chunk: string) => { try { logs.push(JSON.parse(chunk)); } catch { /* linha não-JSON */ } } };

async function post(body: unknown) {
  const app = Fastify({ logger: { level: "warn", stream: logStream as never } });
  await app.register(evolutionWebhookRoutes);
  const res = await app.inject({ method: "POST", url: "/webhooks/evolution", headers: { apikey: "test-secret" }, payload: body as never });
  await app.close();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  logs.length = 0;
  adTouchConfig.timeoutMs = AD_TOUCH_TIMEOUT_MS;
  m.getInstanceByInstanceId.mockResolvedValue({ id: "i1", organization_id: "org-1", active_agent_id: "ag" });
  m.getIgnoredContact.mockResolvedValue(null);
  m.ensureConversation.mockResolvedValue({ conversation: { id: "conv-1", is_human_takeover: false }, contact: { id: "ct-1", ai_disabled: false }, isNew: true });
  m.saveMessage.mockResolvedValue({ id: "m1", role: "contact", created_at: "2026-11-13T15:00:00Z" });
  m.recordLeadOrigin.mockResolvedValue(undefined);
  m.recordAdTouch.mockResolvedValue("recorded");
});

describe("webhook: origem estruturada por anúncio", () => {
  it("grava o toque com organização, contato, conversa, id da mensagem, horário original e o anúncio", async () => {
    const res = await post(payload());
    expect(res.statusCode).toBe(200);
    expect(m.recordAdTouch).toHaveBeenCalledTimes(1);
    const arg = m.recordAdTouch.mock.calls[0][1];
    expect(arg).toMatchObject({ organizationId: "org-1", contactId: "ct-1", conversationId: "conv-1", evolutionMessageId: "WAMID1", ad: AD });
    expect(arg.signal).toBeInstanceOf(AbortSignal);
    expect(arg.touchedAt.toISOString()).toBe(new Date(TS * 1000).toISOString());
  });

  it("o selo de origem existente continua sendo gravado (nada muda no card)", async () => {
    await post(payload());
    expect(m.recordLeadOrigin).toHaveBeenCalledTimes(1);
  });

  it("também reconhece o anúncio dentro de extendedTextMessage", async () => {
    await post(payload({ contextInfo: undefined, message: { extendedTextMessage: { text: "oi", contextInfo: { externalAdReply: AD } } }, messageType: "extendedTextMessage" }));
    expect(m.recordAdTouch).toHaveBeenCalledTimes(1);
    expect(m.recordAdTouch.mock.calls[0][1].ad).toMatchObject({ sourceId: "999" });
  });

  it("sem contexto de anúncio não chama o registro", async () => {
    await post(payload({ contextInfo: undefined }));
    expect(m.recordAdTouch).not.toHaveBeenCalled();
  });

  it("mensagem enviada pela loja (fromMe) não gera toque", async () => {
    await post(payload({}, { fromMe: true }));
    expect(m.recordAdTouch).not.toHaveBeenCalled();
  });

  it("contato com registro mínimo (ignorado) não gera toque", async () => {
    m.getIgnoredContact.mockResolvedValue({ retention_mode: "minimal_record" });
    await post(payload());
    expect(m.recordAdTouch).not.toHaveBeenCalled();
  });

  it("falha ao gravar o toque não derruba o recebimento: a mensagem segue para a IA", async () => {
    m.recordAdTouch.mockRejectedValue(new Error("relation lead_ad_touches does not exist"));
    const res = await post(payload());
    expect(res.statusCode).toBe(200);
    expect(m.saveMessage).toHaveBeenCalledTimes(1);
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });

  it("horário ausente usa o momento atual", async () => {
    await post(payload({ messageTimestamp: undefined }));
    expect(Math.abs(m.recordAdTouch.mock.calls[0][1].touchedAt.getTime() - Date.now())).toBeLessThan(5000);
  });
});

describe("webhook: limite de 2 s no registro do anúncio (a mensagem e a Mariana nunca esperam mais que isso)", () => {
  it("o limite padrão é de 2 segundos", () => {
    expect(AD_TOUCH_TIMEOUT_MS).toBe(2000);
    expect(adTouchConfig.timeoutMs).toBe(2000);
  });

  it("registro que nunca termina: a mensagem é salva, vai para a IA, a resposta é 200 e o timeout fica no log", async () => {
    adTouchConfig.timeoutMs = 60;
    let signal!: AbortSignal;
    m.recordAdTouch.mockImplementation((_db: unknown, p: { signal: AbortSignal }) => { signal = p.signal; return new Promise(() => {}); });
    const started = Date.now();
    const res = await post(payload());
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    expect(m.saveMessage).toHaveBeenCalledTimes(1);
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(60 + 400); // limite + folga da própria requisição, nunca esperando o registro
    expect(signal.aborted).toBe(true);
    const warn = logs.find((l) => l.event === "ad_touch_timeout");
    expect(warn).toMatchObject({ level: 40, organizationId: "org-1", contactId: "ct-1", evolutionMessageId: "WAMID1", timeoutMs: 60 });
    expect(String(warn?.msg)).toContain("timed out");
  });

  it("falha DEPOIS do timeout (rejeição tardia) não derruba nada nem gera 'unhandled rejection'", async () => {
    adTouchConfig.timeoutMs = 30;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      m.recordAdTouch.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("tardio")), 100)));
      const res = await post(payload());
      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
      expect(unhandled).not.toHaveBeenCalled();
      expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("registro lento mas dentro do limite conclui normalmente, sem aviso de timeout", async () => {
    adTouchConfig.timeoutMs = 500;
    m.recordAdTouch.mockImplementation(() => new Promise((r) => setTimeout(() => r("recorded"), 20)));
    const res = await post(payload());
    expect(res.statusCode).toBe(200);
    expect(m.recordAdTouch).toHaveBeenCalledTimes(1);
    expect(logs.find((l) => l.event === "ad_touch_timeout")).toBeUndefined();
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });

  it("falha rápida (não timeout) é registrada como erro, sem o evento de timeout, e a IA segue", async () => {
    m.recordAdTouch.mockRejectedValue(new Error("relation lead_ad_touches does not exist"));
    const res = await post(payload());
    expect(res.statusCode).toBe(200);
    expect(logs.find((l) => l.event === "ad_touch_timeout")).toBeUndefined();
    expect(logs.some((l) => l.level === 50 && String(l.msg).includes("Failed to record ad touch"))).toBe(true);
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });

  it("o registro roda ANTES do envio à IA (a atribuição existe quando a Mariana cria o negócio) e a IA recebe a mensagem uma única vez, mesmo com timeout", async () => {
    adTouchConfig.timeoutMs = 30;
    const order: string[] = [];
    m.recordAdTouch.mockImplementation(() => { order.push("touch"); return new Promise(() => {}); });
    m.enqueueProcessMessage.mockImplementation(async () => { order.push("enqueue"); });
    await post(payload());
    expect(order).toEqual(["touch", "enqueue"]);
    expect(m.enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });

  it("sem anúncio não há timer nem registro: o caminho normal não muda", async () => {
    await post(payload({ contextInfo: undefined }));
    expect(m.recordAdTouch).not.toHaveBeenCalled();
    expect(logs.filter((l) => l.event === "ad_touch_timeout" || /ad touch/i.test(String(l.msg)))).toHaveLength(0);
  });
});

