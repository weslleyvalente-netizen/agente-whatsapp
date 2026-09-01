import { describe, it, expect } from "vitest";
import { extractTokenUsage } from "./token-usage.js";

describe("extractTokenUsage", () => {
  it("reads input/output tokens and cache read/write from the AI SDK's usage shape", () => {
    const usage = {
      inputTokens: 5000,
      outputTokens: 200,
      inputTokenDetails: { cacheReadTokens: 4500, cacheWriteTokens: 0 },
    };
    expect(extractTokenUsage(usage)).toEqual({
      inputTokens: 5000,
      outputTokens: 200,
      cacheReadTokens: 4500,
      cacheWriteTokens: 0,
    });
  });

  it("defaults every field to 0 when usage is undefined", () => {
    expect(extractTokenUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("defaults cache fields to 0 when inputTokenDetails is missing", () => {
    const usage = { inputTokens: 100, outputTokens: 20 };
    expect(extractTokenUsage(usage)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
