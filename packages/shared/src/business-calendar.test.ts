import { describe, expect, it } from "vitest";
import {
  addBusinessMinutes, DEFAULT_BUSINESS_CALENDAR, isBusinessOpen, resolveBusinessCalendar, nextBusinessOpening, lastBusinessClosing, describeBusinessInstant,
  type BusinessCalendar,
} from "./business-calendar.js";

// 2026-10-09 é sexta, 10 sábado, 11 domingo, 12 segunda. America/Sao_Paulo = UTC-3 (sem horário de verão).
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("isBusinessOpen", () => {
  it("abre em dia útil dentro da janela e fecha fora dela", () => {
    expect(isBusinessOpen(at("2026-10-09T11:00:00Z"))).toBe(true);   // sex 08:00
    expect(isBusinessOpen(at("2026-10-09T20:59:00Z"))).toBe(true);   // sex 17:59
    expect(isBusinessOpen(at("2026-10-09T21:00:00Z"))).toBe(false);  // sex 18:00
    expect(isBusinessOpen(at("2026-10-09T09:00:00Z"))).toBe(false);  // sex 06:00
  });
  it("fica fechado de madrugada, sábado e domingo", () => {
    expect(isBusinessOpen(at("2026-10-09T05:00:00Z"))).toBe(false);  // sex 02:00
    expect(isBusinessOpen(at("2026-10-10T15:00:00Z"))).toBe(false);  // sáb 12:00
    expect(isBusinessOpen(at("2026-10-11T15:00:00Z"))).toBe(false);  // dom 12:00
  });
  it("respeita data fechada e período fechado", () => {
    const cal: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, closedDates: ["2026-10-12"] };
    expect(isBusinessOpen(at("2026-10-12T15:00:00Z"), cal)).toBe(false);
    const period: BusinessCalendar = {
      ...DEFAULT_BUSINESS_CALENDAR,
      closedPeriods: [{ from: "2026-10-13T00:00:00-03:00", to: "2026-10-14T00:00:00-03:00", reason: "recesso" }],
    };
    expect(isBusinessOpen(at("2026-10-13T15:00:00Z"), period)).toBe(false);
    expect(isBusinessOpen(at("2026-10-14T15:00:00Z"), period)).toBe(true);
  });
  it("aceita janela de sábado configurada, sem fixar sábado na lógica", () => {
    const cal: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, weekly: { ...DEFAULT_BUSINESS_CALENDAR.weekly, sat: [{ start: "08:00", end: "12:00" }] } };
    expect(isBusinessOpen(at("2026-10-10T14:00:00Z"), cal)).toBe(true);   // sáb 11:00
    expect(isBusinessOpen(at("2026-10-10T15:00:00Z"), cal)).toBe(false);  // sáb 12:00
  });
});

describe("addBusinessMinutes", () => {
  it("soma dentro do expediente", () => {
    expect(iso(addBusinessMinutes(at("2026-10-05T12:00:00Z"), 15))).toBe("2026-10-05T12:15:00.000Z"); // seg 09:00
  });
  it("antes de abrir, o relógio começa na abertura", () => {
    expect(iso(addBusinessMinutes(at("2026-10-05T10:00:00Z"), 15))).toBe("2026-10-05T11:15:00.000Z"); // seg 07:00 → 08:15
  });
  it("atravessa o fim do expediente e o fim de semana", () => {
    expect(iso(addBusinessMinutes(at("2026-10-09T20:50:00Z"), 15))).toBe("2026-10-12T11:05:00.000Z"); // sex 17:50 → seg 08:05
  });
  it("sábado e domingo só começam a contar na segunda", () => {
    expect(iso(addBusinessMinutes(at("2026-10-10T15:00:00Z"), 15))).toBe("2026-10-12T11:15:00.000Z");
    expect(iso(addBusinessMinutes(at("2026-10-11T15:00:00Z"), 15))).toBe("2026-10-12T11:15:00.000Z");
  });
  it("de madrugada só conta a partir da abertura", () => {
    expect(iso(addBusinessMinutes(at("2026-10-06T05:00:00Z"), 15))).toBe("2026-10-06T11:15:00.000Z"); // ter 02:00 → 08:15
  });
  it("pula feriado e período fechado", () => {
    const holiday: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, closedDates: ["2026-10-12"] };
    expect(iso(addBusinessMinutes(at("2026-10-09T20:50:00Z"), 15, holiday))).toBe("2026-10-13T11:05:00.000Z");
    const period: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, closedPeriods: [{ from: "2026-10-12T00:00:00-03:00", to: "2026-10-13T00:00:00-03:00" }] };
    expect(iso(addBusinessMinutes(at("2026-10-09T20:50:00Z"), 15, period))).toBe("2026-10-13T11:05:00.000Z");
  });
  it("usa a janela de sábado quando configurada", () => {
    const cal: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, weekly: { ...DEFAULT_BUSINESS_CALENDAR.weekly, sat: [{ start: "08:00", end: "12:00" }] } };
    expect(iso(addBusinessMinutes(at("2026-10-10T14:50:00Z"), 15, cal))).toBe("2026-10-12T11:05:00.000Z"); // sáb 11:50 → seg 08:05
  });
  it("zero minutos devolve o próprio instante", () => {
    expect(iso(addBusinessMinutes(at("2026-10-05T12:00:00Z"), 0))).toBe("2026-10-05T12:00:00.000Z");
  });
  it("lança quando o calendário não tem nenhuma janela aberta", () => {
    expect(() => addBusinessMinutes(at("2026-10-05T12:00:00Z"), 15, { timeZone: "America/Sao_Paulo", weekly: {} })).toThrow();
  });
});

