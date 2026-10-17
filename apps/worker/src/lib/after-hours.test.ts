import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ getOrganizationById: vi.fn(), getOpenHandoffEvent: vi.fn(), countAfterHoursAgentReplies: vi.fn() }));
vi.mock("@aula-agente/database", () => m);
import { evaluateAfterHours } from "./after-hours.js";

const NIGHT = new Date("2026-10-10T15:00:00Z"); // sáb
const DAY = new Date("2026-10-09T15:00:00Z"); // sex 12h
const base = { organizationId: "o", conversationId: "c", isHumanTakeover: true, humanTakeoverAt: "2026-10-09T22:00:00Z", aiDisabled: false, now: NIGHT };

beforeEach(() => {
  vi.clearAllMocks();
  m.getOrganizationById.mockResolvedValue({ settings: { ai_after_hours_pending_enabled: true } });
  m.getOpenHandoffEvent.mockResolvedValue({ id: "h", handed_at: "2026-10-09T22:00:00Z" });
  m.countAfterHoursAgentReplies.mockResolvedValue(0);
});

describe("evaluateAfterHours", () => {
  it("runs at night with an open request_human handoff", async () => {
    expect(await evaluateAfterHours({} as any, base)).toEqual({ run: true, capped: false, handedAt: "2026-10-09T22:00:00Z", reopensAt: "segunda, 12/10, às 08:00" });
    expect(m.countAfterHoursAgentReplies).toHaveBeenCalledWith({}, "c", "2026-10-09T22:00:00Z");
  });
  it("does not run in business hours, without takeover, flag off, no handoff, or ai disabled", async () => {
    expect((await evaluateAfterHours({} as any, { ...base, now: DAY })).run).toBe(false);
    expect((await evaluateAfterHours({} as any, { ...base, isHumanTakeover: false })).run).toBe(false);
    expect((await evaluateAfterHours({} as any, { ...base, aiDisabled: true })).run).toBe(false);
    m.getOpenHandoffEvent.mockResolvedValue(null);
    expect((await evaluateAfterHours({} as any, base)).run).toBe(false);
    m.getOpenHandoffEvent.mockResolvedValue({ id: "h", handed_at: "x" });
    m.getOrganizationById.mockResolvedValue({ settings: {} });
    expect((await evaluateAfterHours({} as any, base)).run).toBe(false);
  });
  it("is capped at 20 replies", async () => {
    m.countAfterHoursAgentReplies.mockResolvedValue(20);
    expect(await evaluateAfterHours({} as any, base)).toMatchObject({ run: true, capped: true });
    m.countAfterHoursAgentReplies.mockResolvedValue(19);
    expect(await evaluateAfterHours({} as any, base)).toMatchObject({ run: true, capped: false });
  });
  it("fails closed on lookup errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.getOpenHandoffEvent.mockRejectedValue(new Error("db"));
    expect(await evaluateAfterHours({} as any, base)).toEqual({ run: false });
  });
});

describe("evaluateAfterHours: takeover origin", () => {
  it("stale open handoff + later MANUAL takeover -> skip", async () => {
    m.getOpenHandoffEvent.mockResolvedValue({ id: "h", handed_at: "2026-10-01T22:00:00Z" });
    expect((await evaluateAfterHours({} as any, base)).run).toBe(false);
  });
  it("handoff within 60s of the takeover timestamp -> runs; missing takeover timestamp -> skip", async () => {
    m.getOpenHandoffEvent.mockResolvedValue({ id: "h", handed_at: "2026-10-09T21:59:40Z" });
    expect((await evaluateAfterHours({} as any, base)).run).toBe(true);
    expect((await evaluateAfterHours({} as any, { ...base, humanTakeoverAt: null })).run).toBe(false);
  });
});

describe("evaluateAfterHours: real calendar", () => {
  const run = async (iso: string, settings: Record<string, unknown> = {}) => {
    m.getOrganizationById.mockResolvedValue({ settings: { ai_after_hours_pending_enabled: true, ...settings } });
    m.getOpenHandoffEvent.mockResolvedValue({ id: "h", handed_at: "2026-10-09T10:00:00Z" });
    return (await evaluateAfterHours({} as any, { ...base, humanTakeoverAt: "2026-10-09T10:00:00Z", now: new Date(iso) })).run;
  };
  it("sexta 17:59 fechado=false / 18:00 aberto=true (modo noite liga às 18:00)", async () => {
    expect(await run("2026-10-09T20:59:00Z")).toBe(false);
    expect(await run("2026-10-09T21:00:00Z")).toBe(true);
  });
  it("segunda 07:59 roda; 08:00 não roda", async () => {
    expect(await run("2026-10-12T10:59:00Z")).toBe(true);
    expect(await run("2026-10-12T11:00:00Z")).toBe(false);
  });
  it("domingo roda; feriado (closedDates) em dia útil roda", async () => {
    expect(await run("2026-10-11T15:00:00Z")).toBe(true);
    expect(await run("2026-10-12T15:00:00Z", { business_calendar: { timeZone: "America/Sao_Paulo", weekly: { mon: [{ start: "08:00", end: "18:00" }] }, closedDates: ["2026-10-12"] } })).toBe(true);
  });
  it("calendário com janela de sábado: sábado 12:00 não roda, 14:00 roda", async () => {
    const business_calendar = { timeZone: "America/Sao_Paulo", weekly: { mon: [{ start: "08:00", end: "18:00" }], sat: [{ start: "09:00", end: "13:00" }] } };
    expect(await run("2026-10-10T15:00:00Z", { business_calendar })).toBe(false); // sáb 12:00
    expect(await run("2026-10-10T17:00:00Z", { business_calendar })).toBe(true); // sáb 14:00
  });
  it("cap conta desde o último fechamento quando é depois do handoff", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: { ai_after_hours_pending_enabled: true } });
    m.getOpenHandoffEvent.mockResolvedValue({ id: "h", handed_at: "2026-10-08T10:00:00Z" }); // quinta
    await evaluateAfterHours({} as any, { ...base, humanTakeoverAt: "2026-10-08T10:00:00Z", now: new Date("2026-10-10T15:00:00Z") });
    expect(m.countAfterHoursAgentReplies).toHaveBeenLastCalledWith({}, "c", "2026-10-09T21:00:00.000Z");
  });
});
