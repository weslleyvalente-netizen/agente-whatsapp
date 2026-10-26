import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getProcessMessageQueue: () => ({}), getUnansweredLeadSweepQueue: () => ({}) }));
const db = vi.hoisted(() => ({ getInstancesByOrganization: vi.fn() }));
vi.mock("@aula-agente/database", () => ({ getAdminClient: () => ({}), getInstancesByOrganization: db.getInstancesByOrganization }));
vi.mock("../lib/lock.js", () => ({ acquireConversationLock: vi.fn(), releaseConversationLock: vi.fn() }));
import { sendEvolutionAlert, runUnansweredLeadSweep, MAX_RETRIES_PER_SWEEP, MAX_DIGEST_ITEMS, DefinitiveSendError, retryJobId, type SweepDeps, type EnqueueResult } from "./unanswered-lead-sweep.js";

const T0 = new Date("2026-10-26T15:00:00Z"); // segunda-feira 12:00 em São Paulo (expediente aberto)
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const tick = () => new Promise((r) => setTimeout(r, 0));

function world(opts: { settings?: Record<string, unknown>; convs?: Array<Record<string, any>> } = {}) {
  const orgSettings = { unanswered_lead_sweep_enabled: true, health_alert_phone: "5511999990000", ...(opts.settings ?? {}) };
  const msgs = (opts.convs ?? [{ id: "c1" }]).map((c, i) => ({
    messageId: `m-${c.id}`, conversationId: c.id, organizationId: "org1", evolutionInstanceId: "inst1", content: "Quero um consórcio de caminhão",
    mediaType: null, createdAt: c.createdAt ?? T0.toISOString(), isHumanTakeover: c.takeover ?? false, contactId: `ct-${c.id}`,
    contactName: "Junior", contactPhone: `55119999${String(1000 + i)}`, aiDisabled: c.aiDisabled ?? false, aiRoutedAt: c.notRouted ? null : T0.toISOString(), aiProcessedAt: c.processed ? T0.toISOString() : null, ...c.over,
  }));
  const outbound = new Set<string>(); // conversas que já tiveram resposta
  const ignored = new Set<string>(); const handoff = new Set<string>(); const failOn = new Set<string>();
  const kv = new Map<string, string>(); const locks = new Set<string>();
  const jobs = new Map<string, unknown>(); const enqueueCalls: string[] = []; const alerts: Array<{ phone: string; text: string }> = [];
  const logs: string[] = []; const attempts = new Map<string, number>(); let enqueueResult: EnqueueResult = { ok: true }; let stale: any[] = [];
  const deps: SweepDeps = {
    redisReady: () => true,
    listOrganizations: async () => [{ id: "org1", settings: orgSettings }],
    listStale: async () => stale,
    listInbound: async (orgId) => { if (orgId !== "org1") return []; if (failOn.has("list")) throw new Error("boom"); return msgs as any; },
    hasOutboundAfter: async (cid) => { await tick(); return outbound.has(cid); },
    isIgnored: async (_o, phone) => ignored.has(phone),
    isFrozen: async () => false,
    hasOpenHandoff: async (cid) => handoff.has(cid),
    resolveAgentId: async () => "agent1",
    redis: {
      get: async (k) => kv.get(k) ?? null,
      setNx: async (k, v) => { await tick(); if (kv.has(k)) return false; kv.set(k, v); return true; },
      del: async (k) => { kv.delete(k); },
      incr: async (k) => { const n = (attempts.get(k) ?? 0) + 1; attempts.set(k, n); kv.set(k, String(n)); return n; },
    },
    acquireLock: async (cid) => { for (let i = 0; i < 50; i++) { if (!locks.has(cid)) { locks.add(cid); return "lv"; } await tick(); } return null; },
    releaseLock: async (cid) => { locks.delete(cid); },
    enqueue: async (data, jobId) => {
      if (failOn.has(`enqueue:${data.conversationId}`)) throw new Error("redis down");
      enqueueCalls.push(jobId); if (!enqueueResult.ok) return enqueueResult; if (!jobs.has(jobId)) jobs.set(jobId, data); // BullMQ ignora jobId repetido
      return { ok: true };
    },
    sendAlert: async (_o, phone, text) => { if (failOn.has("alert")) throw new Error("timeout"); if (failOn.has("alert-definitive")) throw new DefinitiveSendError("500"); alerts.push({ phone, text }); },
    log: { info: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) },
  };
  return { deps, setEnqueueResult: (r: EnqueueResult) => { enqueueResult = r; }, setStale: (x: any[]) => { stale = x; }, outbound, ignored, handoff, failOn, kv, jobs, enqueueCalls, alerts, logs, msgs };
}
// mensagem de 11 min atrás no instante T0+0 => createdAt = T0-11min
const old = (m: number) => ({ createdAt: min(-m).toISOString() });

