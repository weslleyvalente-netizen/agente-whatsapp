import { describe, expect, it } from "vitest";
import { isBusinessOpen } from "./business-calendar.js";
import { shouldRunAiAfterHours, handoffStartedTakeover, AFTER_HOURS_MAX_REPLIES_PER_CONVERSATION } from "./ai-after-hours.js";

const base = { isHumanTakeover: true, hasOpenRequestHumanHandoff: true, takeoverOriginatedFromHandoff: true, businessOpen: false, aiDisabled: false, flagEnabled: true };

describe("shouldRunAiAfterHours", () => {
  it("runs when all four conditions and the flag hold", () => {
    expect(shouldRunAiAfterHours(base)).toBe(true);
  });
  it.each([
    ["flag off", { flagEnabled: false }],
    ["not in takeover", { isHumanTakeover: false }],
    ["no open request_human handoff (manual takeover)", { hasOpenRequestHumanHandoff: false }],
    ["takeover not originated from the open handoff (manual takeover later)", { takeoverOriginatedFromHandoff: false }],
    ["business open", { businessOpen: true }],
    ["ai disabled", { aiDisabled: true }],
  ])("does not run: %s", (_n, patch) => {
    expect(shouldRunAiAfterHours({ ...base, ...patch })).toBe(false);
  });
  it("integrates with the business calendar (saturday, 17:59, 18:00)", () => {
    const open = (iso: string) => isBusinessOpen(new Date(iso));
    expect(shouldRunAiAfterHours({ ...base, businessOpen: open("2026-10-10T15:00:00Z") })).toBe(true); // sáb 12:00
    expect(shouldRunAiAfterHours({ ...base, businessOpen: open("2026-10-09T20:59:00Z") })).toBe(false); // sex 17:59
    expect(shouldRunAiAfterHours({ ...base, businessOpen: open("2026-10-09T21:00:00Z") })).toBe(true); // sex 18:00
  });
  it("exposes a per-conversation reply cap", () => {
    expect(AFTER_HOURS_MAX_REPLIES_PER_CONVERSATION).toBe(20);
  });
});

describe("handoffStartedTakeover", () => {
  it("accepts a handoff created with the takeover (and within 60s skew)", () => {
    expect(handoffStartedTakeover("2026-10-09T22:00:00Z", "2026-10-09T22:00:00Z")).toBe(true);
    expect(handoffStartedTakeover("2026-10-09T21:59:30Z", "2026-10-09T22:00:00Z")).toBe(true);
  });
  it("rejects a stale handoff older than the current takeover, or missing data", () => {
    expect(handoffStartedTakeover("2026-10-01T22:00:00Z", "2026-10-09T22:00:00Z")).toBe(false);
    expect(handoffStartedTakeover("2026-10-09T21:58:00Z", "2026-10-09T22:00:00Z")).toBe(false);
    expect(handoffStartedTakeover(null, "2026-10-09T22:00:00Z")).toBe(false);
    expect(handoffStartedTakeover("2026-10-09T22:00:00Z", null)).toBe(false);
  });
});
