const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

export function formatDateTimeForPrompt(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function toISODateInTimeZone(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// startHour inclusive, endHour exclusive — [8, 18) means 08:00 through
// 17:59 count as "within", 18:00 does not. Used to gate automatic
// follow-up sends to business hours (see stale-conversation-followup.ts);
// skipping a tick outside the window never loses the follow-up — it's
// re-evaluated from scratch on the next 15-minute tick.
export function isWithinBusinessHours(
  date: Date,
  startHour: number,
  endHour: number,
  timeZone: string = DEFAULT_TIME_ZONE
): boolean {
  const localHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(date)
  );
  // "24" shows up for midnight in some ICU builds with hour12: false instead of "0".
  const normalizedHour = localHour === 24 ? 0 : localHour;
  return normalizedHour >= startHour && normalizedHour < endHour;
}