describe("runUnansweredLeadSweep", () => {
  it("mensagem perdida é reenfileirada uma única vez em duas varreduras seguidas", async () => {
    const w = world({ convs: [{ id: "c1", ...old(12) }] });
    const a = await runUnansweredLeadSweep(w.deps, T0);
    const b = await runUnansweredLeadSweep(w.deps, min(5));
    expect(a.retried).toBe(1); expect(b.retried).toBe(0);
    expect(w.jobs.size).toBe(1);
    expect(w.jobs.get(retryJobId("m-c1"))).toEqual({ conversationId: "c1", messageId: "m-c1", agentId: "agent1", organizationId: "org1" });
    expect(w.kv.get("unanswered-sweep:retried:m-c1")).toBe(T0.toISOString());
  });

  it("execuções concorrentes não enfileiram duas vezes", async () => {
    const w = world({ convs: [{ id: "c1", ...old(12) }, { id: "c2", ...old(20) }] });
    const [a, b] = await Promise.all([runUnansweredLeadSweep(w.deps, T0), runUnansweredLeadSweep(w.deps, T0)]);
    expect(a.retried + b.retried).toBe(2);
    expect(w.enqueueCalls.length).toBe(2);
    expect(w.jobs.size).toBe(2);
  });

  it("conversa que recebeu resposta no meio do caminho não é reenviada", async () => {
    const w = world({ convs: [{ id: "c1", ...old(12) }] });
    w.outbound.add("c1");
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.retried).toBe(0); expect(w.enqueueCalls).toEqual([]); expect(s.skipped.answered).toBe(1);
  });

  it("mensagem com menos de 10 min espera", async () => {
    const w = world({ convs: [{ id: "c1", ...old(5) }] });
    expect((await runUnansweredLeadSweep(w.deps, T0)).skipped.too_recent).toBe(1);
    expect(w.enqueueCalls).toEqual([]);
  });

  it("mensagem com mais de 24 h só aparece no resumo", async () => {
    const w = world({ convs: [{ id: "c1", ...old(25 * 60) }] });
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.skipped.too_old ?? 0).toBe(1); expect(w.enqueueCalls).toEqual([]); expect(w.alerts).toEqual([]);
  });

  it("takeover, ai_disabled, ignorado e handoff aberto não recebem retry", async () => {
    const w = world({ convs: [{ id: "t", takeover: true, ...old(12) }, { id: "a", aiDisabled: true, ...old(12) }, { id: "i", ...old(12) }, { id: "h", ...old(12) }] });
    w.ignored.add(w.msgs[2].contactPhone); w.handoff.add("h");
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.retried).toBe(0); expect(w.enqueueCalls).toEqual([]);
    expect(s.skipped).toMatchObject({ human_pending: 2, ai_disabled: 1, ignored: 1 });
  });

  it("escalonamento: só 15 min depois do retry, uma vez e em horário comercial", async () => {
    const w = world({ convs: [{ id: "c1", ...old(12) }] });
    await runUnansweredLeadSweep(w.deps, T0); // retry em T0
    expect((await runUnansweredLeadSweep(w.deps, min(10))).alerted).toBe(0);
    const s = await runUnansweredLeadSweep(w.deps, min(15));
    expect(s.alerted).toBe(1);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].phone).toBe("5511999990000");
    expect(w.alerts[0].text).toBe("Leads sem resposta (1):\n- Junior (final 1000), há 27 min: Quero um consórcio de caminhão\nAbra o CRM e responda.");
    expect((await runUnansweredLeadSweep(w.deps, min(20))).alerted).toBe(0);
    expect(w.alerts).toHaveLength(1);
  });

  it("fora do expediente não avisa e não marca; avisa na próxima varredura dentro do expediente", async () => {
    const w = world({ convs: [{ id: "c1", createdAt: new Date("2026-10-26T20:30:00Z").toISOString() }] }); // 17:30 SP
    w.kv.set("unanswered-sweep:retried:m-c1", new Date("2026-10-26T20:35:00Z").toISOString());
    const night = await runUnansweredLeadSweep(w.deps, new Date("2026-10-26T21:30:00Z")); // 18:30 SP, fechado
    expect(night.alerted).toBe(0); expect(night.skipped.outside_business_hours).toBe(1);
    expect(w.kv.has("unanswered-sweep:alerted:m-c1")).toBe(false);
    expect((await runUnansweredLeadSweep(w.deps, new Date("2026-10-26T20:50:00Z"))).alerted).toBe(1); // 17:50 SP
  });

  it("falha DEFINITIVA no envio libera a chave; timeout ambíguo mantém (sem repetir a cada varredura)", async () => {
    const w = world({ convs: [{ id: "c1", ...old(30) }] });
    w.kv.set("unanswered-sweep:retried:m-c1", min(-16).toISOString());
    w.failOn.add("alert-definitive");
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.errors).toBe(1); expect(w.kv.has("unanswered-sweep:alerted:m-c1")).toBe(false);
    w.failOn.delete("alert-definitive");
    expect((await runUnansweredLeadSweep(w.deps, min(5))).alerted).toBe(1);
    const w2 = world({ convs: [{ id: "c1", ...old(30) }] });
    w2.kv.set("unanswered-sweep:retried:m-c1", min(-16).toISOString());
    w2.failOn.add("alert");
    expect((await runUnansweredLeadSweep(w2.deps, T0)).errors).toBe(1);
    expect(w2.kv.has("unanswered-sweep:alerted:m-c1")).toBe(true);
    w2.failOn.delete("alert");
    expect((await runUnansweredLeadSweep(w2.deps, min(5))).alerted).toBe(0);
  });

  it("flag desligada: nada é varrido", async () => {
    const w = world({ settings: { unanswered_lead_sweep_enabled: false }, convs: [{ id: "c1", ...old(12) }] });
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.organizations).toBe(0); expect(w.enqueueCalls).toEqual([]);
  });

  it("Redis fora: não faz nada", async () => {
    const w = world({ convs: [{ id: "c1", ...old(12) }] });
    const s = await runUnansweredLeadSweep({ ...w.deps, redisReady: () => false }, T0);
    expect(s.organizations).toBe(0); expect(w.enqueueCalls).toEqual([]);
  });

  it("falha em uma conversa não interrompe as outras e libera a chave do retry", async () => {
    const w = world({ convs: [{ id: "c1", ...old(12) }, { id: "c2", ...old(13) }] });
    w.failOn.add("enqueue:c1");
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.errors).toBe(1); expect(s.retried).toBe(1);
    expect(w.kv.has("unanswered-sweep:retried:m-c1")).toBe(false);
    expect(w.jobs.has(retryJobId("m-c2"))).toBe(true);
    expect(w.logs.some((l) => /\d{6,}/.test(l.replace(/m-c\d/g, "")) && /5511/.test(l))).toBe(false); // sem telefone completo nos logs
  });

  it("limita a 10 retries por varredura", async () => {
    const convs = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, ...old(12) }));
    const w = world({ convs });
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.retried).toBe(MAX_RETRIES_PER_SWEEP); expect(s.skipped.retry_cap).toBe(3);
    expect((await runUnansweredLeadSweep(w.deps, min(5))).retried).toBe(3);
  });

  it("takeover sem resposta: aviso (sem retry) após 25 min, uma vez", async () => {
    const w = world({ convs: [{ id: "t", takeover: true, ...old(26) }] });
    expect((await runUnansweredLeadSweep(w.deps, T0)).alerted).toBe(1);
    expect((await runUnansweredLeadSweep(w.deps, min(5))).alerted).toBe(0);
    expect(w.enqueueCalls).toEqual([]);
  });

  it("H1: silêncio deliberado (processada pela IA, sem resposta) não é retentado nem avisado", async () => {
    const w = world({ convs: [{ id: "c1", processed: true, ...old(40) }] });
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.retried + s.alerted).toBe(0); expect(s.skipped.ai_processed).toBe(1);
    expect(w.enqueueCalls).toEqual([]); expect(w.alerts).toEqual([]);
  });

  it("H2: mensagem que o webhook não encaminhou à IA (takeover liberado depois, IA reativada) nunca é retentada", async () => {
    const w = world({ convs: [{ id: "c1", notRouted: true, ...old(40) }] });
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.retried).toBe(0); expect(s.skipped.not_ai_routed).toBe(1); expect(w.enqueueCalls).toEqual([]);
  });

  it("M2: um único resumo por organização, no máximo 5 leads, '+N outros' e contador de mais de 24 h", async () => {
    const convs = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, ...old(30 + i) }));
    const w = world({ convs });
    for (const c of convs) w.kv.set(`unanswered-sweep:retried:m-${c.id}`, min(-20).toISOString());
    w.setStale([{ conversationId: "old1", createdAt: min(-30 * 60) }, { conversationId: "old2", createdAt: min(-40 * 60) }]);
    w.outbound.add("old2");
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(w.alerts).toHaveLength(1);
    expect(s.alerted).toBe(MAX_DIGEST_ITEMS);
    const text = w.alerts[0].text;
    expect(text).toContain("Leads sem resposta (7):");
    expect(text.match(/^- /gm)).toHaveLength(5);
    expect(text).toContain("+2 outros.");
    expect(text).toContain("1 leads com mais de 24 h sem resposta.");
    expect(text).not.toMatch(/55119999\d{4}/); // só os 4 últimos dígitos
    // os 2 que ficaram de fora saem no próximo resumo
    const s2 = await runUnansweredLeadSweep(w.deps, min(5));
    expect(s2.alerted).toBe(2); expect(w.alerts).toHaveLength(2);
  });

  it("M2: as chaves de aviso são marcadas ANTES do envio", async () => {
    const w = world({ convs: [{ id: "c1", ...old(30) }] });
    w.kv.set("unanswered-sweep:retried:m-c1", min(-20).toISOString());
    let seen = false;
    const orig = w.deps.sendAlert;
    w.deps.sendAlert = async (...a) => { seen = w.kv.has("unanswered-sweep:alerted:m-c1"); return orig(...a); };
    await runUnansweredLeadSweep(w.deps, T0);
    expect(seen).toBe(true);
  });

  it("M3: retry roda de madrugada (fora do expediente); o aviso espera o expediente; 20 h depois ainda entra", async () => {
    const night = new Date("2026-10-26T06:00:00Z"); // 03:00 SP
    const w = world({ convs: [{ id: "c1", createdAt: new Date(night.getTime() - 20 * 60_000).toISOString() }] });
    expect((await runUnansweredLeadSweep(w.deps, night)).retried).toBe(1);
    const later = new Date("2026-10-26T14:00:00Z"); // 11:00 SP, mensagem com ~11 h
    expect((await runUnansweredLeadSweep(w.deps, later)).alerted).toBe(1);
  });

  it("M4: job descartado pelo BullMQ não conta como retry, libera a chave, e após 3 tentativas segue para o aviso", async () => {
    const w = world({ convs: [{ id: "c1", ...old(20) }] });
    w.setEnqueueResult({ ok: false, reason: "dedup_orphan" });
    for (let i = 0; i < 3; i++) {
      const s = await runUnansweredLeadSweep(w.deps, min(i * 5));
      expect(s.retried).toBe(0);
      expect(w.kv.has("unanswered-sweep:retried:m-c1")).toBe(false);
    }
    expect(w.enqueueCalls).toHaveLength(3);
    const s4 = await runUnansweredLeadSweep(w.deps, min(15));
    expect(w.enqueueCalls).toHaveLength(3); // não tenta uma 4ª vez
    expect(s4.alerted).toBe(1);
    expect(w.logs.some((l) => l.includes("dedup_orphan") && l.includes("m-c1") && l.includes("c1"))).toBe(true);
  });

  it("M-C: mensagem com 5 h sem retry anterior não vai para a IA; entra no resumo humano", async () => {
    const w = world({ convs: [{ id: "c1", ...old(5 * 60) }] });
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.retried).toBe(0); expect(w.enqueueCalls).toEqual([]); expect(s.alerted).toBe(1);
    expect(w.alerts[0].text).toContain("há 300 min");
  });

  it("M-C: backlog antigo (flag ligada depois) em horário fechado não envia nada à IA nem avisa", async () => {
    const night = new Date("2026-10-27T01:00:00Z"); // 22:00 SP
    const w = world({ convs: [{ id: "c1", createdAt: new Date(night.getTime() - 5 * 3_600_000).toISOString() }] });
    const s = await runUnansweredLeadSweep(w.deps, night);
    expect(s.retried + s.alerted).toBe(0); expect(w.enqueueCalls).toEqual([]);
  });

  it("L2: takeover com ai_processed ainda gera aviso aos 25 min", async () => {
    const w = world({ convs: [{ id: "t", takeover: true, processed: true, ...old(26) }] });
    expect((await runUnansweredLeadSweep(w.deps, T0)).alerted).toBe(1);
    expect(w.enqueueCalls).toEqual([]);
  });

  it("M-A: falha ao montar o texto libera as chaves (nada foi enviado)", async () => {
    const w = world({ convs: [{ id: "c1", ...old(30), over: { contactPhone: undefined } }] });
    w.kv.set("unanswered-sweep:retried:m-c1", min(-20).toISOString());
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.errors).toBe(1); expect(w.kv.has("unanswered-sweep:alerted:m-c1")).toBe(false);
  });
});

