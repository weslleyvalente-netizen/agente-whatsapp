import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  listExpiredAssignments: vi.fn(), redistributeAssignment: vi.fn(), getOrganizationById: vi.fn(), flagSlaAlerts: vi.fn(),
  computeSlaDueAt: vi.fn((_s: unknown, from: Date) => new Date(from.getTime() + 15 * 60_000)),
}));
vi.mock("@aula-agente/database", () => m);
vi.mock("@aula-agente/queue", () => ({ getRedisConnection: () => ({}), getLeadSlaQueue: () => ({ upsertJobScheduler: vi.fn() }) }));
import { runLeadSlaSweep } from "./lead-sla.js";

const now = new Date("2026-10-05T12:00:00Z");
beforeEach(() => {
  vi.clearAllMocks();
  m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } });
  m.redistributeAssignment.mockResolvedValue("new-id");
  m.flagSlaAlerts.mockResolvedValue(0);
});

describe("runLeadSlaSweep", () => {
  it("não faz nada quando não há atribuições vencidas", async () => {
    m.listExpiredAssignments.mockResolvedValue([]);
    expect(await runLeadSlaSweep({} as any, now)).toEqual({ checked: 0, redistributed: 0, alerted: 0 });
    expect(m.redistributeAssignment).not.toHaveBeenCalled();
  });

  it("redistribui cada vencida com um novo prazo calculado a partir de agora", async () => {
    m.listExpiredAssignments.mockResolvedValue([{ id: "a1", organization_id: "o" }, { id: "a2", organization_id: "o" }]);
    const result = await runLeadSlaSweep({} as any, now);
    expect(result).toMatchObject({ checked: 2, redistributed: 2 });
    expect(m.redistributeAssignment).toHaveBeenCalledWith({}, "a1", new Date("2026-10-05T12:15:00Z"));
    expect(m.getOrganizationById).toHaveBeenCalledTimes(1); // cache por organização no mesmo ciclo
  });

  it("ignora organização com a flag desligada", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: {} });
    m.listExpiredAssignments.mockResolvedValue([{ id: "a1", organization_id: "o" }]);
    expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ checked: 1, redistributed: 0 });
    expect(m.redistributeAssignment).not.toHaveBeenCalled();
  });

  it("não conta duas vezes quando outro worker já redistribuiu (retorno null)", async () => {
    m.listExpiredAssignments.mockResolvedValue([{ id: "a1", organization_id: "o" }]);
    m.redistributeAssignment.mockResolvedValue(null);
    expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ redistributed: 0 });
  });

  it("sinaliza os alertas de dono existente sem redistribuir ninguém", async () => {
    m.listExpiredAssignments.mockResolvedValue([]);
    m.flagSlaAlerts.mockResolvedValue(2);
    expect(await runLeadSlaSweep({} as any, now)).toEqual({ checked: 0, redistributed: 0, alerted: 2 });
    expect(m.redistributeAssignment).not.toHaveBeenCalled();
  });

  it("um erro nos alertas não impede a redistribuição", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.flagSlaAlerts.mockRejectedValue(new Error("db"));
    m.listExpiredAssignments.mockResolvedValue([{ id: "a1", organization_id: "o" }]);
    expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ redistributed: 1, alerted: 0 });
    log.mockRestore();
  });

  it("um erro em uma atribuição não impede as seguintes", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.listExpiredAssignments.mockResolvedValue([{ id: "a1", organization_id: "o" }, { id: "a2", organization_id: "o" }]);
    m.redistributeAssignment.mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce("new");
    expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ checked: 2, redistributed: 1 });
    log.mockRestore();
  });
});
