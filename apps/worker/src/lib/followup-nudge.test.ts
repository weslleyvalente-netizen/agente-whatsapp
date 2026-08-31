import { describe, it, expect } from "vitest";
import { buildFollowupNudgeInstruction } from "./followup-nudge.js";

describe("buildFollowupNudgeInstruction", () => {
  it("stage 1 mentions the elapsed hours and allows the model to opt out", () => {
    const text = buildFollowupNudgeInstruction(1, 1.4);
    expect(text).toContain("1 hora");
    expect(text).toContain("string vazia");
  });

  it("stage 2 says it's the last attempt and allows the model to opt out", () => {
    const text = buildFollowupNudgeInstruction(2, 23.2);
    expect(text).toContain("23 horas");
    expect(text).toContain("última tentativa");
    expect(text).toContain("string vazia");
  });

  it("rounds fractional hours to the nearest whole number", () => {
    expect(buildFollowupNudgeInstruction(1, 1.9)).toContain("2 hora");
  });
});