describe("sendEvolutionAlert: falhas antes do HTTP são definitivas (liberam as chaves)", () => {
  const env = { ...process.env };
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = "http://evo"; process.env.EVOLUTION_API_KEY = "k";
    db.getInstancesByOrganization.mockResolvedValue([{ instance_name: "inst", active_agent_id: "a" }]);
    vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
  });
  afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); });

  it("erro de banco", async () => {
    db.getInstancesByOrganization.mockRejectedValue(new Error("db"));
    await expect(sendEvolutionAlert("o", "1", "t")).rejects.toBeInstanceOf(DefinitiveSendError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sem instância ativa", async () => {
    db.getInstancesByOrganization.mockResolvedValue([{ instance_name: "i", active_agent_id: null }]);
    await expect(sendEvolutionAlert("o", "1", "t")).rejects.toBeInstanceOf(DefinitiveSendError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("variáveis de ambiente ausentes", async () => {
    delete process.env.EVOLUTION_API_URL;
    await expect(sendEvolutionAlert("o", "1", "t")).rejects.toBeInstanceOf(DefinitiveSendError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("HTTP 500 é definitivo; timeout/rede é ambíguo (erro comum)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(sendEvolutionAlert("o", "1", "t")).rejects.toBeInstanceOf(DefinitiveSendError);
    fetchMock.mockRejectedValue(new Error("The operation was aborted due to timeout"));
    const err = await sendEvolutionAlert("o", "1", "t").catch((e) => e);
    expect(err).toBeInstanceOf(Error); expect(err).not.toBeInstanceOf(DefinitiveSendError);
  });
  it("sucesso", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    await expect(sendEvolutionAlert("o", "1", "t")).resolves.toBeUndefined();
  });
});
