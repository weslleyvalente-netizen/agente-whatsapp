import { describe, expect, it, vi } from "vitest";
import { runSilentConnectionCycle, type SilentDeps, type OpenAlert } from "./silent-connection-alert.js";

const now = new Date("2026-11-17T17:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
function make(over: Partial<SilentDeps> = {}, state: { open: OpenAlert | null } = { open: null }) {
  const calls = { opened: [] as unknown[], touched: [] as string[], resolved: [] as string[], notified: [] as unknown[] };
  const deps: SilentDeps = {
    listOrganizations: async () => [{ id: "org", settings: { silent_connection_alert_enabled: true } }],
    listInstances: async () => [{ id: "inst", instance_name: "weslley" }],
    latestObservation: async () => ({ state: "open", lastEvolutionAt: ago(180), observedAt: ago(1) }),
    lastCrmInboundAt: async () => ago(200),
    baselinePerHour: async () => 40,
    getOpenAlert: async () => state.open,
    openAlert: async (_o, _i, _n, evidence) => { calls.opened.push(evidence); state.open = { id: "a1", openedAt: now, lastNotifiedAt: now }; },
    touchAlert: async (id) => { calls.touched.push(id); },
    resolveAlert: async (id) => { calls.resolved.push(id); state.open = null; },
    notifyManagers: async (_o, p) => { calls.notified.push(p); return 2; },
    log: { info: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { deps, calls, state };
}

describe("runSilentConnectionCycle", () => {
  it("open + 3 h sem receber + volume habitual 40/h: abre UM alerta com evidência e avisa os gestores", async () => {
    const { deps, calls } = make();
    await runSilentConnectionCycle(deps, now);
    expect(calls.opened).toHaveLength(1); expect(calls.notified).toHaveLength(1);
    const ev = calls.opened[0] as Record<string, unknown>;
    expect(ev).toMatchObject({ evolution_state: "open", baseline_per_hour: 40, silent_minutes: 180 });
    expect(Object.keys(ev).sort()).toEqual(["baseline_per_hour", "evolution_state", "expected_in_silence", "last_crm_inbound_at", "last_evolution_inbound_at", "last_inbound_at", "probability_of_silence", "reason", "silent_minutes"]); // só estados, horários e números agregados
  });
  it("usa a mensagem mais recente entre o CRM e a Evolution", async () => {
    const { deps, calls } = make({ lastCrmInboundAt: async () => ago(2) });
    await runSilentConnectionCycle(deps, now); expect(calls.opened).toHaveLength(0);
  });
  it("não repete dentro de 60 min; repete depois; nunca abre dois", async () => {
    const st = { open: { id: "a1", openedAt: ago(30), lastNotifiedAt: ago(30) } as OpenAlert | null };
    const a = make({}, st); await runSilentConnectionCycle(a.deps, now);
    expect(a.calls.opened).toHaveLength(0); expect(a.calls.notified).toHaveLength(0);
    const st2 = { open: { id: "a1", openedAt: ago(130), lastNotifiedAt: ago(61) } as OpenAlert | null };
    const b = make({}, st2); await runSilentConnectionCycle(b.deps, now);
    expect(b.calls.touched).toEqual(["a1"]); expect(b.calls.notified).toHaveLength(1);
  });
  it("resolve sozinho quando volta a receber", async () => {
    const st = { open: { id: "a1", openedAt: ago(90), lastNotifiedAt: ago(90) } as OpenAlert | null };
    const { deps, calls } = make({ lastCrmInboundAt: async () => ago(1), latestObservation: async () => ({ state: "open", lastEvolutionAt: ago(1), observedAt: ago(1) }) }, st);
    await runSilentConnectionCycle(deps, now); expect(calls.resolved).toEqual(["a1"]); expect(calls.notified).toHaveLength(0);
  });
  it("horário/volume baixo (madrugada, domingo): nada", async () => {
    const { deps, calls } = make({ baselinePerHour: async () => 1 }); await runSilentConnectionCycle(deps, now);
    expect(calls.opened).toHaveLength(0);
  });
  it("Evolution fora de 'open': não é conexão muda (outro alerta), não abre", async () => {
    const { deps, calls } = make({ latestObservation: async () => ({ state: "close", lastEvolutionAt: ago(300), observedAt: ago(1) }) });
    await runSilentConnectionCycle(deps, now); expect(calls.opened).toHaveLength(0);
  });
  it("monitor sem observação recente (ou consulta que falhou → state null): não avalia e não inventa alerta", async () => {
    for (const obs of [null, { state: "open", lastEvolutionAt: ago(300), observedAt: ago(40) }, { state: null, lastEvolutionAt: null, observedAt: ago(1) }]) {
      const { deps, calls } = make({ latestObservation: async () => obs as never }); await runSilentConnectionCycle(deps, now);
      expect(calls.opened).toHaveLength(0);
    }
  });
  it("organização sem a flag: nenhuma consulta de instância nem alerta (desligado por padrão)", async () => {
    const { deps, calls } = make({ listOrganizations: async () => [{ id: "org", settings: {} }] });
    const spy = vi.spyOn(deps, "listInstances"); await runSilentConnectionCycle(deps, now);
    expect(spy).not.toHaveBeenCalled(); expect(calls.opened).toHaveLength(0);
  });
  it("falha no push: o alerta e a evidência ficam gravados e o ciclo não lança", async () => {
    const { deps, calls } = make({ notifyManagers: async () => { throw new Error("push fora"); } });
    await expect(runSilentConnectionCycle(deps, now)).resolves.toBeUndefined();
    expect(calls.opened).toHaveLength(1); expect(deps.log.error).toHaveBeenCalled();
  });
  it("erro de uma instância não impede as outras", async () => {
    let n = 0;
    const { deps, calls } = make({ listInstances: async () => [{ id: "i1", instance_name: "a" }, { id: "i2", instance_name: "b" }], lastCrmInboundAt: async () => { if (n++ === 0) throw new Error("x"); return ago(200); } });
    await runSilentConnectionCycle(deps, now); expect(calls.opened).toHaveLength(1);
  });
});
