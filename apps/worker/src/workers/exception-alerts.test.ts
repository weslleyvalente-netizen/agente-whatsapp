import { describe, expect, it } from "vitest";
import { classifyTriage, DEFAULT_BUSINESS_CALENDAR, type ExceptionAlertsMode } from "@aula-agente/shared";
import type { AlertLedgerClaim, TriageItem } from "@aula-agente/database";
import { runExceptionAlertsOnce, type ExceptionAlertDeps } from "./exception-alerts.js";

const CAL = DEFAULT_BUSINESS_CALENDAR;
// segunda 2026-11-16, 08:00-18:00 BRT (UTC-3)
const T0 = new Date("2026-11-16T14:00:00Z"); // 11:00 BRT

function item(id: string, over: { assignedAt?: string; resolved?: boolean } = {}): TriageItem {
  const assignedAt = over.assignedAt ?? T0.toISOString();
  const anchorAt = "2026-11-16T12:00:00Z";
  return {
    kind: "exception", contact: null, chainReps: ["Márcio", "Marina"], conversation: null, events: [],
    assignment: { id, organization_id: "org", chain_id: `chain-${id}`, conversation_id: `c-${id}`, contact_id: `ct-${id}`, status: "exception", assigned_at: assignedAt, handoff_at: anchorAt } as never,
    triage: classifyTriage({
      kind: "exception", anchorAt, flaggedAt: assignedAt, humanReplies: [], lastMessage: null,
      resolvedEvent: over.resolved ? { kind: "resolved_confirmed", at: assignedAt } : null, conversationStatus: "waiting", hasOpenOpportunity: true, now: T0, calendar: CAL,
    }),
  };
}

interface World { ledger: Map<string, { id: number; status: string; channel: string; stage: number; user: string | null }>; pushes: Array<{ user: string; title: string; tag: string }>; mode: ExceptionAlertsMode; now: Date; items: TriageItem[]; failPush: boolean; log: string[] }

function makeDeps(w: World, settings: Record<string, unknown> = {}): ExceptionAlertDeps {
  let nextId = 1;
  const key = (c: AlertLedgerClaim) => `${c.assignmentId}|${c.stage}|${c.channel}|${c.recipientUserId ?? "-"}`;
  return {
    now: () => w.now,
    listOrganizations: async () => [{ id: "org", settings: { exception_alerts_mode: w.mode, exception_alerts_activated_at: "2026-11-16T09:00:00Z", ...settings } as never }],
    currentMode: async () => w.mode,
    loadItems: async () => w.items,
    recordedStages: async ids => {
      const m = new Map<string, number[]>();
      for (const [k, v] of w.ledger) { const [aid] = k.split("|"); if (ids.includes(aid)) m.set(aid, [...new Set([...(m.get(aid) ?? []), v.stage])]); }
      return m;
    },
    managerIds: async () => ["gestor"],
    repUserIds: async () => ["marina", "marcio"],
    claim: async c => { const k = key(c); if (w.ledger.has(k)) return null; const id = nextId++; w.ledger.set(k, { id, status: c.channel === "skipped" ? "skipped" : "claimed", channel: c.channel, stage: c.stage, user: c.recipientUserId }); return { id }; },
    finish: async (id, status) => { for (const v of w.ledger.values()) if (v.id === id) v.status = status; },
    release: async id => { for (const [k, v] of w.ledger) if (v.id === id) w.ledger.delete(k); },
    releaseStale: async () => 0,
    sendPush: async (_o, user, message, tag) => { if (w.failPush) throw new Error("boom"); w.pushes.push({ user, title: message.title, tag }); return "sent"; },
    log: { info: (...a) => w.log.push(a.join(" ")), error: (...a) => w.log.push(`ERR ${a.join(" ")}`) },
  };
}
const world = (over: Partial<World> = {}): World => ({ ledger: new Map(), pushes: [], mode: "on", now: T0, items: [item("a")], failPush: false, log: [], ...over });

describe("exception-alerts: segurança por padrão", () => {
  it("modo off/ausente: não consulta nada nem envia", async () => {
    const w = world({ mode: "off" });
    let loaded = false;
    const deps = { ...makeDeps(w), loadItems: async () => { loaded = true; return w.items; } };
    const s = await runExceptionAlertsOnce(deps);
    expect(loaded).toBe(false);
    expect(s).toMatchObject({ organizations: 0, sent: 0, shadowed: 0 });
  });
  it("sem exception_alerts_activated_at nada é avisado (mesmo em on)", async () => {
    const w = world();
    const deps = { ...makeDeps(w), listOrganizations: async () => [{ id: "org", settings: { exception_alerts_mode: "on" } as never }] };
    await runExceptionAlertsOnce(deps);
    expect(w.pushes).toHaveLength(0);
    expect(w.ledger.size).toBe(0);
  });
  it("sem retroativo: exceção criada antes da ativação não gera aviso", async () => {
    const w = world({ items: [item("old", { assignedAt: "2026-11-16T08:00:00Z" })] });
    await runExceptionAlertsOnce(makeDeps(w));
    expect(w.pushes).toHaveLength(0);
    expect(w.ledger.size).toBe(0);
  });
  it("sem destinatário configurado nada é consumido (o estágio continua devido)", async () => {
    const w = world();
    const deps = { ...makeDeps(w), managerIds: async () => [], repUserIds: async () => [] };
    const s = await runExceptionAlertsOnce(deps);
    expect(s.noRecipients).toBe(1);
    expect(w.ledger.size).toBe(0);
  });
});

