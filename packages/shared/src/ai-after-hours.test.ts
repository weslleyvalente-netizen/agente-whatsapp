import { describe, expect, it } from "vitest";
import { isBusinessOpen } from "./business-calendar.js";
import { shouldRunAiAfterHours, AFTER_HOURS_MAX_REPLIES_PER_CONVERSATION } from "./ai-after-hours.js";

const base = { isHumanTakeover: true, hasOpenRequestHumanHandoff: true, businessOpen: false, aiDisabled: false, flagEnabled: true };

describe("shouldRunAiAfterHours", () => {
  it("runs when all four conditions and the flag hold", () => {
    expect(shouldRunAiAfterHours(base)).toBe(true);
  });
  it.each([
    ["flag off", { flagEnabled: false }],
    ["not in takeover", { isHumanTakeover: false }],
    ["no open request_human handoff (manual takeover)", { hasOpenRequestHumanHandoff: false }],
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
