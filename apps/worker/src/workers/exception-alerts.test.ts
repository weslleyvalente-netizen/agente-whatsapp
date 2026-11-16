import { describe, expect, it } from "vitest";
import { classifyTriage, DEFAULT_BUSINESS_CALENDAR, type ExceptionAlertsMode } from "@aula-agente/shared";
import type { AlertLedgerClaim, RecordedAlertSlot, TriageItem } from "@aula-agente/database";
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

interface World { ledger: Map<string, { id: number; status: string; channel: string; stage: number; user: string | null; mode: string; sendStarted: boolean }>; finishFailures: number; markFails: boolean; readinessOverride: Partial<{ pushConfigured: boolean; recipients: Array<{ userId: string; memberRole: string | null; pushDevices: number }> }>; pushes: Array<{ user: string; title: string; tag: string }>; mode: ExceptionAlertsMode; now: Date; items: TriageItem[]; failPush: boolean; failFor?: Set<string>; log: string[] }

function makeDeps(w: World, settings: Record<string, unknown> = {}): ExceptionAlertDeps {
  let nextId = 1;
  const key = (c: AlertLedgerClaim) => `${c.assignmentId}|${c.stage}|${c.channel}|${c.recipientUserId ?? "-"}`;
  return {
    now: () => w.now,
    listOrganizations: async () => [{ id: "org", settings: { exception_alerts_mode: w.mode, exception_alerts_activated_at: "2026-11-16T09:00:00Z", ...settings } as never }],
    currentMode: async () => w.mode,
    loadItems: async () => w.items,
    recordedSlots: async ids => {
      const m = new Map<string, RecordedAlertSlot[]>();
      for (const [k, v] of w.ledger) { const [aid] = k.split("|"); if (ids.includes(aid)) m.set(aid, [...(m.get(aid) ?? []), { stage: v.stage, channel: v.channel, recipientUserId: v.user, status: v.status }]); }
      return m;
    },
    managerIds: async () => ["gestor"],
    repUserIds: async () => ["marina", "marcio"],
    readinessFacts: async () => ({ pushConfigured: true, recipients: [{ userId: "gestor", memberRole: "owner", pushDevices: 1 }], ...w.readinessOverride }),
    claim: async c => { const k = key(c); if (w.ledger.has(k)) return null; const id = nextId++; w.ledger.set(k, { id, status: c.channel === "skipped" ? "skipped" : "claimed", channel: c.channel, stage: c.stage, user: c.recipientUserId, mode: c.mode, sendStarted: false }); return { id }; },
    markSending: async id => { if (w.markFails) throw new Error("db down"); for (const v of w.ledger.values()) if (v.id === id) v.sendStarted = true; return true; },
    finish: async (id, status) => { if (w.finishFailures > 0) { w.finishFailures--; throw new Error("db down"); } for (const v of w.ledger.values()) if (v.id === id) v.status = status; },
    release: async id => { for (const [k, v] of w.ledger) if (v.id === id) w.ledger.delete(k); },
    releaseStale: async () => ({ released: 0, unconfirmed: 0 }),
    sleep: async () => {},
    sendPush: async (_o, user, message, tag) => { if (w.failPush || w.failFor?.has(user)) throw new Error("boom"); w.pushes.push({ user, title: message.title, tag }); return "sent"; },
    log: { info: (...a) => w.log.push(a.join(" ")), error: (...a) => w.log.push(`ERR ${a.join(" ")}`) },
  };
}
const world = (over: Partial<World> = {}): World => ({ ledger: new Map(), pushes: [], mode: "on", now: T0, items: [item("a")], failPush: false, log: [], finishFailures: 0, markFails: false, readinessOverride: {}, ...over });

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
  it("worker parado: cada destinatário recebe só o estágio mais alto que lhe cabe; os anteriores ficam registrados como pulados", async () => {
    const w = world({ now: new Date(T0.getTime() + 61 * 60_000) });
    const s = await runExceptionAlertsOnce(makeDeps(w));
    expect(w.pushes.filter(p => p.user === "gestor").every(p => /CRÍTICO/.test(p.title))).toBe(true);
    expect(w.pushes.filter(p => p.user !== "gestor").every(p => /Escalonamento/.test(p.title))).toBe(true); // vendedor nunca recebe o crítico
    expect(s.skipped).toBe(3 + 2 + 2);
    const skippedBy = (u: string) => [...w.ledger.values()].filter(v => v.channel === "skipped" && v.user === u).map(v => v.stage).sort((a, b) => a - b);
    expect(skippedBy("gestor")).toEqual([0, 15, 30]);
    expect(skippedBy("marina")).toEqual([0, 15]);
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

// ---------- Correções da revisão do PR #102 ----------

describe("1) controle individual por destinatário", () => {
  it("falha para UM destinatário: os outros recebem e só ele é tentado no ciclo seguinte, sem duplicar ninguém", async () => {
    const w = world({ failFor: new Set(["marina"]) });
    const d = makeDeps(w);
    const s1 = await runExceptionAlertsOnce(d);
    expect(s1.sent).toBe(2);
    expect(w.pushes.map(p => p.user).sort()).toEqual(["gestor", "marcio"]);
    w.failFor = new Set();
    const s2 = await runExceptionAlertsOnce(d);
    expect(s2.sent).toBe(1);
    expect(w.pushes.map(p => p.user).sort()).toEqual(["gestor", "marcio", "marina"]); // marina entrou; ninguém repetido
  });
  it("destinatário que não recebeu o 15 ainda recebe o 15 quando os outros já o receberam (não é suprimido pelo estágio 'registrado' dos demais)", async () => {
    const w = world({ now: new Date(T0.getTime() + 15 * 60_000) });
    const d = makeDeps(w);
    // estágio 0 já tratado para todos
    for (const u of ["gestor", "marina", "marcio"]) w.ledger.set(`a|0|push|${u}`, { id: 100 + w.ledger.size, status: "sent", channel: "push", stage: 0, user: u, mode: "on", sendStarted: true });
    // 15 já enviado a gestor e marcio; marina ficou sem (falha anterior liberada)
    for (const u of ["gestor", "marcio"]) w.ledger.set(`a|15|push|${u}`, { id: 200 + w.ledger.size, status: "sent", channel: "push", stage: 15, user: u, mode: "on", sendStarted: true });
    const s = await runExceptionAlertsOnce(d);
    expect(s.sent).toBe(1);
    expect(w.pushes.map(p => p.user)).toEqual(["marina"]);
    expect(w.pushes[0].title).toMatch(/Cobrança/);
  });
  it("erro de banco ao reservar um destinatário não impede os demais", async () => {
    const w = world();
    const d = makeDeps(w);
    const inner = d.claim;
    d.claim = async c => { if (c.recipientUserId === "marcio") throw new Error("db"); return inner(c); };
    const s = await runExceptionAlertsOnce(d);
    expect(s.sent).toBe(2);
    expect(s.failed).toBe(1);
  });
  it("sem aparelho de um destinatário não bloqueia o estágio seguinte dele", async () => {
    const w = world();
    const d = { ...makeDeps(w), sendPush: async (_o: string, u: string, m: any, t: string) => { if (u === "marina") return "no_device" as const; w.pushes.push({ user: u, title: m.title, tag: t }); return "sent" as const; } };
    await runExceptionAlertsOnce(d);
    w.now = new Date(T0.getTime() + 15 * 60_000);
    await runExceptionAlertsOnce(d);
    expect(w.pushes.filter(p => p.user === "gestor")).toHaveLength(2);
    expect([...w.ledger.values()].filter(v => v.user === "marina").map(v => `${v.stage}:${v.status}`).sort()).toEqual(["0:skipped", "15:skipped"]);
  });
});

describe("2) transição segura de shadow para on", () => {
  it("o registro de sombra NÃO suprime o envio ao ligar o modo on", async () => {
    const w = world({ mode: "shadow" });
    const d = makeDeps(w);
    await runExceptionAlertsOnce(d);
    expect(w.pushes).toHaveLength(0);
    expect([...w.ledger.values()].every(v => v.channel === "shadow")).toBe(true);
    w.mode = "on";
    const s = await runExceptionAlertsOnce(d);
    expect(s.sent).toBe(3);
    expect(w.pushes.map(p => p.user).sort()).toEqual(["gestor", "marcio", "marina"]);
  });
  it("depois da transição o envio é por estágio mais alto devido (sem enxurrada) e continua sem duplicar", async () => {
    const w = world({ mode: "shadow" });
    const d = makeDeps(w);
    await runExceptionAlertsOnce(d);
    w.now = new Date(T0.getTime() + 30 * 60_000);
    await runExceptionAlertsOnce(d); // sombra do 30 (e 0/15 pulados em sombra)
    w.mode = "on";
    const s = await runExceptionAlertsOnce(d);
    expect(s.sent).toBe(3);
    expect(w.pushes.every(p => /Escalonamento/.test(p.title))).toBe(true);
    expect((await runExceptionAlertsOnce(d)).sent).toBe(0);
    expect(w.pushes).toHaveLength(3);
  });
  it("voltar de on para shadow não reenvia nem apaga o que já foi enviado", async () => {
    const w = world();
    const d = makeDeps(w);
    await runExceptionAlertsOnce(d);
    w.mode = "shadow";
    await runExceptionAlertsOnce(d);
    w.mode = "on";
    const s = await runExceptionAlertsOnce(d);
    expect(s.sent).toBe(0);
    expect(w.pushes).toHaveLength(3);
  });
  it("exceção anterior à ativação continua sem aviso mesmo depois da transição", async () => {
    const w = world({ mode: "shadow", items: [item("old", { assignedAt: "2026-11-16T08:00:00Z" })] });
    const d = makeDeps(w);
    await runExceptionAlertsOnce(d);
    w.mode = "on";
    await runExceptionAlertsOnce(d);
    expect(w.pushes).toHaveLength(0);
    expect(w.ledger.size).toBe(0);
  });
});

describe("3) push não duplica quando o banco falha entre o envio e a confirmação", () => {
  it("confirmação falha uma vez: tenta de novo e conta como enviado, um único push", async () => {
    const w = world({ items: [item("a")], finishFailures: 1 });
    const s = await runExceptionAlertsOnce(makeDeps(w));
    expect(s.sent).toBe(3);
    expect(w.pushes).toHaveLength(3);
    expect(s.unconfirmed).toBe(0);
  });
  it("confirmação falha sempre: o push já saiu e NUNCA é reenviado nos ciclos seguintes", async () => {
    const w = world({ finishFailures: 999 });
    const d = makeDeps(w);
    const s1 = await runExceptionAlertsOnce(d);
    expect(w.pushes).toHaveLength(3);
    expect(s1.unconfirmed).toBe(3);
    expect(s1.sent).toBe(0);
    await runExceptionAlertsOnce(d);
    await runExceptionAlertsOnce(d);
    expect(w.pushes).toHaveLength(3); // reserva continua no livro (marcada), então nada é reenviado
    expect([...w.ledger.values()].every(v => v.sendStarted && v.status === "claimed")).toBe(true);
  });
  it("sem conseguir gravar a marca 'enviando', o push NÃO é chamado", async () => {
    const w = world({ markFails: true });
    const s = await runExceptionAlertsOnce(makeDeps(w));
    expect(w.pushes).toHaveLength(0);
    expect(s.sent).toBe(0);
    expect(w.ledger.size).toBe(0); // reserva solta: o ciclo seguinte tenta com segurança
  });
  it("a marca 'enviando' é gravada antes do push (ordem das chamadas)", async () => {
    const w = world();
    const d = makeDeps(w);
    const order: string[] = [];
    const ms = d.markSending, sp = d.sendPush;
    d.markSending = async id => { order.push("mark"); return ms(id); };
    d.sendPush = async (...a) => { order.push("push"); return sp(...a); };
    await runExceptionAlertsOnce(d);
    expect(order.slice(0, 2)).toEqual(["mark", "push"]);
  });
  it("falha de envio (nada entregue) solta a reserva marcada, para repetir sem risco de duplicata", async () => {
    const w = world({ failPush: true });
    await runExceptionAlertsOnce(makeDeps(w));
    expect(w.ledger.size).toBe(0);
  });
});

describe("5) prontidão: destinatário administrativo e canal funcional antes de enviar", () => {
  it("modo on sem destinatário administrativo: nada enviado nem consumido", async () => {
    const w = world({ readinessOverride: { recipients: [] } });
    const s = await runExceptionAlertsOnce(makeDeps(w));
    expect(s.notReady).toBe(1);
    expect(w.pushes).toHaveLength(0);
    expect(w.ledger.size).toBe(0);
  });
  it("destinatário sem aparelho push, push não configurado ou papel de vendedor: bloqueia", async () => {
    for (const override of [
      { recipients: [{ userId: "gestor", memberRole: "owner", pushDevices: 0 }] },
      { pushConfigured: false },
      { recipients: [{ userId: "gestor", memberRole: "agent", pushDevices: 2 }] },
      { recipients: [{ userId: "gestor", memberRole: null, pushDevices: 2 }] },
    ]) {
      const w = world({ readinessOverride: override });
      const s = await runExceptionAlertsOnce(makeDeps(w));
      expect(s.notReady).toBe(1);
      expect(w.pushes).toHaveLength(0);
    }
  });
  it("quando a prontidão passa, o estágio devido sai (nada foi suprimido enquanto esteve bloqueado)", async () => {
    const w = world({ readinessOverride: { recipients: [] } });
    const d = makeDeps(w);
    await runExceptionAlertsOnce(d);
    w.readinessOverride = {};
    const s = await runExceptionAlertsOnce(d);
    expect(s.sent).toBe(3);
  });
  it("erro ao avaliar a prontidão é tratado como não pronto (falha segura)", async () => {
    const w = world();
    const d = { ...makeDeps(w), readinessFacts: async () => { throw new Error("db"); } };
    const s = await runExceptionAlertsOnce(d);
    expect(s.notReady).toBe(1);
    expect(w.pushes).toHaveLength(0);
  });
  it("modo sombra roda sem prontidão e registra 'ready: false' para a revisão dos 5 dias", async () => {
    const w = world({ mode: "shadow", readinessOverride: { recipients: [] } });
    const claims: Array<Record<string, unknown> | undefined> = [];
    const d = makeDeps(w);
    const inner = d.claim;
    d.claim = async c => { claims.push(c.detail); return inner(c); };
    const s = await runExceptionAlertsOnce(d);
    expect(s.shadowed).toBe(3);
    expect(s.notReady).toBe(0);
    expect(claims.every(c => c?.ready === false)).toBe(true);
  });
});
