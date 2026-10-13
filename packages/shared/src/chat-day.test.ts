import { describe, expect, it } from "vitest";
import { chatDayKey, chatDayLabel } from "./chat-day.js";

const now = "2026-10-13T18:00:00Z"; // terça, 15h em Brasília

describe("chatDayKey", () => {
  it("usa o dia de Brasília (23h BRT ainda é o mesmo dia, mesmo já sendo o dia seguinte em UTC)", () => {
    expect(chatDayKey("2026-10-14T02:30:00Z")).toBe("2026-10-13");
    expect(chatDayKey("2026-10-13T02:30:00Z")).toBe("2026-10-12");
  });
});

describe("chatDayLabel", () => {
  it("Hoje e Ontem", () => {
    expect(chatDayLabel("2026-10-13T12:00:00Z", now)).toBe("Hoje");
    expect(chatDayLabel("2026-10-12T20:00:00Z", now)).toBe("Ontem");
  });
  it("dia da semana até 6 dias atrás", () => {
    expect(chatDayLabel("2026-10-10T15:00:00Z", now)).toBe("Sábado");
    expect(chatDayLabel("2026-10-07T15:00:00Z", now)).toBe("Quarta-feira");
  });
  it("data completa a partir de 7 dias", () => {
    expect(chatDayLabel("2026-10-06T15:00:00Z", now)).toBe("06/10/2026");
    expect(chatDayLabel("2025-12-31T15:00:00Z", now)).toBe("31/12/2025");
  });
  it("mensagem logo após a meia-noite de Brasília conta como o dia novo", () => {
    expect(chatDayLabel("2026-10-13T03:05:00Z", "2026-10-13T15:00:00Z")).toBe("Hoje");
    expect(chatDayLabel("2026-10-13T02:55:00Z", "2026-10-13T15:00:00Z")).toBe("Ontem");
  });
});
