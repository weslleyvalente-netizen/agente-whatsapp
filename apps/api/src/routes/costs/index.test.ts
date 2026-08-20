import { describe, it, expect, vi } from "vitest";
import { buildSummary } from "./index.js";

describe("buildSummary", () => {
  it("includes ai_usage_events (Playground, Trainer, image description, import suggestions) in the totals, not just real customer messages", () => {
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));

    const messages = [
      {
        created_at: "2026-08-20T10:00:00Z",
        metadata: { model: "claude-sonnet-5", input_tokens: 10000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0 },
      },
    ];
    const usageEvents = [
      {
        created_at: "2026-08-20T11:00:00Z",
        source: "trainer" as const,
        model: "claude-sonnet-5",
        input_tokens: 20000,
        output_tokens: 500,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    ];

    const messagesOnly = buildSummary(messages, []);
    const combined = buildSummary(messages, usageEvents);

    // claude-sonnet-5: $2/M input, $10/M output (see packages/shared/src/pricing.ts)
    const trainerCostUsd = (20000 * 2 + 500 * 10) / 1_000_000;
    expect(combined.totalCostUsd).toBeCloseTo(messagesOnly.totalCostUsd + trainerCostUsd, 6);
    expect(combined.todayCostUsd).toBeCloseTo(messagesOnly.todayCostUsd + trainerCostUsd, 6);

    vi.useRealTimers();
  });

  it("breaks costs down by source, so Playground/Trainer/image-description spend isn't hidden inside the total", () => {
    const messages = [
      { created_at: "2026-08-20T10:00:00Z", metadata: { model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 } },
    ];
    const usageEvents = [
      { created_at: "2026-08-20T11:00:00Z", source: "trainer" as const, model: "claude-sonnet-5", input_tokens: 2000, output_tokens: 60, cache_read_tokens: 0, cache_write_tokens: 0 },
      { created_at: "2026-08-20T11:05:00Z", source: "playground" as const, model: "claude-sonnet-5", input_tokens: 3000, output_tokens: 70, cache_read_tokens: 0, cache_write_tokens: 0 },
    ];

    const result = buildSummary(messages, usageEvents);

    const sources = result.bySource.map((s) => s.source).sort();
    expect(sources).toEqual(["conversation", "playground", "trainer"]);
    const trainerEntry = result.bySource.find((s) => s.source === "trainer")!;
    expect(trainerEntry.costUsd).toBeCloseTo((2000 * 2 + 60 * 10) / 1_000_000, 6);
  });

  it("folds usage-event costs into the same daily buckets as real messages", () => {
    const messages = [
      { created_at: "2026-08-15T10:00:00Z", metadata: { model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 } },
    ];
    const usageEvents = [
      { created_at: "2026-08-15T14:00:00Z", source: "playground" as const, model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 },
    ];

    const result = buildSummary(messages, usageEvents);

    const day = result.dailyCosts.find((d) => d.date === "2026-08-15");
    expect(day).toBeDefined();
    expect(day!.messageCount).toBe(2);
  });
});
