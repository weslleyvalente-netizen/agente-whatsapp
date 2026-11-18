import { describe, expect, it, vi } from "vitest";
import { createSilentTicker, pingHeartbeat, runSilentConnectionCycle as runCycle, type AlertKind, type OpenAlert, type SilentDeps } from "./silent-connection-alert.js";
import type { SilentAlertMode } from "@aula-agente/shared";

const now = new Date("2026-11-17T17:00:00Z");
// Relógio dos testes: a observação do monitor é sempre "de 1 min atrás" em relação ao instante do ciclo (a menos que o teste a sobrescreva).
let clock = now;
const run = (deps: SilentDeps, at: Date) => { clock = at; return runCycle(deps, at); };
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

// Armazém falso com a MESMA semântica do banco: um aberto por (org, instância, kind, mode) e claim condicional atômico.
interface Row { id: string; org: string; inst: string; kind: AlertKind; mode: SilentAlertMode; openedAt: Date; lastNotifiedAt: Date; resolved: boolean; evidence: Record<string, unknown> }
function makeStore() {
  const rows: Row[] = []; let seq = 0;
  return { rows,
    get: (org: string, inst: string, kind: AlertKind, mode: SilentAlertMode): OpenAlert | null => { const r = rows.find((x) => x.org === org && x.inst === inst && x.kind === kind && x.mode === mode && !x.resolved); return r ? { id: r.id, openedAt: r.openedAt, lastNotifiedAt: r.lastNotifiedAt } : null; },
    open: (org: string, inst: string, kind: AlertKind, mode: SilentAlertMode, at: Date, evidence: Record<string, unknown>) => { if (rows.some((x) => x.org === org && x.inst === inst && x.kind === kind && x.mode === mode && !x.resolved)) return false; rows.push({ id: `a${++seq}`, org, inst, kind, mode, openedAt: at, lastNotifiedAt: at, resolved: false, evidence }); return true; },
    claim: (id: string, at: Date, repeat: number, evidence: Record<string, unknown>) => { const r = rows.find((x) => x.id === id && !x.resolved); if (!r || r.lastNotifiedAt.getTime() > at.getTime() - repeat * 60_000) return false; r.lastNotifiedAt = at; r.evidence = evidence; return true; },
    resolve: (id: string) => { const r = rows.find((x) => x.id === id); if (r) r.resolved = true; },
  };
}
function make(over: Partial<SilentDeps> = {}, mode: unknown = "on", store = makeStore()) {
  const notified: unknown[] = [];
  const deps: SilentDeps = {
    listOrganizations: async () => [{ id: "org", settings: { silent_connection_alert_mode: mode } }],
    listInstances: async () => [{ id: "inst", instance_name: "weslley" }],
    latestObservation: async () => ({ state: "open", queryOk: true, lastEvolutionAt: ago(180), observedAt: new Date(clock.getTime() - 60_000) }),
    lastCrmInboundAt: async () => ago(200),
    baselinePerHour: async () => 40,
    pushReadiness: async () => ({ vapidConfigured: true, managers: 2, managersWithPush: 1 }),
    getOpenAlert: async (o, i, k, m) => store.get(o, i, k, m),
    openAlert: async (o, i, k, m, n, e) => store.open(o, i, k, m, n, e),
    claimRepeat: async (id, n, r, e) => store.claim(id, n, r, e),
    resolveAlert: async (id) => store.resolve(id),
    notifyManagers: async (_o, p) => { notified.push(p); return 1; },
    log: { info: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { deps, store, notified };
}
const kinds = (s: ReturnType<typeof makeStore>) => s.rows.map((r) => `${r.kind}:${r.mode}${r.resolved ? ":res" : ""}`);

describe("modos off / shadow / on", () => {
  it("off (padrão, ausente ou inválido, inclusive o booleano antigo): nada é consultado nem gravado", async () => {
    for (const m of ["off", null, true, "ON", "x"]) {
      const { deps, store, notified } = make({}, m); const spy = vi.spyOn(deps, "listInstances");
      await run(deps, now); expect(spy).not.toHaveBeenCalled(); expect(store.rows).toHaveLength(0); expect(notified).toHaveLength(0);
    }
  });
  it("shadow: REGISTRA o alerta que seria disparado (mode=shadow) e NÃO notifica", async () => {
    const { deps, store, notified } = make({}, "shadow");
    await run(deps, now);
    expect(kinds(store)).toEqual(["silent_connection:shadow"]); expect(notified).toHaveLength(0);
    expect(store.rows[0].evidence).toMatchObject({ evolution_state: "open", baseline_per_hour: 40, silent_minutes: 180 });
    expect(deps.log.info).toHaveBeenCalledWith(expect.objectContaining({ mode: "shadow" }), expect.stringContaining("SOMBRA"));
  });
  it("on com canal pronto: registra e notifica UMA vez", async () => {
    const { deps, store, notified } = make({}, "on"); await run(deps, now);
    expect(kinds(store)).toEqual(["silent_connection:on"]); expect(notified).toHaveLength(1);
    await run(deps, new Date(now.getTime() + 5 * 60_000)); expect(notified).toHaveLength(1); // 5 min depois: sem repetir
  });
  it("repete só depois de 60 min e resolve sozinho quando volta a receber", async () => {
    const { deps, store, notified } = make({}, "on"); await run(deps, now);
    await run(deps, new Date(now.getTime() + 61 * 60_000)); expect(notified).toHaveLength(2);
    const later = new Date(now.getTime() + 70 * 60_000);
    const back = { ...deps, lastCrmInboundAt: async () => new Date(later.getTime() - 60_000), latestObservation: async () => ({ state: "open", queryOk: true, lastEvolutionAt: new Date(later.getTime() - 60_000), observedAt: new Date(later.getTime() - 60_000) }) };
    await run(back, later); expect(kinds(store)).toEqual(["silent_connection:on:res"]); expect(notified).toHaveLength(2);
  });
  it("volume baixo e Evolution fora de 'open' não geram alerta de mudez", async () => {
    for (const o of [{ baselinePerHour: async () => 1 }, { latestObservation: async () => ({ state: "close", queryOk: true, lastEvolutionAt: ago(300), observedAt: ago(1) }) }]) {
      const { deps, store } = make(o, "on"); await run(deps, now); expect(store.rows).toHaveLength(0);
    }
  });
});

describe("canal de aviso (push) antes da ativação", () => {
  it("on SEM gestor com push (ou sem VAPID): roda como sombra, registra push_not_ready e NÃO notifica", async () => {
    for (const r of [{ vapidConfigured: true, managers: 2, managersWithPush: 0 }, { vapidConfigured: false, managers: 2, managersWithPush: 2 }, { vapidConfigured: true, managers: 0, managersWithPush: 0 }]) {
      const { deps, store, notified } = make({ pushReadiness: async () => r }, "on"); await run(deps, now);
      expect(kinds(store).sort()).toEqual(["push_not_ready:shadow", "silent_connection:shadow"]); expect(notified).toHaveLength(0);
    }
  });
  it("quando um gestor ativa o push, push_not_ready é resolvido e o modo on volta a notificar", async () => {
    const st = makeStore(); const a = make({ pushReadiness: async () => ({ vapidConfigured: true, managers: 1, managersWithPush: 0 }) }, "on", st);
    await run(a.deps, now);
    const b = make({}, "on", st); await run(b.deps, new Date(now.getTime() + 5 * 60_000));
    expect(st.rows.find((r) => r.kind === "push_not_ready")!.resolved).toBe(true); expect(b.notified).toHaveLength(1);
  });
  it("falha ao verificar o push conta como NÃO pronto (não finge que avisa)", async () => {
    const { deps, notified } = make({ pushReadiness: async () => { throw new Error("db"); } }, "on"); await run(deps, now); expect(notified).toHaveLength(0);
  });
});

describe("monitor indisponível é uma condição de saúde distinta", () => {
  it.each([
    ["sem observação", async () => null],
    ["observação velha (40 min)", async () => ({ state: "open", queryOk: true, lastEvolutionAt: ago(300), observedAt: ago(40) })],
    ["consulta à Evolution falhando", async () => ({ state: null, queryOk: false, lastEvolutionAt: null, observedAt: ago(1) })],
  ])("%s: abre monitor_blind, avisa como tal e NÃO avalia 'mudo' (nem 'tudo bem')", async (_n, latestObservation) => {
    const { deps, store, notified } = make({ latestObservation: latestObservation as never }, "on"); await run(deps, now);
    expect(kinds(store)).toEqual(["monitor_blind:on"]); expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ title: expect.stringContaining("Monitoramento") });
  });
  it("voltando o monitor: resolve monitor_blind e a avaliação de mudez recomeça", async () => {
    const st = makeStore(); const a = make({ latestObservation: async () => null }, "on", st); await run(a.deps, now);
    const b = make({}, "on", st); await run(b.deps, new Date(now.getTime() + 5 * 60_000));
    expect(kinds(st).sort()).toEqual(["monitor_blind:on:res", "silent_connection:on"]);
  });
  it("um alerta 'mudo' aberto não é resolvido por causa de monitor cego", async () => {
    const st = makeStore(); const a = make({}, "on", st); await run(a.deps, now);
    const b = make({ latestObservation: async () => null }, "on", st); await run(b.deps, new Date(now.getTime() + 5 * 60_000));
    expect(st.rows.find((r) => r.kind === "silent_connection")!.resolved).toBe(false);
  });
});

