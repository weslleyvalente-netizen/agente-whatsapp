// Edição do calendário comercial pela tela de Configurações: formulário simples <-> BusinessCalendar.
import { resolveBusinessCalendar, type BusinessCalendar } from "./business-calendar.js";

export interface BusinessHoursForm {
  weekdayStart: string; weekdayEnd: string;
  saturdayOpen: boolean; saturdayStart: string; saturdayEnd: string;
  closedDates: string[]; // "YYYY-MM-DD"
}

export const DEFAULT_BUSINESS_HOURS_FORM: BusinessHoursForm = {
  weekdayStart: "07:30", weekdayEnd: "18:00", saturdayOpen: true, saturdayStart: "08:00", saturdayEnd: "12:00", closedDates: [],
};

// Feriados nacionais (fechamento da loja) de nov/2026 a jan/2027.
export const NATIONAL_HOLIDAYS_2026_2027 = ["2026-11-02", "2026-11-20", "2026-12-25", "2027-01-01"];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export function validateBusinessHoursForm(f: BusinessHoursForm): string | null {
  const range = (a: string, b: string, label: string) => !HHMM.test(a) || !HHMM.test(b) ? `Horário de ${label} inválido (use HH:MM).` : a >= b ? `${label}: a abertura deve ser antes do fechamento.` : null;
  return range(f.weekdayStart, f.weekdayEnd, "segunda a sexta")
    ?? (f.saturdayOpen ? range(f.saturdayStart, f.saturdayEnd, "sábado") : null)
    ?? (f.closedDates.every(isoDate) ? null : "Há uma data de feriado inválida.");
}

/** Monta o calendário; mantém fuso e períodos fechados do calendário atual (`current`). */
export function calendarFromForm(f: BusinessHoursForm, current?: unknown): BusinessCalendar {
  const base = resolveBusinessCalendar(current);
  const weekday = [{ start: f.weekdayStart, end: f.weekdayEnd }];
  const weekly: BusinessCalendar["weekly"] = { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday };
  if (f.saturdayOpen) weekly.sat = [{ start: f.saturdayStart, end: f.saturdayEnd }];
  const closedDates = [...new Set(f.closedDates)].sort();
  return { timeZone: base.timeZone, weekly, closedDates, closedPeriods: base.closedPeriods ?? [] };
}

/** Lê o calendário salvo para o formulário. Só a primeira janela de segunda e de sábado é representada. */
export function formFromCalendar(raw: unknown): BusinessHoursForm {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_BUSINESS_HOURS_FORM, closedDates: [] };
  const cal = resolveBusinessCalendar(raw);
  const mon = cal.weekly.mon?.[0]; const sat = cal.weekly.sat?.[0];
  return {
    weekdayStart: mon?.start ?? DEFAULT_BUSINESS_HOURS_FORM.weekdayStart, weekdayEnd: mon?.end ?? DEFAULT_BUSINESS_HOURS_FORM.weekdayEnd,
    saturdayOpen: !!sat, saturdayStart: sat?.start ?? DEFAULT_BUSINESS_HOURS_FORM.saturdayStart, saturdayEnd: sat?.end ?? DEFAULT_BUSINESS_HOURS_FORM.saturdayEnd,
    closedDates: [...(cal.closedDates ?? [])].sort(),
  };
}
