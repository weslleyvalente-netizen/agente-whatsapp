import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeInstance, runObservationCycle, startEvolutionMonitor, defaultMonitorDeps, type MonitorDeps, type ObservationRow } from "./evolution-monitor.js";

const db = vi.hoisted(() => ({ calls: [] as Array<[string, ...unknown[]]>, result: { data: null as unknown, error: null as unknown } }));
vi.mock("@aula-agente/database", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "is", "order", "limit", "delete", "lt"]) chain[m] = (...a: unknown[]) => { db.calls.push([m, ...a]); return chain; };
  chain.maybeSingle = async () => db.result;
  return { getAdminClient: () => chain, getAllOrganizations: vi.fn(), getInstancesByOrganization: vi.fn() };
});

const NOW = new Date("2026-11-12T18:00:00.000Z");
const ctx = { organizationId: "org-1", instanceName: "weslley", instanceId: "inst-1" };

function deps(over: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    connectionState: vi.fn().mockResolvedValue("open"),
    disconnection: vi.fn().mockResolvedValue({ at: new Date("2026-11-12T14:16:27.094Z"), reasonCode: 401 }),
    latestStoredReceivedAt: vi.fn().mockResolvedValue(new Date("2026-11-12T17:58:00.000Z")),
    lastCrmMessageAt: vi.fn().mockResolvedValue(new Date("2026-11-12T17:57:30.000Z")),
    previousDisconnectionAt: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    prune: vi.fn().mockResolvedValue(undefined),
    listOrganizations: vi.fn().mockResolvedValue([]),
    listInstances: vi.fn().mockResolvedValue([]),
    log: { info: vi.fn(), error: vi.fn() },
    ...over,
  };
}

describe("observeInstance", () => {
  it("registra estado, horários em UTC e a última desconexão", async () => {
    const row = await observeInstance(deps(), ctx, NOW);
    expect(row).toEqual<ObservationRow>({
      organization_id: "org-1", instance_name: "weslley", observed_at: "2026-11-12T18:00:00.000Z",
      evolution_state: "open", query_ok: true, query_error_kind: null,
      disconnection_at: "2026-11-12T14:16:27.094Z", disconnection_reason_code: 401, disconnection_error_kind: null,
      disconnect_since_previous: null,
      last_crm_message_at: "2026-11-12T17:57:30.000Z",
      last_evolution_message_at: "2026-11-12T17:58:00.000Z", evolution_message_error_kind: null,
    });
  });

  it("falha na consulta de estado registra só a classe do erro e segue com o resto", async () => {
    const row = await observeInstance(deps({ connectionState: vi.fn().mockRejectedValue(new Error("Evolution API error 502: apikey=abc http://x")) }), ctx, NOW);
    expect(row).toMatchObject({ query_ok: false, evolution_state: null, query_error_kind: "http_502", last_crm_message_at: "2026-11-12T17:57:30.000Z" });
    expect(JSON.stringify(row)).not.toMatch(/abc|http:\/\/x/);
  });

  it("estado inesperado (resposta sem state) conta como consulta com falha", async () => {
    const row = await observeInstance(deps({ connectionState: vi.fn().mockResolvedValue(null) }), ctx, NOW);
    expect(row).toMatchObject({ query_ok: false, evolution_state: null, query_error_kind: "invalid_response" });
  });

  it("falha em cada consulta secundária é registrada separadamente", async () => {
    const row = await observeInstance(deps({
      disconnection: vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "TimeoutError" })),
      latestStoredReceivedAt: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    }), ctx, NOW);
    expect(row).toMatchObject({
      query_ok: true, disconnection_at: null, disconnection_reason_code: null, disconnection_error_kind: "timeout",
      last_evolution_message_at: null, evolution_message_error_kind: "network",
    });
  });

  it("falha ao ler a última mensagem do CRM não derruba a observação", async () => {
    const row = await observeInstance(deps({ lastCrmMessageAt: vi.fn().mockRejectedValue(new Error("db")) }), ctx, NOW);
    expect(row.last_crm_message_at).toBeNull();
    expect(row.query_ok).toBe(true);
  });

  describe("disconnect_since_previous (reconexão rápida entre observações)", () => {
    const at = new Date("2026-11-12T14:16:27.094Z");
    it("null quando não há observação anterior", async () => {
      expect((await observeInstance(deps({ previousDisconnectionAt: vi.fn().mockResolvedValue(undefined) }), ctx, NOW)).disconnect_since_previous).toBeNull();
    });
    it("false quando o horário da última desconexão não mudou", async () => {
      expect((await observeInstance(deps({ previousDisconnectionAt: vi.fn().mockResolvedValue(at) }), ctx, NOW)).disconnect_since_previous).toBe(false);
    });
    it("true quando a última desconexão é mais nova que a da observação anterior", async () => {
      expect((await observeInstance(deps({ previousDisconnectionAt: vi.fn().mockResolvedValue(new Date("2026-11-12T10:00:00.000Z")) }), ctx, NOW)).disconnect_since_previous).toBe(true);
    });
    it("true quando antes não havia desconexão registrada e agora há", async () => {
      expect((await observeInstance(deps({ previousDisconnectionAt: vi.fn().mockResolvedValue(null) }), ctx, NOW)).disconnect_since_previous).toBe(true);
    });
    it("null quando a desconexão atual é desconhecida (consulta falhou)", async () => {
      const d = deps({ previousDisconnectionAt: vi.fn().mockResolvedValue(at), disconnection: vi.fn().mockRejectedValue(new Error("x")) });
      expect((await observeInstance(d, ctx, NOW)).disconnect_since_previous).toBeNull();
    });
  });
});

