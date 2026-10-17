import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({ ping: async () => "PONG" }) }));
vi.mock("@aula-agente/database", () => ({ getAdminClient: () => ({}), getAllOrganizations: vi.fn(), getInstancesByOrganization: vi.fn() }));
vi.mock("./evolution.service.js", () => ({ getInstanceStatus: vi.fn(), sendText: vi.fn() }));

import {
  decideHealth, planNotifications, newNotifyState, evaluateOrganization, resetHealthMonitorState, getSnapshot,
  NOTIFY_COOLDOWN_MS, type HealthInputs, type HealthDeps,
} from "./health-monitor.js";

const NOW = new Date("2026-10-17T15:00:00Z"); // 12:00 em São Paulo, sábado? (17/10/2026 é sábado)
const base = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  now: NOW, businessOpenThroughout: true, lastCustomerMessageAt: new Date(NOW.getTime() - 10 * 60_000),
  historicalAvgInWindow: 5, redis: "ok", evolution: "connected", ...over,
});
const codes = (i: HealthInputs) => decideHealth(i).alerts.map((a) => a.code);

describe("decideHealth", () => {
  it("tudo normal: ok", () => {
    expect(decideHealth(base())).toEqual({ status: "ok", alerts: [], reasons: [] });
  });
  it("horário fechado nunca alerta, mesmo com tudo errado", () => {
    expect(codes(base({ businessOpenThroughout: false, lastCustomerMessageAt: null, redis: "down", evolution: "disconnected" }))).toEqual([]);
  });
  it("silêncio de 2 h ou mais com histórico alerta", () => {
    const d = decideHealth(base({ lastCustomerMessageAt: new Date(NOW.getTime() - 9 * 3_600_000) }));
    expect(d.status).toBe("warning");
    expect(d.alerts[0]).toMatchObject({ code: "silence" });
    expect(d.reasons[0]).toContain("9 h");
  });
  it("silêncio sem histórico (dia morto) não alerta", () => {
    expect(codes(base({ lastCustomerMessageAt: null, historicalAvgInWindow: 0 }))).toEqual([]);
  });
  it("sem nenhuma mensagem registrada, mas com histórico, alerta", () => {
    expect(codes(base({ lastCustomerMessageAt: null }))).toEqual(["silence"]);
  });
  it("menos de 2 h de silêncio não alerta", () => {
    expect(codes(base({ lastCustomerMessageAt: new Date(NOW.getTime() - 119 * 60_000) }))).toEqual([]);
  });
  it("Redis fora alerta", () => expect(codes(base({ redis: "down" }))).toEqual(["redis"]));
  it("Evolution desconectada ou sem resposta alerta", () => {
    expect(codes(base({ evolution: "disconnected" }))).toEqual(["evolution"]);
    expect(codes(base({ evolution: "unknown" }))).toEqual(["evolution"]);
  });
  it("vários motivos juntos", () => {
    expect(codes(base({ redis: "down", evolution: "disconnected", lastCustomerMessageAt: null }))).toEqual(["silence", "redis", "evolution"]);
  });
});

describe("planNotifications (anti-spam)", () => {
  const warn = decideHealth(base({ redis: "down" }));
  const ok = decideHealth(base());
  it("primeiro aviso é enviado", () => {
    const p = planNotifications(newNotifyState(), warn, 1000);
    expect(p.send.map((a) => a.code)).toEqual(["redis"]);
    expect(p.recovered).toBe(false);
  });
  it("não repete dentro de 2 h; repete depois", () => {
    const first = planNotifications(newNotifyState(), warn, 1000);
    expect(planNotifications(first.next, warn, 1000 + NOTIFY_COOLDOWN_MS - 1).send).toEqual([]);
    expect(planNotifications(first.next, warn, 1000 + NOTIFY_COOLDOWN_MS).send).toHaveLength(1);
  });
  it("motivo novo é avisado mesmo dentro da janela de outro", () => {
    const first = planNotifications(newNotifyState(), warn, 1000);
    const both = decideHealth(base({ redis: "down", evolution: "disconnected" }));
    expect(planNotifications(first.next, both, 2000).send.map((a) => a.code)).toEqual(["evolution"]);
  });
  it("avisa a normalização uma única vez", () => {
    const first = planNotifications(newNotifyState(), warn, 1000);
    const back = planNotifications(first.next, ok, 2000);
    expect(back.recovered).toBe(true);
    expect(planNotifications(back.next, ok, 3000).recovered).toBe(false);
  });
  it("nunca estava em alerta: sem aviso de normalizado", () => {
    expect(planNotifications(newNotifyState(), ok, 1000).recovered).toBe(false);
  });
});

