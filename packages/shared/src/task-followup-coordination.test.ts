import { describe, it, expect } from "vitest";
import { evaluateFollowupCoordination } from "./task-followup-coordination.js";

const NOW = new Date("2026-09-29T16:00:00.000Z");
const CONFIG = { minHoursSinceLastTouch: 4, maxTouchesWithoutReply: 3 };

describe("evaluateFollowupCoordination", () => {
  it("allows sending when there was never a touch since the customer's last reply", () => {
    const result = evaluateFollowupCoordination({ lastTouchAt: null, lastTouchBy: null, touchCount: 0 }, CONFIG, NOW);
    expect(result).toEqual({ allowed: true });
  });

  it("blocks when the last touch is more recent than the minimum interval", () => {
    const lastTouchAt = new Date(NOW.getTime() - 2 * 3_600_000).toISOString(); // 2h ago
    const result = evaluateFollowupCoordination(
      { lastTouchAt, lastTouchBy: "agent", touchCount: 1 },
      CONFIG,
      NOW
    );
    expect(result).toEqual({ allowed: false, reason: "recent_touch", hoursSinceTouch: 2 });
  });

  it("allows when the last touch is exactly at the minimum interval boundary", () => {
    const lastTouchAt = new Date(NOW.getTime() - 4 * 3_600_000).toISOString();
    const result = evaluateFollowupCoordination(
      { lastTouchAt, lastTouchBy: "human_agent", touchCount: 1 },
      CONFIG,
      NOW
    );
    expect(result).toEqual({ allowed: true });
  });

  it("allows when the last touch is older than the minimum interval", () => {
    const lastTouchAt = new Date(NOW.getTime() - 5 * 3_600_000).toISOString();
    const result = evaluateFollowupCoordination(
      { lastTouchAt, lastTouchBy: "agent", touchCount: 2 },
      CONFIG,
      NOW
    );
    expect(result).toEqual({ allowed: true });
  });

  it("blocks with touch_limit_reached when the touch count meets the max, even outside the interval window", () => {
    const lastTouchAt = new Date(NOW.getTime() - 48 * 3_600_000).toISOString(); // 2 days ago
    const result = evaluateFollowupCoordination(
      { lastTouchAt, lastTouchBy: "agent", touchCount: 3 },
      CONFIG,
      NOW
    );
    expect(result).toEqual({ allowed: false, reason: "touch_limit_reached", touchCount: 3 });
  });

  it("reports touch_limit_reached before recent_touch when both conditions are true", () => {
    const lastTouchAt = new Date(NOW.getTime() - 1 * 3_600_000).toISOString();
    const result = evaluateFollowupCoordination(
      { lastTouchAt, lastTouchBy: "human_agent", touchCount: 3 },
      CONFIG,
      NOW
    );
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toBe("touch_limit_reached");
  });
});