describe("exception-alerts: modo sombra", () => {
  it("registra o que enviaria, sem enviar, e não repete no ciclo seguinte", async () => {
    const w = world({ mode: "shadow" });
    const d = makeDeps(w);
    const s1 = await runExceptionAlertsOnce(d);
    expect(s1.shadowed).toBe(3); // gestor + 2 vendedores
    expect(w.pushes).toHaveLength(0);
    expect([...w.ledger.values()].every(v => v.channel === "shadow")).toBe(true);
    const s2 = await runExceptionAlertsOnce(d);
    expect(s2.shadowed).toBe(0);
    expect(w.ledger.size).toBe(3);
  });
});

describe("exception-alerts: modo on", () => {
  it("estágio 0 vai a gestor e vendedores; segundo ciclo não duplica", async () => {
    const w = world();
    const d = makeDeps(w);
    const s1 = await runExceptionAlertsOnce(d);
    expect(s1.sent).toBe(3);
    expect(w.pushes.map(p => p.user).sort()).toEqual(["gestor", "marcio", "marina"]);
    const s2 = await runExceptionAlertsOnce(d);
    expect(s2.sent).toBe(0);
    expect(w.pushes).toHaveLength(3);
  });
  it("sobe a escada em minutos úteis: 15, 30 e 60 (60 só ao gestor)", async () => {
    const w = world();
    const d = makeDeps(w);
    await runExceptionAlertsOnce(d);
    w.now = new Date(T0.getTime() + 15 * 60_000); await runExceptionAlertsOnce(d);
    w.now = new Date(T0.getTime() + 30 * 60_000); await runExceptionAlertsOnce(d);
    w.now = new Date(T0.getTime() + 60 * 60_000); w.pushes.length = 0; await runExceptionAlertsOnce(d);
    expect(w.pushes.map(p => p.user)).toEqual(["gestor"]);
    expect(w.pushes[0].title).toMatch(/CRÍTICO/);
    expect([...new Set([...w.ledger.values()].map(v => v.stage))].sort((a, b) => a - b)).toEqual([0, 15, 30, 60]);
  });
  it("worker parado: envia só o estágio mais alto e registra os anteriores como pulados", async () => {
    const w = world({ now: new Date(T0.getTime() + 61 * 60_000) });
    const s = await runExceptionAlertsOnce(makeDeps(w));
    expect(w.pushes.every(p => /CRÍTICO/.test(p.title))).toBe(true);
    expect(s.skipped).toBe(3);
    expect([...w.ledger.values()].filter(v => v.channel === "skipped").map(v => v.stage).sort((a, b) => a - b)).toEqual([0, 15, 30]);
  });
  it("resolução válida cancela as cobranças", async () => {
    const w = world();
    const d = makeDeps(w);
    await runExceptionAlertsOnce(d);
    w.items = [item("a", { resolved: true })];
    w.now = new Date(T0.getTime() + 30 * 60_000);
    w.pushes.length = 0;
    await runExceptionAlertsOnce(d);
    expect(w.pushes).toHaveLength(0);
  });
  it("a exceção que sumiu da lista (encerrada por outro caminho) não gera mais cobrança", async () => {
    const w = world();
    const d = makeDeps(w);
    await runExceptionAlertsOnce(d);
    w.items = [];
    w.now = new Date(T0.getTime() + 30 * 60_000);
    w.pushes.length = 0;
    await runExceptionAlertsOnce(d);
    expect(w.pushes).toHaveLength(0);
  });
  it("falha de envio solta a reserva e o ciclo seguinte tenta de novo, sem duplicar o que já saiu", async () => {
    const w = world({ failPush: true });
    const d = makeDeps(w);
    await runExceptionAlertsOnce(d);
    expect(w.pushes).toHaveLength(0);
    expect(w.ledger.size).toBe(0);
    w.failPush = false;
    const s = await runExceptionAlertsOnce(d);
    expect(s.sent).toBe(3);
    expect(w.pushes).toHaveLength(3);
  });
  it("sem aparelho cadastrado vira 'pulado' (não é reenviado a cada minuto)", async () => {
    const w = world();
    const d = { ...makeDeps(w), sendPush: async () => "no_device" as const };
    await runExceptionAlertsOnce(d);
    const s2 = await runExceptionAlertsOnce(d);
    expect(s2.skipped).toBe(0);
    expect([...w.ledger.values()].every(v => v.status === "skipped")).toBe(true);
  });
  it("push não configurado não consome o estágio (tenta de novo quando configurarem)", async () => {
    const w = world();
    const d = { ...makeDeps(w), sendPush: async () => "unconfigured" as const };
    await runExceptionAlertsOnce(d);
    expect(w.ledger.size).toBe(0);
  });
  it("CONCORRÊNCIA: dois workers no mesmo instante enviam UMA vez por destinatário", async () => {
    const w = world();
    const a = makeDeps(w), b = makeDeps(w);
    await Promise.all([runExceptionAlertsOnce(a), runExceptionAlertsOnce(b)]);
    expect(w.pushes).toHaveLength(3);
    expect(new Set(w.pushes.map(p => p.user)).size).toBe(3);
  });
  it("kill switch durante o ciclo interrompe os envios seguintes", async () => {
    const w = world({ items: [item("a"), item("b"), item("c")] });
    const d = makeDeps(w);
    let calls = 0;
    d.currentMode = async () => (++calls > 1 ? "off" : "on");
    await runExceptionAlertsOnce(d);
    expect(new Set(w.pushes.map(p => p.tag.split("-")[1])).size).toBe(1); // só a primeira exceção saiu
  });
  it("o texto do aviso nunca leva dado do cliente e cita o handoff original", async () => {
    const w = world();
    await runExceptionAlertsOnce(makeDeps(w));
    expect(w.pushes[0].title).toBe("Lead sem vendedor: exceção de SLA");
  });
});
