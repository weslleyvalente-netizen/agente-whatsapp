import { describe, it, expect } from "vitest";
import { isHumanTakeoverExpired, isUnread } from "./conversation-helpers.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

describe("isHumanTakeoverExpired", () => {
  it("returns false when there is no takeover in progress", () => {
    expect(isHumanTakeoverExpired(null, undefined, DEFAULT_TIMEOUT_MS, Date.now())).toBe(false);
  });

  it("uses the default timeout when the org hasn't configured one", () => {
    const now = new Date("2026-07-28T12:00:00Z").getTime();
    const justUnderDefault = new Date("2026-07-28T11:31:00Z").toISOString(); // 29 min ago
    const justOverDefault = new Date("2026-07-28T11:29:00Z").toISOString(); // 31 min ago

    expect(isHumanTakeoverExpired(justUnderDefault, undefined, DEFAULT_TIMEOUT_MS, now)).toBe(false);
    expect(isHumanTakeoverExpired(justOverDefault, undefined, DEFAULT_TIMEOUT_MS, now)).toBe(true);
  });

  it("uses the org's configured timeout instead of the default when set", () => {
    const now = new Date("2026-07-28T12:00:00Z").getTime();
    const fortyFiveMinAgo = new Date("2026-07-28T11:15:00Z").toISOString();

    // Default (30 min) would have expired this, but the org configured 60 min.
    expect(isHumanTakeoverExpired(fortyFiveMinAgo, 60, DEFAULT_TIMEOUT_MS, now)).toBe(false);
    // A tighter org timeout (10 min) expires it sooner than the default would.
    expect(isHumanTakeoverExpired(fortyFiveMinAgo, 10, DEFAULT_TIMEOUT_MS, now)).toBe(true);
  });

  it("never expires when the org disabled auto-resume (null)", () => {
    const daysAgo = new Date("2026-07-01T00:00:00Z").toISOString();
    const now = new Date("2026-07-28T12:00:00Z").getTime();
    expect(isHumanTakeoverExpired(daysAgo, null, DEFAULT_TIMEOUT_MS, now)).toBe(false);
  });
});

describe("isUnread", () => {
  it("is true when the conversation has never been read", () => {
    expect(isUnread("2026-08-03T12:00:00Z", undefined)).toBe(true);
  });

  it("is true when the last message came after the last read", () => {
    expect(isUnread("2026-08-03T12:05:00Z", "2026-08-03T12:00:00Z")).toBe(true);
  });

  it("is false when the last read was after the last message", () => {
    expect(isUnread("2026-08-03T12:00:00Z", "2026-08-03T12:05:00Z")).toBe(false);
  });

  it("is false when read exactly at the last message timestamp", () => {
    expect(isUnread("2026-08-03T12:00:00Z", "2026-08-03T12:00:00Z")).toBe(false);
  });
});
