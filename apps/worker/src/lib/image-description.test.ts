import { describe, it, expect } from "vitest";
import { buildImageDescriptionPrompt, exceedsSizeCap } from "./image-description.js";

describe("buildImageDescriptionPrompt", () => {
  it("returns the base prompt when there is no caption", () => {
    const prompt = buildImageDescriptionPrompt();
    expect(prompt).toContain("Descreva em português");
    expect(prompt).not.toContain("escreveu junto");
  });

  it("appends the caption as extra context when present", () => {
    const prompt = buildImageDescriptionPrompt("quanto vale essa?");
    expect(prompt).toContain("Descreva em português");
    expect(prompt).toContain('"quanto vale essa?"');
  });
});

describe("exceedsSizeCap", () => {
  it("returns false for an image under 10 MB", () => {
    expect(exceedsSizeCap(5 * 1024 * 1024)).toBe(false);
  });

  it("returns false for exactly 10 MB", () => {
    expect(exceedsSizeCap(10 * 1024 * 1024)).toBe(false);
  });

  it("returns true for an image over 10 MB", () => {
    expect(exceedsSizeCap(10 * 1024 * 1024 + 1)).toBe(true);
  });
});
