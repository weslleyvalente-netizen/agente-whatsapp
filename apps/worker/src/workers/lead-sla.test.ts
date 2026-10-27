import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  listExpiredAssignments: vi.fn(), redistributeAssignment: vi.fn(), getOrganizationById: vi.fn(), flagSlaAlerts: vi.fn(),
  computeSlaDueAt: vi.fn((_s: unknown, from: Date) => new Date(from.getTime() + 15 * 60_000)),
  computeEscalationDueAt: vi.fn((_s: unknown, from: Date) => new Date(from.getTime() + 30 * 60_000)),
  listEscalationCandidates: vi.fn(), escalateAlertAssignment: vi.fn(), ensureHandoffCards: vi.fn(),
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
  m.listEscalationCandidates.mockResolvedValue([]);
  m.escalateAlertAssignment.mockResolvedValue("escalated-id");
  m.ensureHandoffCards.mockResolvedValue(0);
});

describe("runLeadSlaSweep", () => {
  it("não faz nada quando não há atribuições vencidas", async () => {
    m.listExpiredAssignments.mockResolvedValue([]);
    expect(await runLeadSlaSweep({} as any, now)).toEqual({ checked: 0, redistributed: 0, alerted: 0, escalated: 0, cardsRepaired: 0 });
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
    expect(await runLeadSlaSweep({} as any, now)).toEqual({ checked: 0, redistributed: 0, alerted: 2, escalated: 0, cardsRepaired: 0 });
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

  describe("escalada de atribuição 'alert' (estágio 2, atrás de sla_alert_escalation_enabled)", () => {
    const ON = { settings: { lead_distribution_enabled: true, sla_alert_escalation_enabled: true } };
    const cand = (id: string, assignedAt = "2026-10-05T11:00:00Z") => ({ id, organization_id: "o", assigned_at: assignedAt });
    beforeEach(() => { m.listExpiredAssignments.mockResolvedValue([]); });

    it("com a chave ligada e 2x o SLA vencido, escala com novo prazo a partir de agora", async () => {
      m.getOrganizationById.mockResolvedValue(ON);
      m.listEscalationCandidates.mockResolvedValue([cand("a1")]); // atribuída 11:00 => 2x = 11:30 <= 12:00
      const r = await runLeadSlaSweep({} as any, now);
      expect(r).toMatchObject({ escalated: 1, redistributed: 0 });
      expect(m.escalateAlertAssignment).toHaveBeenCalledWith({}, "a1", new Date("2026-10-05T11:30:00Z"), new Date("2026-10-05T12:15:00Z"));
    });

    it("chave desligada (padrão) ou distribuição desligada: não escala nada", async () => {
      m.listEscalationCandidates.mockResolvedValue([cand("a1")]);
      m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } });
      expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ escalated: 0, cardsRepaired: 0 });
      m.getOrganizationById.mockResolvedValue({ settings: { sla_alert_escalation_enabled: true } });
      expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ escalated: 0, cardsRepaired: 0 });
      expect(m.escalateAlertAssignment).not.toHaveBeenCalled();
    });

    it("ainda antes de 2x o SLA: não chama o banco", async () => {
      m.getOrganizationById.mockResolvedValue(ON);
      m.listEscalationCandidates.mockResolvedValue([cand("a1", "2026-10-05T11:50:00Z")]); // 2x = 12:20 > 12:00
      expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ escalated: 0, cardsRepaired: 0 });
      expect(m.escalateAlertAssignment).not.toHaveBeenCalled();
    });

    it("banco devolve null (respondida, sem outro vendedor, já escalada ou outro worker): não conta", async () => {
      m.getOrganizationById.mockResolvedValue(ON);
      m.listEscalationCandidates.mockResolvedValue([cand("a1")]);
      m.escalateAlertAssignment.mockResolvedValue(null);
      expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ escalated: 0, cardsRepaired: 0 });
    });

    it("erro numa candidata não impede as outras nem a redistribuição; erro ao listar não derruba a varredura", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      m.getOrganizationById.mockResolvedValue(ON);
      m.listEscalationCandidates.mockResolvedValue([cand("a1"), cand("a2")]);
      m.escalateAlertAssignment.mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce("n");
      expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ escalated: 1 });
      m.listEscalationCandidates.mockRejectedValue(new Error("db"));
      m.listExpiredAssignments.mockResolvedValue([{ id: "x", organization_id: "o" }]);
      expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ redistributed: 1, escalated: 0, cardsRepaired: 0 });
      log.mockRestore();
    });
  });

  it("repara cards de encaminhamento pulados a cada varredura; falha no reparo não derruba a varredura", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.listExpiredAssignments.mockResolvedValue([]);
    m.ensureHandoffCards.mockResolvedValueOnce(2);
    expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ cardsRepaired: 2 });
    m.ensureHandoffCards.mockRejectedValueOnce(new Error("db"));
    expect(await runLeadSlaSweep({} as any, now)).toMatchObject({ cardsRepaired: 0 });
    log.mockRestore();
  });
});
