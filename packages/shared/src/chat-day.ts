const TZ = "America/Sao_Paulo";

/** Dia (YYYY-MM-DD) em Brasília de um instante ISO. */
export function chatDayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

const WEEKDAYS = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];

/** Rótulo do separador de dia, como no WhatsApp: Hoje, Ontem, dia da semana (até 6 dias atrás) ou data completa. */
export function chatDayLabel(iso: string, nowIso: string): string {
  const day = chatDayKey(iso);
  const today = chatDayKey(nowIso);
  const diff = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000);
  if (diff <= 0) return "Hoje";
  if (diff === 1) return "Ontem";
  if (diff < 7) return WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}
