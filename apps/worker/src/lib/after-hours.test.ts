import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ getOrganizationById: vi.fn(), getOpenHandoffEvent: vi.fn(), countAfterHoursAgentReplies: vi.fn() }));
vi.mock("@aula-agente/database", () => m);
import { evaluateAfterHours } from "./after-hours.js";

const NIGHT = new Date("2026-10-10T15:00:00Z"); // sáb
const DAY = new Date("2026-10-09T15:00:00Z"); // sex 12h
const base = { organizationId: "o", conversationId: "c", isHumanTakeover: true, aiDisabled: false, now: NIGHT };

beforeEach(() => {
  vi.clearAllMocks();
  m.getOrganizationById.mockResolvedValue({ settings: { ai_after_hours_pending_enabled: true } });
  m.getOpenHandoffEvent.mockResolvedValue({ id: "h", handed_at: "2026-10-09T22:00:00Z" });
  m.countAfterHoursAgentReplies.mockResolvedValue(0);
});

describe("evaluateAfterHours", () => {
  it("runs at night with an open request_human handoff", async () => {
    expect(await evaluateAfterHours({} as any, base)).toEqual({ run: true, capped: false, handedAt: "2026-10-09T22:00:00Z" });
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
