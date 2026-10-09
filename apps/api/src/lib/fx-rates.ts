// Cotação do dólar (PTAX de fechamento, Banco Central) por dia. Valores de dias passados não mudam, então ficam em cache de memória.
export type RateMap = Map<string, number>; // 'YYYY-MM-DD' -> BRL por 1 USD (só dias úteis)

const BCB = "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)";
const cache: RateMap = new Map();
let fetchedUntil = ""; // fim do último intervalo buscado
let fetchedFrom = "9999-12-31";
let lastAttemptAt = 0;
const RETRY_MS = 10 * 60 * 1000;

const toBcbDate = (iso: string) => `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}`;

/** Extrai a PTAX de fechamento por dia (CotacaoDolarPeriodo já devolve só o fechamento, uma linha por dia útil). */
export function parsePtax(payload: { value?: Array<{ cotacaoVenda: number; dataHoraCotacao: string }> }): RateMap {
  const out: RateMap = new Map();
  for (const row of payload.value ?? []) {
    if (!(row.cotacaoVenda > 0)) continue;
    out.set(row.dataHoraCotacao.slice(0, 10), row.cotacaoVenda);
  }
  return out;
}

/** Cotação válida em `date`: a do próprio dia ou, em fim de semana/feriado/dia sem boletim, a última anterior. */
export function rateOnOrBefore(rates: RateMap, date: string): { rate: number; rateDate: string } | null {
  let best: string | null = null;
  for (const d of rates.keys()) if (d <= date && (best === null || d > best)) best = d;
  return best ? { rate: rates.get(best)!, rateDate: best } : null;
}

/** Cotações de [startDate, endDate] com margem de 10 dias antes (para cobrir fins de semana/feriados). Falha do BCB devolve o que há em cache. */
export async function getUsdBrlRates(startDate: string, endDate: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<RateMap> {
  const from = new Date(new Date(`${startDate}T00:00:00Z`).getTime() - 10 * 86400000).toISOString().slice(0, 10);
  const covered = from >= fetchedFrom && endDate <= fetchedUntil && endDate < new Date(now).toISOString().slice(0, 10);
  if (!covered && now - lastAttemptAt >= RETRY_MS) {
    lastAttemptAt = now;
    try {
      const url = `${BCB}?@dataInicial='${toBcbDate(from)}'&@dataFinalCotacao='${toBcbDate(endDate)}'&$format=json&$top=10000`;
      const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        for (const [d, r] of parsePtax(await res.json() as any)) cache.set(d, r);
        fetchedFrom = from < fetchedFrom ? from : fetchedFrom;
        fetchedUntil = endDate > fetchedUntil ? endDate : fetchedUntil;
      }
    } catch { /* sem cotação: a tela mostra só dólar */ }
  }
  return new Map(cache);
}

export function resetFxCacheForTests() { cache.clear(); fetchedUntil = ""; fetchedFrom = "9999-12-31"; lastAttemptAt = 0; }
