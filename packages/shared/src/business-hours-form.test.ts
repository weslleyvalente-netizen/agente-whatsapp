import { describe, it, expect } from "vitest";
import { calendarFromForm, formFromCalendar, validateBusinessHoursForm, DEFAULT_BUSINESS_HOURS_FORM, NATIONAL_HOLIDAYS_2026_2027 } from "./business-hours-form.js";
import { isBusinessOpen, addBusinessMinutes } from "./business-calendar.js";

const form = { ...DEFAULT_BUSINESS_HOURS_FORM, closedDates: [...NATIONAL_HOLIDAYS_2026_2027] };

describe("business hours form", () => {
  it("builds a calendar that is open on Saturday morning and closed on the holiday", () => {
    const cal = calendarFromForm(form);
    expect(isBusinessOpen(new Date("2026-10-31T13:00:00Z"), cal)).toBe(true);  // sáb 10:00 BRT
    expect(isBusinessOpen(new Date("2026-10-31T16:00:00Z"), cal)).toBe(false); // sáb 13:00 BRT
    expect(isBusinessOpen(new Date("2026-11-02T12:00:00Z"), cal)).toBe(false); // Finados
    expect(isBusinessOpen(new Date("2026-11-03T10:45:00Z"), cal)).toBe(true);  // ter 07:45 BRT
  });
  it("pushes an SLA due date started on the holiday to the next business morning", () => {
    const due = addBusinessMinutes(new Date("2026-11-02T11:30:00Z"), 36, calendarFromForm(form));
    expect(due.toISOString()).toBe("2026-11-03T11:06:00.000Z"); // ter 08:06 BRT = 07:30 + 36 min
  });
  it("round-trips and keeps timezone and closed periods of the current calendar", () => {
    const current = { timeZone: "America/Sao_Paulo", weekly: { mon: [{ start: "09:00", end: "17:00" }] }, closedPeriods: [{ from: "2026-12-20T00:00:00Z", to: "2026-12-22T00:00:00Z" }] };
    const cal = calendarFromForm(form, current);
    expect(cal.closedPeriods).toHaveLength(1);
    expect(formFromCalendar(cal)).toEqual({ ...form, closedDates: [...form.closedDates].sort() });
  });
  it("falls back to the store defaults when nothing is configured", () => {
    expect(formFromCalendar(undefined)).toEqual(DEFAULT_BUSINESS_HOURS_FORM);
  });
  it("dedupes and sorts holidays", () => {
    expect(calendarFromForm({ ...form, closedDates: ["2026-12-25", "2026-11-02", "2026-12-25"] }).closedDates).toEqual(["2026-11-02", "2026-12-25"]);
  });
  it("validates times, order and dates", () => {
    expect(validateBusinessHoursForm(form)).toBeNull();
    expect(validateBusinessHoursForm({ ...form, weekdayStart: "19:00" })).toMatch(/antes do fechamento/);
    expect(validateBusinessHoursForm({ ...form, saturdayStart: "8h" })).toMatch(/inválido/);
    expect(validateBusinessHoursForm({ ...form, saturdayOpen: false, saturdayStart: "xx" })).toBeNull();
    expect(validateBusinessHoursForm({ ...form, closedDates: ["2026-02-30"] })).toMatch(/data de feriado/);
  });
});
