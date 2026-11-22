import { describe, expect, it } from "vitest";
import { easterSunday, posseGoHolidays } from "./holidays-br.js";
import { addBusinessMinutes, isBusinessOpen, resolveBusinessCalendar } from "./business-calendar.js";

const WEEK = { mon: [{ start: "08:00", end: "18:00" }], tue: [{ start: "08:00", end: "18:00" }], wed: [{ start: "08:00", end: "18:00" }], thu: [{ start: "08:00", end: "18:00" }], fri: [{ start: "08:00", end: "18:00" }] };

describe("easterSunday", () => {
  it("calcula a Páscoa (base da Sexta-feira Santa)", () => {
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(easterSunday(2027)).toEqual({ month: 3, day: 28 });
    expect(easterSunday(2025)).toEqual({ month: 4, day: 20 });
  });
});

describe("posseGoHolidays", () => {
  it("2026: nacionais + Goiás + Posse, sem duplicar 26/07 e sem pontos facultativos", () => {
    const list = posseGoHolidays(2026);
    const dates = list.map((h) => h.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates).toEqual([
      "2026-01-01", "2026-04-03", "2026-04-21", "2026-05-01", "2026-07-19", "2026-07-26", "2026-09-07",
      "2026-10-12", "2026-10-19", "2026-11-02", "2026-11-15", "2026-11-20", "2026-12-25",
    ]);
    expect(dates).not.toContain("2026-02-17"); // Carnaval (ponto facultativo)
    expect(dates).not.toContain("2026-06-04"); // Corpus Christi (ponto facultativo)
    expect(dates).not.toContain("2026-10-28"); // Dia do Servidor Público: só serviço público
    expect(list.find((h) => h.date === "2026-07-26")?.name).toMatch(/Sant'Ana/);
  });
  it("Sexta-feira Santa móvel: 2027-03-26", () => {
    expect(posseGoHolidays(2027).map((h) => h.date)).toContain("2027-03-26");
  });
});

describe("resolveBusinessCalendar com feriados", () => {
  it("sem holiday_set nada muda (feriado continua aberto)", () => {
    const cal = resolveBusinessCalendar({ timeZone: "America/Sao_Paulo", weekly: WEEK });
    expect(isBusinessOpen(new Date("2026-04-03T15:00:00Z"), cal)).toBe(true);
  });
  it("posse_go fecha a Sexta-feira Santa e conta a partir do próximo dia útil", () => {
    const cal = resolveBusinessCalendar({ timeZone: "America/Sao_Paulo", weekly: WEEK, holiday_set: "posse_go" });
    expect(isBusinessOpen(new Date("2026-04-03T15:00:00Z"), cal)).toBe(false);
    // Quinta 02/04 17:30 + 60 min úteis: 30 min na quinta, sexta é feriado, segunda 06/04 08:30.
    expect(addBusinessMinutes(new Date("2026-04-02T20:30:00Z"), 60, cal).toISOString()).toBe("2026-04-06T11:30:00.000Z");
  });
  it("open_days reabre um feriado e extra_holidays fecha um dia a mais (ex.: decreto que transfere a data)", () => {
    const cal = resolveBusinessCalendar({
      timeZone: "America/Sao_Paulo", weekly: WEEK, holiday_set: "posse_go", open_days: ["2026-04-03"], extra_holidays: ["2026-07-20", "lixo"],
    });
    expect(isBusinessOpen(new Date("2026-04-03T15:00:00Z"), cal)).toBe(true);
    expect(isBusinessOpen(new Date("2026-07-20T15:00:00Z"), cal)).toBe(false);
  });
  it("feriado municipal em dia útil (19/10/2026, segunda) fica fechado", () => {
    const cal = resolveBusinessCalendar({ timeZone: "America/Sao_Paulo", weekly: WEEK, holiday_set: "posse_go" });
    expect(isBusinessOpen(new Date("2026-10-19T15:00:00Z"), cal)).toBe(false);
    expect(isBusinessOpen(new Date("2026-10-20T15:00:00Z"), cal)).toBe(true);
  });
  it("mantém closedDates já configuradas junto com os feriados", () => {
    const cal = resolveBusinessCalendar({ timeZone: "America/Sao_Paulo", weekly: WEEK, holiday_set: "posse_go", closedDates: ["2026-12-24"] });
    expect(cal.closedDates).toContain("2026-12-24");
    expect(cal.closedDates).toContain("2026-12-25");
  });
});
