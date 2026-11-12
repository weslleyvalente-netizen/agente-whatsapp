import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeInstance, runObservationCycle, type MonitorDeps, type ObservationRow } from "./evolution-monitor.js";

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

  it("registra no log quando a instância não está open", async () => {
    (d.connectionState as ReturnType<typeof vi.fn>).mockResolvedValue("close");
    await runObservationCycle(d, NOW);
    expect(d.log.info).toHaveBeenCalledWith(expect.objectContaining({ instanceName: "weslley", state: "close" }), expect.any(String));
  });
});
