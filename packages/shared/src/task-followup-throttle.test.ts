import { describe, it, expect } from "vitest";
import { evaluateFollowupThrottle } from "./task-followup-throttle.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");

describe("evaluateFollowupThrottle", () => {
  it("allows sending when there is no previous send for the instance", () => {
    const result = evaluateFollowupThrottle({
      lastSentAt: null,
      sentTodayCount: 0,
      minIntervalSeconds: 45,
      dailyLimit: 40,
      now: NOW,
    });
    expect(result).toEqual({ allowed: true });
  });

  it("blocks when the last send was within the minimum interval", () => {
    const lastSentAt = new Date(NOW.getTime() - 20_000).toISOString(); // 20s ago
    const result = evaluateFollowupThrottle({
      lastSentAt,
      sentTodayCount: 1,
      minIntervalSeconds: 45,
      dailyLimit: 40,
      now: NOW,
    });
    expect(result).toEqual({ allowed: false, reason: "min_interval", retryAfterSeconds: 25 });
  });

  it("allows when the last send was exactly at the minimum interval boundary", () => {
    const lastSentAt = new Date(NOW.getTime() - 45_000).toISOString();
    const result = evaluateFollowupThrottle({
      lastSentAt,
      sentTodayCount: 1,
      minIntervalSeconds: 45,
      dailyLimit: 40,
      now: NOW,
    });
    expect(result).toEqual({ allowed: true });
  });

  it("blocks when the daily limit was reached, even outside the interval window", () => {
    const lastSentAt = new Date(NOW.getTime() - 3_600_000).toISOString(); // 1h ago
    const result = evaluateFollowupThrottle({
      lastSentAt,
      sentTodayCount: 40,
      minIntervalSeconds: 45,
      dailyLimit: 40,
      now: NOW,
    });
    expect(result).toEqual({ allowed: false, reason: "daily_limit" });
  });

  it("reports min_interval first when both limits are hit simultaneously", () => {
    const lastSentAt = new Date(NOW.getTime() - 5_000).toISOString();
    const result = evaluateFollowupThrottle({
      lastSentAt,
      sentTodayCount: 41,
      minIntervalSeconds: 45,
      dailyLimit: 40,
      now: NOW,
    });
    expect(result).toMatchObject({ allowed: false, reason: "min_interval" });
  });

  it("allows when under the daily limit and past the interval", () => {
    const lastSentAt = new Date(NOW.getTime() - 60_000).toISOString();
    const result = evaluateFollowupThrottle({
      lastSentAt,
      sentTodayCount: 39,
      minIntervalSeconds: 45,
      dailyLimit: 40,
      now: NOW,
    });
    expect(result).toEqual({ allowed: true });
  });
});