describe("evaluateOrganization", () => {
  const mkDeps = (over: Partial<HealthDeps> = {}): HealthDeps & { sent: string[] } => {
    const sent: string[] = [];
    return {
      sent,
      lastCustomerMessageAt: async () => new Date(NOW.getTime() - 5 * 3_600_000),
      historicalAvgInWindow: async () => 4,
      pingRedis: async () => "ok",
      evolutionState: async () => "connected",
      sendWhatsApp: async (_o, _p, t) => { sent.push(t); },
      log: { error: vi.fn() },
      ...over,
    };
  };
  // quarta 14/10/2026 15:00Z = 12:00 BRT, dentro do expediente padrão; janela de 2 h também aberta.
  const WED = new Date("2026-10-14T15:00:00Z");
  const ctx = { organizationId: "org", settings: { handoff_notification_phone: "5511999998888" } };
  beforeEach(() => resetHealthMonitorState());

  it("silêncio em horário comercial: guarda snapshot e envia 1 aviso, sem repetir no ciclo seguinte", async () => {
    const deps = mkDeps({ lastCustomerMessageAt: async () => new Date(WED.getTime() - 5 * 3_600_000) });
    const snap = await evaluateOrganization(deps, ctx, { now: WED, notify: true });
    expect(snap.status).toBe("warning");
    expect(getSnapshot("org")?.status).toBe("warning");
    expect(deps.sent).toHaveLength(1);
    await evaluateOrganization(deps, ctx, { now: new Date(WED.getTime() + 5 * 60_000), notify: true });
    expect(deps.sent).toHaveLength(1);
  });
  it("envia 'normalizado' quando volta", async () => {
    let silent = true;
    const deps = mkDeps({ lastCustomerMessageAt: async () => new Date(WED.getTime() - (silent ? 5 * 3_600_000 : 60_000)) });
    await evaluateOrganization(deps, ctx, { now: WED, notify: true });
    silent = false;
    await evaluateOrganization(deps, ctx, { now: new Date(WED.getTime() + 60_000), notify: true });
    expect(deps.sent).toHaveLength(2);
    expect(deps.sent[1]).toContain("normalizado");
  });
  it("sem telefone configurado não envia nada, mas o snapshot existe", async () => {
    const deps = mkDeps({ pingRedis: async () => "down" });
    const snap = await evaluateOrganization(deps, { organizationId: "org", settings: {} }, { now: WED, notify: true });
    expect(snap.redis).toBe("down");
    expect(deps.sent).toHaveLength(0);
  });
  it("falha ao enviar o aviso não propaga", async () => {
    const deps = mkDeps({ pingRedis: async () => "down", sendWhatsApp: async () => { throw new Error("evolution down"); } });
    await expect(evaluateOrganization(deps, ctx, { now: WED, notify: true })).resolves.toMatchObject({ status: "warning" });
    expect(deps.log.error).toHaveBeenCalled();
  });
  it("erro nas sondas vira Redis down / Evolution unknown, sem lançar", async () => {
    const deps = mkDeps({ pingRedis: async () => { throw new Error("x"); }, evolutionState: async () => { throw new Error("y"); } });
    const snap = await evaluateOrganization(deps, ctx, { now: WED, notify: false });
    expect(snap).toMatchObject({ redis: "down", evolution: "unknown", status: "warning" });
    expect(deps.sent).toHaveLength(0);
  });
  it("fora do expediente (sábado) nunca alerta", async () => {
    const deps = mkDeps({ pingRedis: async () => "down" });
    const snap = await evaluateOrganization(deps, ctx, { now: NOW, notify: true });
    expect(snap.status).toBe("ok");
    expect(deps.sent).toHaveLength(0);
  });
  it("logo após a abertura (janela de 2 h não toda aberta) não alerta silêncio", async () => {
    const t = new Date("2026-10-14T11:30:00Z"); // 08:30 BRT
    const deps = mkDeps({ lastCustomerMessageAt: async () => new Date(t.getTime() - 14 * 3_600_000) });
    expect((await evaluateOrganization(deps, ctx, { now: t, notify: true })).status).toBe("ok");
  });
});