describe("resolveBusinessCalendar", () => {
  it("usa o padrão para valores ausentes, inválidos ou sem janelas", () => {
    expect(resolveBusinessCalendar(undefined)).toEqual(DEFAULT_BUSINESS_CALENDAR);
    expect(resolveBusinessCalendar("lixo")).toEqual(DEFAULT_BUSINESS_CALENDAR);
    expect(resolveBusinessCalendar({ timeZone: "America/Sao_Paulo", weekly: {} })).toEqual(DEFAULT_BUSINESS_CALENDAR);
    expect(resolveBusinessCalendar({ timeZone: "Nao/Existe", weekly: { mon: [{ start: "08:00", end: "18:00" }] } })).toEqual(DEFAULT_BUSINESS_CALENDAR);
    expect(resolveBusinessCalendar({ weekly: { mon: [{ start: "25:00", end: "18:00" }] } })).toEqual(DEFAULT_BUSINESS_CALENDAR);
  });
  it("aceita um calendário válido e completa o fuso", () => {
    const cal = resolveBusinessCalendar({ weekly: { sat: [{ start: "08:00", end: "12:00" }] } });
    expect(cal.timeZone).toBe("America/Sao_Paulo");
    expect(cal.weekly.sat).toEqual([{ start: "08:00", end: "12:00" }]);
  });
});

describe("nextBusinessOpening / lastBusinessClosing / describeBusinessInstant", () => {
  it("sexta 18:00 -> segunda 08:00; domingo -> segunda 08:00", () => {
    expect(iso(nextBusinessOpening(at("2026-10-09T21:00:00Z"))!)).toBe("2026-10-12T11:00:00.000Z");
    expect(iso(nextBusinessOpening(at("2026-10-11T15:00:00Z"))!)).toBe("2026-10-12T11:00:00.000Z");
  });
  it("segunda 07:59 -> 08:00 do mesmo dia; segunda 08:00 (aberto) -> terça 08:00", () => {
    expect(iso(nextBusinessOpening(at("2026-10-12T10:59:00Z"))!)).toBe("2026-10-12T11:00:00.000Z");
    expect(iso(nextBusinessOpening(at("2026-10-12T11:00:00Z"))!)).toBe("2026-10-13T11:00:00.000Z");
  });
  it("pula feriado (closedDates) e período fechado", () => {
    const hol: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, closedDates: ["2026-10-12"] };
    expect(iso(nextBusinessOpening(at("2026-10-11T15:00:00Z"), hol)!)).toBe("2026-10-13T11:00:00.000Z");
    const per: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, closedPeriods: [{ from: "2026-10-12T00:00:00-03:00", to: "2026-10-14T00:00:00-03:00" }] };
    expect(iso(nextBusinessOpening(at("2026-10-11T15:00:00Z"), per)!)).toBe("2026-10-14T11:00:00.000Z");
  });
  it("respeita janela de sábado", () => {
    const sat: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, weekly: { ...DEFAULT_BUSINESS_CALENDAR.weekly, sat: [{ start: "09:00", end: "13:00" }] } };
    expect(iso(nextBusinessOpening(at("2026-10-09T21:00:00Z"), sat)!)).toBe("2026-10-10T12:00:00.000Z");
    expect(isBusinessOpen(at("2026-10-10T15:00:00Z"), sat)).toBe(true);
  });
  it("lastBusinessClosing: null aberto; sexta 18:00 no sábado e domingo; mesmo dia à noite", () => {
    expect(lastBusinessClosing(at("2026-10-09T15:00:00Z"))).toBeNull();
    expect(iso(lastBusinessClosing(at("2026-10-10T15:00:00Z"))!)).toBe("2026-10-09T21:00:00.000Z");
    expect(iso(lastBusinessClosing(at("2026-10-11T15:00:00Z"))!)).toBe("2026-10-09T21:00:00.000Z");
    expect(iso(lastBusinessClosing(at("2026-10-13T01:00:00Z"))!)).toBe("2026-10-12T21:00:00.000Z"); // seg 22:00
  });
  it("describeBusinessInstant", () => {
    expect(describeBusinessInstant(at("2026-10-12T11:00:00Z"))).toBe("segunda, 12/10, às 08:00");
  });
});
