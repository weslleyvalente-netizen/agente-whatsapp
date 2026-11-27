import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderMonitorStatus, resetProviderMonitorStatus, runProviderHealthCycle, type ProviderDeps } from "./provider-health-monitor.js";

const now = new Date("2026-11-27T13:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const INST = { id: "i1", instance_name: "weslley", provider: "uazapi", provider_token_encrypted: "enc" };

function deps(over: Partial<ProviderDeps> = {}, mode = "shadow"): ProviderDeps & { log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } } {
  return {
    listOrganizations: vi.fn(async () => [{ id: "org", settings: { provider_health_monitor_mode: mode } }]),
    listInstances: vi.fn(async () => [INST]),
    providerSnapshot: vi.fn(async () => ({ ok: true, state: "connected", lastInboundAt: ago(2) })),
    crmLastInboundAt: vi.fn(async () => ago(2)),
    recentOutboundAt: vi.fn(async () => null),
    webhookPulseAt: vi.fn(() => ago(1)),
    processStartedAt: vi.fn(() => ago(120)),
    queueSnapshot: vi.fn(async () => ({ ok: true, waiting: 0, oldestWaitingAt: null })),
    autoRecoverEnabled: vi.fn(async () => false),
    getOpenAlert: vi.fn(async () => null),
    openAlert: vi.fn(async () => true),
    claimRepeat: vi.fn(async () => true),
    resolveAlert: vi.fn(async () => undefined),
    notifyManagers: vi.fn(async () => 1),
    log: { info: vi.fn(), error: vi.fn() },
    ...over,
  } as never;
}

beforeEach(() => resetProviderMonitorStatus());

describe("runProviderHealthCycle", () => {
  it("modo off (padrão): não consulta a UAZAPI nem grava nada", async () => {
    const d = deps({}, "off");
    await runProviderHealthCycle(d, now);
    expect(d.providerSnapshot).not.toHaveBeenCalled();
    expect(d.openAlert).not.toHaveBeenCalled();
  });

  it("só avalia instâncias com provider 'uazapi'", async () => {
    const d = deps({ listInstances: vi.fn(async () => [{ ...INST, provider: "evolution" }]) });
    await runProviderHealthCycle(d, now);
    expect(d.providerSnapshot).not.toHaveBeenCalled();
  });

  it("sombra: webhook não entregou (UAZAPI à frente do CRM) → grava alerta 'shadow' com evidência e NÃO notifica", async () => {
    const d = deps({ providerSnapshot: vi.fn(async () => ({ ok: true, state: "connected", lastInboundAt: ago(10) })), crmLastInboundAt: vi.fn(async () => ago(45)) });
    await runProviderHealthCycle(d, now);
    expect(d.openAlert).toHaveBeenCalledWith("org", "weslley", "provider_ahead", "shadow", now, expect.objectContaining({ lag_minutes: 35, auto_recover_enabled: false }));
    expect(d.notifyManagers).not.toHaveBeenCalled();
  });

  it("on: abre e avisa os gestores uma vez; dentro de 60 min não repete; depois repete", async () => {
    const bad = { providerSnapshot: vi.fn(async () => ({ ok: true, state: "disconnected", lastInboundAt: null })) };
    const d = deps(bad, "on");
    await runProviderHealthCycle(d, now);
    expect(d.openAlert).toHaveBeenCalledWith("org", "weslley", "provider_disconnected", "on", now, expect.anything());
    expect(d.notifyManagers).toHaveBeenCalledTimes(1);

    const open = { id: "a1", openedAt: ago(30), lastNotifiedAt: ago(30) };
    const d2 = deps({ ...bad, getOpenAlert: vi.fn(async (_o, _i, k) => (k === "provider_disconnected" ? open : null)) }, "on");
    await runProviderHealthCycle(d2, now);
    expect(d2.claimRepeat).not.toHaveBeenCalled();
    expect(d2.notifyManagers).not.toHaveBeenCalled();

    const old = { id: "a1", openedAt: ago(90), lastNotifiedAt: ago(61) };
    const d3 = deps({ ...bad, getOpenAlert: vi.fn(async (_o, _i, k) => (k === "provider_disconnected" ? old : null)) }, "on");
    await runProviderHealthCycle(d3, now);
    expect(d3.claimRepeat).toHaveBeenCalledWith("a1", now, 60, expect.anything());
    expect(d3.notifyManagers).toHaveBeenCalledTimes(1);
  });

  it("condição voltou ao normal: resolve o alerta aberto e registra quanto durou", async () => {
    const open = { id: "a9", openedAt: ago(40), lastNotifiedAt: ago(40) };
    const d = deps({ getOpenAlert: vi.fn(async (_o, _i, k) => (k === "webhook_stalled" ? open : null)) });
    await runProviderHealthCycle(d, now);
    expect(d.resolveAlert).toHaveBeenCalledWith("a9", now, open.lastNotifiedAt);
    expect(d.log.info).toHaveBeenCalledWith(expect.objectContaining({ kind: "webhook_stalled", durationMinutes: 40 }), expect.stringContaining("resolvida"));
  });

  it("'desconhecido' (consulta falhou) não abre nem fecha alerta", async () => {
    const open = { id: "a2", openedAt: ago(20), lastNotifiedAt: ago(20) };
    const d = deps({ providerSnapshot: vi.fn(async () => ({ ok: false, state: null, lastInboundAt: null })), getOpenAlert: vi.fn(async (_o, _i, k) => (k === "provider_disconnected" ? open : null)) });
    await runProviderHealthCycle(d, now);
    expect(d.resolveAlert).not.toHaveBeenCalled();
    expect(d.openAlert).not.toHaveBeenCalled();
  });

  it("falha numa instância não derruba o ciclo; status do ciclo fica não saudável e visível no /health", async () => {
    const d = deps({ listInstances: vi.fn(async () => [INST, { ...INST, id: "i2", instance_name: "pos" }]), crmLastInboundAt: vi.fn(async (_o: string, id: string) => { if (id === "i1") throw new Error("db"); return ago(2); }) });
    await runProviderHealthCycle(d, now);
    expect(d.providerSnapshot).toHaveBeenCalledTimes(2);
    const s = getProviderMonitorStatus();
    expect(s).toMatchObject({ cycles: 1, lastCycleHealthy: false });
    expect(s.lastConditions.pos).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "provider_ahead", status: "ok" })]));
  });

  it("fila represada vira alerta 'queue_backlog' (uma vez por organização, não por instância)", async () => {
    const d = deps({ listInstances: vi.fn(async () => [INST, { ...INST, id: "i2", instance_name: "pos" }]), queueSnapshot: vi.fn(async () => ({ ok: true, waiting: 12, oldestWaitingAt: ago(15) })) });
    await runProviderHealthCycle(d, now);
    const calls = (d.openAlert as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[2] === "queue_backlog");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("*");
  });
});
