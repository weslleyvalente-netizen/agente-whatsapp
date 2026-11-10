import { describe, expect, it } from "vitest";
import { contactDisplayName, formatElapsed, overdueLabel } from "./sla-nudge.js";

const now = new Date("2026-11-09T12:00:00Z");
describe("formatElapsed", () => {
  it("minutos, horas e dias", () => {
    expect(formatElapsed(20_000)).toBe("menos de 1 min");
    expect(formatElapsed(5 * 60_000)).toBe("5 min");
    expect(formatElapsed(59 * 60_000)).toBe("59 min");
    expect(formatElapsed(60 * 60_000)).toBe("1 h");
    expect(formatElapsed(150 * 60_000)).toBe("2 h");
    expect(formatElapsed(24 * 3_600_000)).toBe("1 dia");
    expect(formatElapsed(73 * 3_600_000)).toBe("3 dias");
  });
  it("negativo vira zero", () => expect(formatElapsed(-5)).toBe("menos de 1 min"));
});
describe("overdueLabel", () => {
  it("relativo ao prazo", () => {
    expect(overdueLabel("2026-11-09T11:55:00Z", now)).toBe("venceu há 5 min");
    expect(overdueLabel("2026-11-09T09:30:00Z", now)).toBe("venceu há 2 h");
    expect(overdueLabel("2026-11-06T12:00:00Z", now)).toBe("venceu há 3 dias");
  });
  it("sem prazo válido", () => {
    expect(overdueLabel(null, now)).toBe("prazo vencido");
    expect(overdueLabel("lixo", now)).toBe("prazo vencido");
  });
});
describe("contactDisplayName", () => {
  it("nome, telefone, @lid e vazio", () => {
    expect(contactDisplayName(" Ana ", "5511")).toBe("Ana");
    expect(contactDisplayName(null, "5511999990000")).toBe("5511999990000");
    expect(contactDisplayName("", "123@lid")).toBe("Contato sem telefone");
    expect(contactDisplayName(null, null)).toBe("Contato sem telefone");
  });
});
