import { describe, it, expect } from "vitest";
import { formatDateTimeForPrompt, toISODateInTimeZone, isWithinBusinessHours } from "./date.js";

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

describe("isWithinBusinessHours", () => {
  it("is true right at the start of the window (8h São Paulo)", () => {
    const date = new Date("2026-07-24T11:00:00.000Z"); // 08:00 in São Paulo
    expect(isWithinBusinessHours(date, 8, 18)).toBe(true);
  });

  it("is true just before the end of the window (17:59 São Paulo)", () => {
    const date = new Date("2026-07-24T20:59:00.000Z"); // 17:59 in São Paulo
    expect(isWithinBusinessHours(date, 8, 18)).toBe(true);
  });

  it("is false once the window has ended (18:00 São Paulo)", () => {
    const date = new Date("2026-07-24T21:00:00.000Z"); // 18:00 in São Paulo
    expect(isWithinBusinessHours(date, 8, 18)).toBe(false);
  });

  it("is false before the window opens (07:59 São Paulo)", () => {
    const date = new Date("2026-07-24T10:59:00.000Z"); // 07:59 in São Paulo
    expect(isWithinBusinessHours(date, 8, 18)).toBe(false);
  });

  it("is false at 3am São Paulo regardless of what UTC day it is", () => {
    const date = new Date("2026-07-25T06:00:00.000Z"); // 03:00 on the 25th in São Paulo
    expect(isWithinBusinessHours(date, 8, 18)).toBe(false);
  });
});