describe("execuções concorrentes", () => {
  it("dois processos no mesmo instante: UM só notifica (abertura)", async () => {
    const st = makeStore(); const a = make({}, "on", st), b = make({}, "on", st);
    // ambos leem "sem alerta aberto" antes de qualquer um gravar (corrida clássica)
    const gate = new Promise<void>((r) => setTimeout(r, 5));
    for (const x of [a, b]) { const orig = x.deps.getOpenAlert; x.deps.getOpenAlert = async (...args) => { const v = await orig(...args); await gate; return v; }; }
    await Promise.all([run(a.deps, now), run(b.deps, now)]);
    expect(a.notified.length + b.notified.length).toBe(1); expect(st.rows.filter((r) => r.kind === "silent_connection")).toHaveLength(1);
  });
  it("dois processos na hora da repetição: UM só notifica (claim atômico)", async () => {
    const st = makeStore(); const first = make({}, "on", st); await run(first.deps, now);
    const later = new Date(now.getTime() + 61 * 60_000); const a = make({}, "on", st), b = make({}, "on", st);
    await Promise.all([run(a.deps, later), run(b.deps, later)]);
    expect(a.notified.length + b.notified.length).toBe(1);
  });
});

describe("indisponibilidade e falhas", () => {
  it("falha no push: o alerta e a evidência ficam gravados, o ciclo não lança e não reenvia em loop", async () => {
    const { deps, store } = make({ notifyManagers: async () => { throw new Error("push fora"); } }, "on");
    await expect(run(deps, now)).resolves.toBeUndefined();
    expect(store.rows).toHaveLength(1); expect(deps.log.error).toHaveBeenCalled();
    await run(deps, new Date(now.getTime() + 5 * 60_000)); expect(store.rows).toHaveLength(1);
  });
  it("banco indisponível ao listar organizações: não lança e não notifica", async () => {
    const { deps, notified } = make({ listOrganizations: async () => { throw new Error("db"); } }); await expect(run(deps, now)).resolves.toBeUndefined(); expect(notified).toHaveLength(0);
  });
  it("erro de uma instância não impede as outras", async () => {
    let n = 0;
    const { deps, store } = make({ listInstances: async () => [{ id: "i1", instance_name: "a" }, { id: "i2", instance_name: "b" }], lastCrmInboundAt: async () => { if (n++ === 0) throw new Error("x"); return ago(200); } }, "on");
    await run(deps, now); expect(store.rows.filter((r) => r.kind === "silent_connection")).toHaveLength(1);
  });
  it("erro ao gravar o alerta não notifica (grava antes de avisar)", async () => {
    const { deps, notified } = make({ openAlert: async () => { throw new Error("db"); } }, "on"); await run(deps, now); expect(notified).toHaveLength(0);
  });
});

