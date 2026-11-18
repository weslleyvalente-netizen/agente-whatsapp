import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSilentMonitorStatus, resetSilentMonitorStatus, runSilentConnectionCycle, type SilentDeps } from "./silent-connection-alert.js";

const now = new Date("2026-11-18T17:30:00Z");
const mk = (over: Partial<SilentDeps> = {}, mode: unknown = "shadow"): SilentDeps => ({
  listOrganizations: async () => [{ id: "org", settings: { silent_connection_alert_mode: mode } }],
  listInstances: async () => [{ id: "inst", instance_name: "weslley" }],
  latestObservation: async () => ({ state: "open", queryOk: true, lastEvolutionAt: new Date(now.getTime() - 3 * 3600_000), observedAt: new Date(now.getTime() - 60_000) }),
  lastCrmInboundAt: async () => new Date(now.getTime() - 3 * 3600_000),
  baselinePerHour: async () => 9,
  pushReadiness: async () => ({ vapidConfigured: false, managers: 0, managersWithPush: 0 }),
  getOpenAlert: async () => null, openAlert: async () => true, claimRepeat: async () => false, resolveAlert: async () => undefined,
  notifyManagers: async () => 0, log: { info: vi.fn(), error: vi.fn() }, ...over,
});

beforeEach(() => resetSilentMonitorStatus());

describe("estado do monitor (exposto em /health)", () => {
  it("antes de qualquer ciclo: não iniciado, sem ciclos", () => {
    expect(getSilentMonitorStatus()).toEqual({ started: false, startedAt: null, cycles: 0, lastCycleAt: null, lastCycleHealthy: null, lastCycleEnabledOrgs: null });
  });
  it("ciclo saudável com uma organização em shadow", async () => {
    await runSilentConnectionCycle(mk(), now);
    expect(getSilentMonitorStatus()).toMatchObject({ cycles: 1, lastCycleAt: now.toISOString(), lastCycleHealthy: true, lastCycleEnabledOrgs: 1 });
  });
  it("organização em off: o ciclo roda mas conta 0 organizações habilitadas", async () => {
    await runSilentConnectionCycle(mk({}, "off"), now);
    expect(getSilentMonitorStatus()).toMatchObject({ cycles: 1, lastCycleHealthy: true, lastCycleEnabledOrgs: 0 });
  });
  it("falha numa etapa: ciclo não saudável", async () => {
    await runSilentConnectionCycle(mk({ baselinePerHour: async () => { throw new Error("db"); } }), now);
    expect(getSilentMonitorStatus()).toMatchObject({ cycles: 1, lastCycleHealthy: false, lastCycleEnabledOrgs: 1 });
  });
  it("falha ao listar organizações: ciclo contado como não saudável", async () => {
    await runSilentConnectionCycle(mk({ listOrganizations: async () => { throw new Error("db"); } }), now);
    expect(getSilentMonitorStatus()).toMatchObject({ cycles: 1, lastCycleHealthy: false, lastCycleEnabledOrgs: null });
  });
  it("ciclo ultrapassado por outro não atualiza o estado", async () => {
    await runSilentConnectionCycle(mk(), now, () => false);
    expect(getSilentMonitorStatus().cycles).toBe(0);
  });
  it("o ciclos acumulam", async () => {
    await runSilentConnectionCycle(mk(), now); await runSilentConnectionCycle(mk(), new Date(now.getTime() + 300_000));
    expect(getSilentMonitorStatus().cycles).toBe(2);
  });
});
