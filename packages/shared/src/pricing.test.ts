import { describe, it, expect } from "vitest";
import { computeMessageCostUsd } from "./pricing.js";

describe("computeMessageCostUsd", () => {
  it("returns null for a model with no pricing entry", () => {
    expect(computeMessageCostUsd("unknown-model", 1000, 100)).toBeNull();
  });

  it("prices input/output at the flat rate when no cache tokens are given (pre-caching messages)", () => {
    const cost = computeMessageCostUsd("claude-sonnet-5", 1000, 100);
    expect(cost).toBeCloseTo((1000 * 2.0 + 100 * 10.0) / 1_000_000, 10);
  });

  it("prices a cache write at 1.25x the base input rate, on top of the non-cached remainder", () => {
    // 2400 of the 3000 input tokens were written to cache; the other 600 were not.
    const cost = computeMessageCostUsd("claude-sonnet-5", 3000, 100, 0, 2400);
    const expected = (600 * 2.0 + 2400 * 2.0 * 1.25 + 100 * 10.0) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("prices a cache read at 0.1x the base input rate, on top of the non-cached remainder", () => {
    // 2400 of the 2500 input tokens were served from cache; the other 100 were not.
    const cost = computeMessageCostUsd("claude-sonnet-5", 2500, 100, 2400, 0);
    const expected = (100 * 2.0 + 2400 * 2.0 * 0.1 + 100 * 10.0) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
  });

  // Real numbers captured live against the Anthropic API while verifying
  // the prompt-caching change (agent-runtime): first call in a conversation
  // writes the cache, the next one reads it back.
  it("matches the real write -> hit pair observed in production verification", () => {
    const writeCost = computeMessageCostUsd("claude-sonnet-5", 4477, 30, 0, 4432);
    const hitCost = computeMessageCostUsd("claude-sonnet-5", 4521, 24, 4432, 0);

    expect(writeCost).toBeCloseTo((45 * 2.0 + 4432 * 2.0 * 1.25 + 30 * 10.0) / 1_000_000, 10);
    expect(hitCost).toBeCloseTo((89 * 2.0 + 4432 * 2.0 * 0.1 + 24 * 10.0) / 1_000_000, 10);
    // The whole point of caching: the hit call should cost meaningfully
    // less than the write call despite having slightly more total input.
    expect(hitCost!).toBeLessThan(writeCost! * 0.5);
  });

  it("never goes negative when cache token counts exceed the reported input total (defensive)", () => {
    const cost = computeMessageCostUsd("claude-sonnet-5", 100, 10, 200, 0);
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});