describe("monitor externo (heartbeat)", () => {
  it("ciclo saudável com alguma organização ligada: 1 ping; sem organização ligada ou ciclo que falhou ao listar: nenhum", async () => {
    const hb = vi.fn(async () => {});
    await run(make({ heartbeat: hb }, "shadow").deps, now); expect(hb).toHaveBeenCalledTimes(1);
    hb.mockClear(); await run(make({ heartbeat: hb }, "off").deps, now); expect(hb).not.toHaveBeenCalled();
    await run(make({ heartbeat: hb, listOrganizations: async () => { throw new Error("db"); } }).deps, now); expect(hb).not.toHaveBeenCalled();
  });
  it("falha em qualquer etapa do ciclo (observação ilegível, instâncias, avaliação): nenhum ping — o monitor externo percebe", async () => {
    for (const over of [
      { latestObservation: async () => { throw new Error("db"); } },
      { listInstances: async () => { throw new Error("db"); } },
      { lastCrmInboundAt: async () => { throw new Error("db"); } },
    ] as Partial<SilentDeps>[]) {
      const hb = vi.fn(async () => {}); await run(make({ heartbeat: hb, ...over }, "shadow").deps, now); expect(hb).not.toHaveBeenCalled();
    }
  });
  it("ciclo travado: sem ping enquanto trava; depois do limite o laço volta a rodar; ciclo normal libera o próximo tick", async () => {
    let t = 0; const logs: string[] = []; const log = { info() {}, error: (_o: unknown, m?: string) => { logs.push(String(m)); } } as never;
    let calls = 0; const hb = vi.fn(async () => {});
    const hang = () => { calls++; return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve().then(() => hb()); };
    const tick = createSilentTicker(hang, log, () => t, 15 * 60_000);
    tick(); t = 5 * 60_000; tick(); t = 10 * 60_000; tick();
    expect(calls).toBe(1); expect(hb).not.toHaveBeenCalled(); // travado: nada roda, nenhum ping
    t = 16 * 60_000; tick(); await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(2); expect(logs.some((m) => m.includes("travado"))).toBe(true); expect(hb).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0)); t = 21 * 60_000; tick(); expect(calls).toBe(3); // ciclo terminou: o próximo tick roda
  });
  it("falha do heartbeat não derruba o ciclo", async () => {
    const { deps } = make({ heartbeat: async () => { throw new Error("rede"); } }, "shadow"); await expect(run(deps, now)).resolves.toBeUndefined();
  });
  it("pingHeartbeat: GET sem corpo; false em erro/timeout/status ruim, nunca lança", async () => {
    const ok = vi.fn(async () => new Response("", { status: 200 })); expect(await pingHeartbeat("https://hc.example/ping/x", ok as never)).toBe(true);
    expect(ok).toHaveBeenCalledWith("https://hc.example/ping/x", expect.objectContaining({ method: "GET" }));
    expect(await pingHeartbeat("u", (async () => new Response("", { status: 500 })) as never)).toBe(false);
    expect(await pingHeartbeat("u", (async () => { throw new Error("x"); }) as never)).toBe(false);
    expect(await pingHeartbeat("u", ((_u: string, o: { signal: AbortSignal }) => new Promise((_r, rej) => o.signal.addEventListener("abort", () => rej(new Error("abort"))))) as never, 10)).toBe(false);
  });
});
