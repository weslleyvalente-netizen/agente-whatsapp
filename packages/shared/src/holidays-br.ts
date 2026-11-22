// Feriados para o calendário comercial. Funções puras (sem relógio global).
// Conjunto "posse_go" (Moto e Trilha, Posse/GO), conferido em 22/11/2026:
//   - Nacionais (Lei 662/1949 e alterações; 20/11 pela Lei 14.759/2023); Sexta-feira Santa é móvel (Páscoa - 2 dias).
//   - Goiás: 26/07, Fundação da Cidade de Goiás (Lei estadual 9.314/1983). Transferências por decreto (ex.: 2026 -> 20/07,
//     Decreto 10.935/2026) entram pela configuração `extra_holidays`/`open_days`.
//   - Posse: 19/07 Aniversário e 26/07 Padroeira N. Sra. Sant'Ana (Lei municipal 110/1985); 19/10 Monsenhor (Lei 1.283/2020).
//   - Fora de propósito: pontos facultativos (Carnaval, Corpus Christi, vésperas) e o Dia do Servidor Público (28/10, só serviço
//     público). 30/05 (citado por um único site, sem lei) também fica fora até confirmação.

export interface Holiday { date: string; name: string }

const pad = (n: number) => String(n).padStart(2, "0");

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano). */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function goodFriday(year: number): string {
  const { month, day } = easterSunday(year);
  const t = Date.UTC(year, month - 1, day) - 2 * 86_400_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const FIXED: Array<[number, number, string]> = [
  [1, 1, "Confraternização Universal"],
  [4, 21, "Tiradentes"],
  [5, 1, "Dia do Trabalho"],
  [7, 19, "Aniversário de Posse"],
  [7, 26, "Padroeira N. Sra. Sant'Ana (Posse) e Fundação da Cidade de Goiás (GO)"],
  [9, 7, "Independência do Brasil"],
  [10, 12, "Nossa Senhora Aparecida"],
  [10, 19, "Dia do Monsenhor (Posse)"],
  [11, 2, "Finados"],
  [11, 15, "Proclamação da República"],
  [11, 20, "Dia Nacional de Zumbi e da Consciência Negra"],
  [12, 25, "Natal"],
];

/** Feriados de Posse/GO no ano (nacionais + Goiás + municipais), em ordem de data, sem repetição. */
export function posseGoHolidays(year: number): Holiday[] {
  const list: Holiday[] = FIXED.map(([m, d, name]) => ({ date: `${year}-${pad(m)}-${pad(d)}`, name }));
  list.push({ date: goodFriday(year), name: "Sexta-feira Santa" });
  const seen = new Set<string>();
  return list.sort((a, b) => a.date.localeCompare(b.date)).filter((h) => (seen.has(h.date) ? false : (seen.add(h.date), true)));
}

export const HOLIDAY_SETS = { posse_go: posseGoHolidays } as const;
export type HolidaySet = keyof typeof HOLIDAY_SETS;

/** Anos cobertos pela expansão do calendário (sem relógio: faixa fixa e larga). */
export const HOLIDAY_YEARS = { from: 2024, to: 2040 } as const;
