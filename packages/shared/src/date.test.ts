import { describe, it, expect } from "vitest";
import { formatDateTimeForPrompt, toISODateInTimeZone } from "./date.js";

describe("formatDateTimeForPrompt", () => {
  it("formats a UTC instant as a long pt-BR date/time in America/Sao_Paulo", () => {
    const date = new Date("2026-07-24T17:32:00.000Z"); // 14:32 in São Paulo (UTC-3)
    expect(formatDateTimeForPrompt(date)).toBe("sexta-feira, 24 de julho de 2026 às 14:32");
  });
});

describe("toISODateInTimeZone", () => {
  it("returns the São Paulo calendar date even when UTC has already rolled to the next day", () => {
    const date = new Date("2026-07-25T01:59:00.000Z"); // still 22:59 on the 24th in São Paulo
    expect(toISODateInTimeZone(date)).toBe("2026-07-24");
  });

  it("returns the next day once São Paulo itself has rolled over", () => {
    const date = new Date("2026-07-25T03:01:00.000Z"); // 00:01 on the 25th in São Paulo
    expect(toISODateInTimeZone(date)).toBe("2026-07-25");
  });
});