describe("runObservationCycle", () => {
  let d: MonitorDeps;
  beforeEach(() => {
    d = deps({
      listOrganizations: vi.fn().mockResolvedValue([
        { id: "a", settings: { evolution_monitor_enabled: true } },
        { id: "b", settings: {} },
        { id: "c", settings: { evolution_monitor_enabled: "true" } },
      ]),
      listInstances: vi.fn().mockResolvedValue([{ id: "i1", instance_name: "weslley" }, { id: "i2", instance_name: "pos-venda" }]),
    });
  });

  it("só observa organizações com a chave ligada (true) e grava uma linha por instância", async () => {
    await runObservationCycle(d, NOW);
    expect(d.listInstances).toHaveBeenCalledTimes(1);
    expect(d.listInstances).toHaveBeenCalledWith("a");
    expect((d.insert as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].instance_name)).toEqual(["weslley", "pos-venda"]);
  });

  it("falha numa instância não impede as outras e não vaza detalhes", async () => {
    (d.insert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("relation apikey=zzz does not exist"));
    await runObservationCycle(d, NOW);
    expect(d.insert).toHaveBeenCalledTimes(2);
    expect(JSON.stringify((d.log.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("zzz");
  });

  it("falha ao listar organizações não lança", async () => {
    (d.listOrganizations as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db"));
    await expect(runObservationCycle(d, NOW)).resolves.toBeUndefined();
    expect(d.log.error).toHaveBeenCalled();
  });

  it("apaga observações antigas (30 dias) uma vez por ciclo", async () => {
    await runObservationCycle(d, NOW);
    expect(d.prune).toHaveBeenCalledTimes(1);
    expect(d.prune).toHaveBeenCalledWith(new Date("2026-10-13T18:00:00.000Z"));
  });

  it("sem nenhuma organização com a chave ligada não apaga nada (nem limpeza global)", async () => {
    (d.listOrganizations as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "b", settings: {} }]);
    await runObservationCycle(d, NOW);
    expect(d.prune).not.toHaveBeenCalled();
    expect(d.listInstances).not.toHaveBeenCalled();
  });

  it("registra no log quando a instância não está open", async () => {
    (d.connectionState as ReturnType<typeof vi.fn>).mockResolvedValue("close");
    await runObservationCycle(d, NOW);
    expect(d.log.info).toHaveBeenCalledWith(expect.objectContaining({ instanceName: "weslley", state: "close" }), expect.any(String));
  });
});

describe("falha de coleta não vira desconexão nova", () => {
  const OLD = new Date("2026-11-12T14:16:27.094Z");
  it("evento antigo → timeout → mesmo evento antigo: terceira observação diz false", async () => {
    const rows: ObservationRow[] = [];
    const seq = [
      () => Promise.resolve({ at: OLD, reasonCode: 401 }),
      () => Promise.reject(Object.assign(new Error("x"), { name: "TimeoutError" })),
      () => Promise.resolve({ at: OLD, reasonCode: 401 }),
    ];
    let i = 0;
    const base = deps({
      disconnection: vi.fn().mockImplementation(() => seq[i++]()),
      // mesma regra da consulta real: só linhas em que a consulta da desconexão deu certo
      previousDisconnectionAt: vi.fn().mockImplementation(async () => {
        const valid = [...rows].reverse().find((r) => r.disconnection_error_kind === null);
        return valid === undefined ? undefined : valid.disconnection_at ? new Date(valid.disconnection_at) : null;
      }),
      insert: vi.fn().mockImplementation(async (r: ObservationRow) => { rows.push(r); }),
    });
    for (let k = 0; k < 3; k++) await observeInstance(base, ctx, new Date(NOW.getTime() + k * 300_000)).then((r) => base.insert(r));
    expect(rows.map((r) => r.disconnect_since_previous)).toEqual([null, null, false]);
    expect(rows[1].disconnection_error_kind).toBe("timeout");
  });

  it("a consulta real da observação anterior ignora linhas com erro de coleta", async () => {
    db.calls.length = 0;
    db.result = { data: { disconnection_at: "2026-11-12T14:16:27.094Z" }, error: null };
    const out = await defaultMonitorDeps({ info() {}, error() {} }).previousDisconnectionAt("org-1", "weslley");
    expect(out).toEqual(new Date("2026-11-12T14:16:27.094Z"));
    expect(db.calls).toContainEqual(["is", "disconnection_error_kind", null]);
  });
});

describe("desligamento", () => {
  it("EVOLUTION_MONITOR_DISABLED=1 não cria timers", () => {
    process.env.EVOLUTION_MONITOR_DISABLED = "1";
    try {
      const spy = vi.spyOn(globalThis, "setInterval");
      const t = startEvolutionMonitor({ info() {}, error() {} });
      expect(t).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      delete process.env.EVOLUTION_MONITOR_DISABLED;
    }
  });
});
