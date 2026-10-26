import { describe, expect, it, vi } from "vitest";
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getProcessMessageQueue: () => ({}), getUnansweredLeadSweepQueue: () => ({}) }));
vi.mock("@aula-agente/database", () => ({}));
vi.mock("../lib/lock.js", () => ({ acquireConversationLock: vi.fn(), releaseConversationLock: vi.fn() }));
import { runUnansweredLeadSweep, MAX_RETRIES_PER_SWEEP, retryJobId, type SweepDeps } from "./unanswered-lead-sweep.js";

const T0 = new Date("2026-10-26T15:00:00Z"); // segunda-feira 12:00 em São Paulo (expediente aberto)
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const tick = () => new Promise((r) => setTimeout(r, 0));

function world(opts: { settings?: Record<string, unknown>; convs?: Array<Record<string, any>> } = {}) {
  const orgSettings = { unanswered_lead_sweep_enabled: true, health_alert_phone: "5511999990000", ...(opts.settings ?? {}) };
  const msgs = (opts.convs ?? [{ id: "c1" }]).map((c, i) => ({
    messageId: `m-${c.id}`, conversationId: c.id, organizationId: "org1", evolutionInstanceId: "inst1", content: "Quero um consórcio de caminhão",
    mediaType: null, createdAt: c.createdAt ?? T0.toISOString(), isHumanTakeover: c.takeover ?? false, contactId: `ct-${c.id}`,
    contactName: "Junior", contactPhone: `55119999${String(1000 + i)}`, aiDisabled: c.aiDisabled ?? false, ...c.over,
  }));
  const outbound = new Set<string>(); // conversas que já tiveram resposta
  const ignored = new Set<string>(); const handoff = new Set<string>(); const failOn = new Set<string>();
  const kv = new Map<string, string>(); const locks = new Set<string>();
  const jobs = new Map<string, unknown>(); const enqueueCalls: string[] = []; const alerts: Array<{ phone: string; text: string }> = [];
  const logs: string[] = [];
  const deps: SweepDeps = {
    redisReady: () => true,
    listOrganizations: async () => [{ id: "org1", settings: orgSettings }],
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
    },
    acquireLock: async (cid) => { for (let i = 0; i < 50; i++) { if (!locks.has(cid)) { locks.add(cid); return "lv"; } await tick(); } return null; },
    releaseLock: async (cid) => { locks.delete(cid); },
    enqueue: async (data, jobId) => {
      if (failOn.has(`enqueue:${data.conversationId}`)) throw new Error("redis down");
      enqueueCalls.push(jobId); if (!jobs.has(jobId)) jobs.set(jobId, data); // BullMQ ignora jobId repetido
    },
    sendAlert: async (_o, phone, text) => { if (failOn.has("alert")) throw new Error("evolution down"); alerts.push({ phone, text }); },
    log: { info: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) },
  };
  return { deps, outbound, ignored, handoff, failOn, kv, jobs, enqueueCalls, alerts, logs, msgs };
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

  it("mensagem com mais de 6 h só aparece no resumo", async () => {
    const w = world({ convs: [{ id: "c1", ...old(400) }] });
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.skipped.too_old).toBe(1); expect(w.enqueueCalls).toEqual([]); expect(w.alerts).toEqual([]);
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
    expect(w.alerts[0].text).toMatch(/^Lead sem resposta há 27 min: Junior 55119999\d+ \(último contato: Quero um consórcio de caminhão\)\. Abra o CRM e responda\.$/);
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

  it("falha no envio do aviso libera a chave para tentar de novo", async () => {
    const w = world({ convs: [{ id: "c1", ...old(30) }] });
    w.kv.set("unanswered-sweep:retried:m-c1", min(-16).toISOString());
    w.failOn.add("alert");
    const s = await runUnansweredLeadSweep(w.deps, T0);
    expect(s.errors).toBe(1); expect(w.kv.has("unanswered-sweep:alerted:m-c1")).toBe(false);
    w.failOn.delete("alert");
    expect((await runUnansweredLeadSweep(w.deps, min(5))).alerted).toBe(1);
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
});
