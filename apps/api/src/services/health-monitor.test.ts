import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/redis-probe.js", () => ({ probeRedis: async () => true }));
const members = vi.hoisted(() => ({ data: [] as Array<{ user_id: string }>, roles: null as unknown }));
const pushMock = vi.hoisted(() => vi.fn());
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ in: (_c: string, roles: unknown) => { members.roles = roles; return Promise.resolve({ data: members.data, error: null }); } }) }) }),
  }),
  getAllOrganizations: vi.fn(), getInstancesByOrganization: vi.fn(), sendPushToUser: pushMock,
}));
vi.mock("./evolution.service.js", () => ({ getInstanceStatus: vi.fn(), sendText: vi.fn() }));

import {
  defaultDeps, decideHealth, planNotifications, newNotifyState, evaluateOrganization, resetHealthMonitorState, getSnapshot,
  NOTIFY_COOLDOWN_MS, MIN_HISTORICAL_AVG, SILENCE_WINDOW_MS, type HealthInputs, type HealthDeps,
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
  it("silêncio de 9 h com histórico alerta em horas", () => {
    const d = decideHealth(base({ lastCustomerMessageAt: new Date(NOW.getTime() - 9 * 3_600_000) }));
    expect(d.status).toBe("warning");
    expect(d.alerts[0]).toMatchObject({ code: "silence" });
    expect(d.reasons[0]).toContain("há 9 h");
  });
  it("silêncio de 44 min não alerta; 45 min alerta com 'há 45 min'", () => {
    expect(codes(base({ lastCustomerMessageAt: new Date(NOW.getTime() - 44 * 60_000) }))).toEqual([]);
    const d = decideHealth(base({ lastCustomerMessageAt: new Date(NOW.getTime() - 45 * 60_000), evolution: "disconnected" }));
    expect(d.reasons[0]).toBe("Sem mensagens de clientes há 45 min");
  });
  it("90 min vira 'há 1 h'", () => {
    const d = decideHealth(base({ lastCustomerMessageAt: new Date(NOW.getTime() - 90 * 60_000), evolution: "disconnected" }));
    expect(d.reasons[0]).toBe("Sem mensagens de clientes há 1 h");
  });
  it("sem registro: 'há mais de 45 min'", () => {
    const d = decideHealth(base({ lastCustomerMessageAt: null, evolution: "disconnected" }));
    expect(d.reasons[0]).toBe("Sem mensagens de clientes há mais de 45 min");
  });
  it("causa provável quando Evolution conectada e Redis ok", () => {
    const d = decideHealth(base({ lastCustomerMessageAt: new Date(NOW.getTime() - 50 * 60_000) }));
    expect(d.reasons[0]).toBe("Sem mensagens de clientes há 50 min; o WhatsApp consta conectado mas pode não estar recebendo (reconectar pelo QR Code)");
  });
  it("sem causa provável quando Evolution desconectada ou Redis fora", () => {
    expect(decideHealth(base({ lastCustomerMessageAt: null, evolution: "disconnected" })).reasons[0]).not.toContain("pode não estar recebendo");
    expect(decideHealth(base({ lastCustomerMessageAt: null, redis: "down" })).reasons[0]).not.toContain("pode não estar recebendo");
  });
  it("histórico fraco (média < mínimo) não alerta silêncio", () => {
    expect(codes(base({ lastCustomerMessageAt: null, historicalAvgInWindow: MIN_HISTORICAL_AVG - 0.5 }))).toEqual([]);
    expect(codes(base({ lastCustomerMessageAt: null, historicalAvgInWindow: MIN_HISTORICAL_AVG }))).toEqual(["silence"]);
  });
  it("silêncio sem histórico (dia morto) não alerta", () => {
    expect(codes(base({ lastCustomerMessageAt: null, historicalAvgInWindow: 0 }))).toEqual([]);
  });
  it("sem nenhuma mensagem registrada, mas com histórico, alerta", () => {
    expect(codes(base({ lastCustomerMessageAt: null }))).toEqual(["silence"]);
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
  it("cooldown de 30 min: não reenvia aos 29, reenvia aos 30", () => {
    expect(NOTIFY_COOLDOWN_MS).toBe(30 * 60_000);
    expect(SILENCE_WINDOW_MS).toBe(45 * 60_000);
    const first = planNotifications(newNotifyState(), warn, 1000);
    expect(planNotifications(first.next, warn, 1000 + 29 * 60_000).send).toEqual([]);
    expect(planNotifications(first.next, warn, 1000 + 30 * 60_000).send).toHaveLength(1);
  });
  it("não repete dentro do cooldown; repete depois", () => {
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
  it("H1: fechar o expediente não é normalização (sem aviso, estado mantido)", () => {
    const first = planNotifications(newNotifyState(), warn, 1000);
    const closed = planNotifications(first.next, ok, 2000, false);
    expect(closed.recovered).toBe(false);
    expect(closed.next.wasWarning).toBe(true);
    // na reabertura, se normalizou de fato, aí sim avisa
    expect(planNotifications(closed.next, ok, 3000, true).recovered).toBe(true);
  });
  it("nunca estava em alerta: sem aviso de normalizado", () => {
    expect(planNotifications(newNotifyState(), ok, 1000).recovered).toBe(false);
  });
});

describe("evaluateOrganization", () => {
  const mkDeps = (over: Partial<HealthDeps> = {}): HealthDeps & { sent: string[]; pushed: Array<{ title: string; body: string }> } => {
    const sent: string[] = [];
    const pushed: Array<{ title: string; body: string }> = [];
    return {
      sent, pushed,
      lastCustomerMessageAt: async () => new Date(NOW.getTime() - 5 * 3_600_000),
      historicalAvgInWindow: async () => 4,
      pingRedis: async () => "ok",
      evolutionState: async () => "connected",
      sendWhatsApp: async (_o, _p, t) => { sent.push(t); },
      sendPush: async (_o, t) => { pushed.push(t); },
      log: { error: vi.fn() },
      ...over,
    };
  };
  // quarta 14/10/2026 15:00Z = 12:00 BRT, dentro do expediente padrão; janela de 45 min também aberta.
  const WED = new Date("2026-10-14T15:00:00Z");
  const ctx = { organizationId: "org", settings: { health_alert_phone: "5511999998888" } };
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
  it("handoff_notification_phone NÃO é usado para alertas", async () => {
    const deps = mkDeps({ pingRedis: async () => "down" });
    await evaluateOrganization(deps, { organizationId: "org", settings: { handoff_notification_phone: "5511000000000" } as any }, { now: WED, notify: true });
    expect(deps.sent).toHaveLength(0);
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
  it("telefone + push: ambos chamados com a mesma mensagem", async () => {
    const deps = mkDeps({ pingRedis: async () => "down" });
    await evaluateOrganization(deps, ctx, { now: WED, notify: true });
    expect(deps.sent).toHaveLength(1);
    expect(deps.pushed).toEqual([{ title: "Alerta do CRM", body: "Redis fora do ar ou lento (a fila de mensagens pode estar parada)" }]);
    expect(deps.sent[0]).toContain("Veja Configurações > Recuperar mensagens perdidas.");
    expect(deps.pushed[0]!.body).not.toContain("Veja Configurações");
  });
  it("sem telefone: só push", async () => {
    const deps = mkDeps({ pingRedis: async () => "down" });
    await evaluateOrganization(deps, { organizationId: "org", settings: {} }, { now: WED, notify: true });
    expect(deps.sent).toHaveLength(0);
    expect(deps.pushed).toHaveLength(1);
  });
  it("sendPush lança: WhatsApp ainda enviado e monitor não lança", async () => {
    const deps = mkDeps({ pingRedis: async () => "down", sendPush: async () => { throw new Error("push"); } });
    await expect(evaluateOrganization(deps, ctx, { now: WED, notify: true })).resolves.toMatchObject({ status: "warning" });
    expect(deps.sent).toHaveLength(1);
    expect(deps.log.error).toHaveBeenCalledWith({ organizationId: "org", errName: "Error" }, expect.stringContaining("push"));
  });
  it("sendWhatsApp lança: push ainda enviado", async () => {
    const deps = mkDeps({ pingRedis: async () => "down", sendWhatsApp: async () => { throw new Error("evo"); } });
    await evaluateOrganization(deps, ctx, { now: WED, notify: true });
    expect(deps.pushed).toHaveLength(1);
  });
  it("normalizado vai nos dois canais", async () => {
    let silent = true;
    const deps = mkDeps({ lastCustomerMessageAt: async () => new Date(WED.getTime() - (silent ? 5 * 3_600_000 : 60_000)) });
    await evaluateOrganization(deps, ctx, { now: WED, notify: true });
    silent = false;
    await evaluateOrganization(deps, ctx, { now: new Date(WED.getTime() + 60_000), notify: true });
    expect(deps.pushed[1]).toEqual({ title: "CRM normalizado", body: "As mensagens de clientes voltaram a chegar." });
    expect(deps.sent[1]).toContain("normalizado");
  });
  it("notify=false não envia nada", async () => {
    const deps = mkDeps({ pingRedis: async () => "down" });
    await evaluateOrganization(deps, ctx, { now: WED, notify: false });
    expect(deps.sent).toHaveLength(0);
    expect(deps.pushed).toHaveLength(0);
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
  it("logo após a abertura (janela de 45 min não toda aberta) não alerta silêncio", async () => {
    const t = new Date("2026-10-14T11:20:00Z"); // 08:20 BRT: 45 min antes ainda estava fechado
    const ok = new Date("2026-10-14T11:50:00Z"); // 08:50 BRT: janela toda aberta
    const dOk = mkDeps({ lastCustomerMessageAt: async () => new Date(ok.getTime() - 14 * 3_600_000) });
    expect((await evaluateOrganization(dOk, ctx, { now: ok, notify: false })).status).toBe("warning");
    const deps = mkDeps({ lastCustomerMessageAt: async () => new Date(t.getTime() - 14 * 3_600_000) });
    expect((await evaluateOrganization(deps, ctx, { now: t, notify: true })).status).toBe("ok");
  });
});

describe("defaultDeps.sendPush", () => {
  beforeEach(() => { pushMock.mockReset(); members.data = []; });
  it("envia a owners e admins com url, tag e organizationId", async () => {
    members.data = [{ user_id: "u1" }, { user_id: "u2" }];
    pushMock.mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
    await defaultDeps.sendPush("org", { title: "T", body: "B" });
    expect(members.roles).toEqual(["owner", "admin"]);
    expect(pushMock).toHaveBeenCalledTimes(2);
    expect(pushMock).toHaveBeenCalledWith(expect.anything(), "u1", { title: "T", body: "B", url: "/settings", tag: "health-alert" }, { organizationId: "org" });
  });
  it("sem assinatura (sent 0) não é erro", async () => {
    members.data = [{ user_id: "u1" }];
    pushMock.mockResolvedValue({ sent: 0, removed: 0, failed: 0 });
    await expect(defaultDeps.sendPush("org", { title: "T", body: "B" })).resolves.toBeUndefined();
  });
  it("organização sem owners/admins não quebra", async () => {
    await expect(defaultDeps.sendPush("org", { title: "T", body: "B" })).resolves.toBeUndefined();
    expect(pushMock).not.toHaveBeenCalled();
  });
  it("falha em um usuário não impede os outros", async () => {
    members.data = [{ user_id: "u1" }, { user_id: "u2" }];
    pushMock.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({ sent: 1, removed: 0, failed: 0 });
    await expect(defaultDeps.sendPush("org", { title: "T", body: "B" })).resolves.toBeUndefined();
    expect(pushMock).toHaveBeenCalledTimes(2);
  });
});
