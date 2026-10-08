// Calendário comercial para prazos em "minutos úteis". Funções puras: nada de relógio global.
export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export interface BusinessWindow { start: string; end: string } // "HH:MM", fim exclusivo
export interface BusinessCalendar {
  timeZone: string;
  weekly: Partial<Record<Weekday, BusinessWindow[]>>;
  closedDates?: string[]; // "YYYY-MM-DD" no fuso do calendário
  closedPeriods?: Array<{ from: string; to: string; reason?: string }>; // instantes ISO, [from, to)
}

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MS = 86_400_000;
const MAX_DAYS = 370;
const WORKDAY: BusinessWindow[] = [{ start: "08:00", end: "18:00" }];

export const DEFAULT_BUSINESS_CALENDAR: BusinessCalendar = {
  timeZone: "America/Sao_Paulo",
  weekly: { mon: WORKDAY, tue: WORKDAY, wed: WORKDAY, thu: WORKDAY, fri: WORKDAY },
  closedDates: [],
  closedPeriods: [],
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(t: number, timeZone: string) {
  const p: Record<string, string> = {};
  for (const x of formatter(timeZone).formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: WEEKDAYS[["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(p.weekday.toLowerCase().slice(0, 3))] };
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (y: number, mo: number, d: number) => `${y}-${pad(mo)}-${pad(d)}`;
const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

// Instante em que o relógio local do fuso marca y-mo-d h:mi.
function zonedToInstant(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, timeZone);
    guess += wanted - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return guess;
}

function closedPeriodAt(t: number, cal: BusinessCalendar) {
  return (cal.closedPeriods ?? []).map(p => ({ from: Date.parse(p.from), to: Date.parse(p.to) }))
    .find(p => Number.isFinite(p.from) && Number.isFinite(p.to) && p.from <= t && t < p.to) ?? null;
}

function nextClosedPeriodStart(t: number, cal: BusinessCalendar): number {
  return (cal.closedPeriods ?? []).map(p => Date.parse(p.from)).filter(f => Number.isFinite(f) && f > t).sort((a, b) => a - b)[0] ?? Infinity;
}

// Fim da janela aberta que contém t, ou null se t está fora do expediente.
function openUntil(t: number, cal: BusinessCalendar): number | null {
  const p = parts(t, cal.timeZone);
  if ((cal.closedDates ?? []).includes(isoDay(p.y, p.mo, p.d))) return null;
  const now = p.h * 60 + p.mi;
  for (const w of cal.weekly[p.wd] ?? []) {
    if (minutesOf(w.start) <= now && now < minutesOf(w.end)) {
      const end = minutesOf(w.end);
      return zonedToInstant(p.y, p.mo, p.d, Math.floor(end / 60), end % 60, cal.timeZone);
    }
  }
  return null;
}

// Próxima abertura estritamente depois de t (ignora períodos fechados; o laço principal os trata).
function nextOpening(t: number, cal: BusinessCalendar): number | null {
  const p = parts(t, cal.timeZone);
  const base = Date.UTC(p.y, p.mo - 1, p.d);
  for (let offset = 0; offset <= MAX_DAYS; offset++) {
    const day = new Date(base + offset * DAY_MS);
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();
    if ((cal.closedDates ?? []).includes(isoDay(y, mo, d))) continue;
    const windows = [...(cal.weekly[WEEKDAYS[day.getUTCDay()]] ?? [])].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    for (const w of windows) {
      const s = minutesOf(w.start);
      const instant = zonedToInstant(y, mo, d, Math.floor(s / 60), s % 60, cal.timeZone);
      if (instant > t) return instant;
    }
  }
  return null;
}

export function isBusinessOpen(date: Date, calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR): boolean {
  const t = date.getTime();
  return closedPeriodAt(t, calendar) === null && openUntil(t, calendar) !== null;
}

export function addBusinessMinutes(start: Date, minutes: number, calendar: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR): Date {
  let remaining = Math.max(0, minutes);
  let t = start.getTime();
  if (remaining === 0) return new Date(t);
  for (let guard = 0; guard < 20_000; guard++) {
    const period = closedPeriodAt(t, calendar);
    if (period) { t = period.to; continue; }
    const end = openUntil(t, calendar);
    if (end === null) {
      const next = nextOpening(t, calendar);
      if (next === null) throw new Error("Calendário comercial sem janelas abertas.");
      t = next;
      continue;
    }
    const segmentEnd = Math.min(end, nextClosedPeriodStart(t, calendar));
    const available = (segmentEnd - t) / 60_000;
    if (remaining <= available) return new Date(t + remaining * 60_000);
    remaining -= available;
    t = segmentEnd;
  }
  throw new Error("Calendário comercial sem janelas abertas.");
}

function validWindow(w: unknown): w is BusinessWindow {
  if (!w || typeof w !== "object") return false;
  const { start, end } = w as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  return ok(start) && ok(end) && minutesOf(start as string) < minutesOf(end as string);
}

/** Aceita a configuração crua da organização; qualquer problema devolve o calendário padrão (nunca derruba a distribuição). */
export function resolveBusinessCalendar(raw: unknown): BusinessCalendar {
  if (!raw || typeof raw !== "object") return DEFAULT_BUSINESS_CALENDAR;
  const r = raw as Record<string, any>;
  const timeZone = typeof r.timeZone === "string" ? r.timeZone : DEFAULT_BUSINESS_CALENDAR.timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { return DEFAULT_BUSINESS_CALENDAR; }
  const weekly: BusinessCalendar["weekly"] = {};
  for (const day of WEEKDAYS) {
    const list = r.weekly?.[day];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every(validWindow)) return DEFAULT_BUSINESS_CALENDAR;
    if (list.length) weekly[day] = list;
  }
  if (!Object.keys(weekly).length) return DEFAULT_BUSINESS_CALENDAR;
  const closedDates = Array.isArray(r.closedDates) ? r.closedDates.filter((d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  const closedPeriods = Array.isArray(r.closedPeriods)
    ? r.closedPeriods.filter((p: any) => p && Number.isFinite(Date.parse(p.from)) && Number.isFinite(Date.parse(p.to)) && Date.parse(p.from) < Date.parse(p.to))
    : [];
  return { timeZone, weekly, closedDates, closedPeriods };
}
