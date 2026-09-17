// Centralized pt-BR text normalization for TTS (ElevenLabs) — the only
// place text destined for voice synthesis should be transformed. The
// customer-facing text (WhatsApp message content, dashboard, logs) is a
// completely separate string and is never touched by anything in this
// file: callers pass a `texto_original`, get back a `texto_tts`, and
// nothing here ever mutates or returns the input unchanged-but-shared.
//
// Pipeline order matters — each stage assumes the ones before it have
// already run:
//   1. dates (must run before currency, since both use digits+punctuation)
//   2. installments ("Nx" — must run before currency, since "72x R$ 567,94"
//      needs the word "de" inserted between the installment count and the
//      still-untouched "R$ 567,94" that currency conversion handles next)
//   3. currency (R$ ..., decimal or rounded to mil/milhão, always spelled
//      out in full — ElevenLabs' native digit reading is inconsistent
//      enough on real production text that "leave it as digits" is no
//      longer the rule; see audio-generation.test.ts history)
//   4. "/mês" suffix cleanup (currency conversion above stops at the "/",
//      leaving a dangling "/mês" or "/mes" to turn into " por mês")
//   5. percentages (decimal read digit-by-digit after "vírgula", then
//      plain integer percentages)
//   6. distance units (km, km/h — including the very common "0km" ==
//      "zero quilômetros" marketing shorthand for a brand-new vehicle)
//   7. pronunciation dictionary (brand/model names ElevenLabs' Portuguese
//      model reads as ordinary words — e.g. "Fazer" as the verb "to do"
//      instead of the Yamaha model, spoken "féizer")
//   8. whitespace cleanup (collapses any double spaces the substitutions
//      above introduced)

const UNITS = [
  "zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove",
  "dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove",
];
const UNITS_FEMININE = [...UNITS];
UNITS_FEMININE[1] = "uma";
UNITS_FEMININE[2] = "duas";

const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];

const HUNDREDS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
const HUNDREDS_FEMININE = ["", "cento", "duzentas", "trezentas", "quatrocentas", "quinhentas", "seiscentas", "setecentas", "oitocentas", "novecentas"];

const MONTH_NAMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

// 0-999 in words. `feminine` swaps um/dois and the -entos hundreds for
// their -uma/-duas/-entas forms, needed for "N parcelas" ("uma parcela",
// "vinte e duas parcelas") since "parcela" is a feminine noun.
function hundredsToWords(n: number, feminine: boolean): string {
  if (n === 100) return "cem";
  const units = feminine ? UNITS_FEMININE : UNITS;
  const hundreds = feminine ? HUNDREDS_FEMININE : HUNDREDS;

  const h = Math.floor(n / 100);
  const rem = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(hundreds[h]);
  if (rem > 0) {
    if (rem < 20) {
      parts.push(units[rem]);
    } else {
      const t = Math.floor(rem / 10);
      const u = rem % 10;
      parts.push(u > 0 ? `${TENS[t]} e ${units[u]}` : TENS[t]);
    }
  }
  return parts.join(" e ");
}

const SCALE_SINGULAR = ["", "mil", "milhão", "bilhão"];
const SCALE_PLURAL = ["", "mil", "milhões", "bilhões"];

// Full cardinal number, any non-negative integer up to low billions
// (comfortably covers every credit/price/group value seen in this
// business — consórcio credit ranges top out around R$1.000.000).
// `feminine` propagates into every 3-digit group, needed for the "N
// parcelas" case where the whole number (not just the final digit) must
// agree in gender: "duzentas parcelas", not "duzentos parcelas".
export function numberToWordsPtBr(n: number, feminine = false): string {
  if (n === 0) return "zero";

  const groups: number[] = [];
  let rest = Math.trunc(n);
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.trunc(rest / 1000);
  }

  const nonZeroIndices = groups.reduce<number[]>((acc, g, i) => (g > 0 ? [...acc, i] : acc), []);
  const lastGroupIndex = Math.min(...nonZeroIndices);

  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;

    if (i === 0) {
      parts.push(hundredsToWords(g, feminine));
    } else if (g === 1) {
      // "mil" not "um mil"; "um milhão" (million/billion keep "um")
      parts.push(i === 1 ? "mil" : `um ${SCALE_SINGULAR[i]}`);
    } else {
      parts.push(`${hundredsToWords(g, feminine)} ${SCALE_PLURAL[i]}`);
    }
  }

  if (parts.length === 1) return parts[0];

  // "e" joins the final group to the rest only when that final group is
  // itself under 100 (e.g. "mil e sessenta"); a final group of 100+
  // already reads naturally as its own phrase ("mil duzentos e cinquenta").
  const useEJoin = groups[lastGroupIndex] < 100;
  const head = parts.slice(0, -1).join(" ");
  const tail = parts[parts.length - 1];
  return `${head}${useEJoin ? " e " : " "}${tail}`;
}

const DIGIT_WORDS = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];

function convertDates(text: string): string {
  return text.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_match, day: string, month: string, year: string) => {
    const monthIndex = Number(month) - 1;
    if (monthIndex < 0 || monthIndex > 11) return _match; // not a real month, leave untouched
    const dayWords = numberToWordsPtBr(Number(day));
    const yearWords = numberToWordsPtBr(Number(year));
    return `${dayWords} de ${MONTH_NAMES[monthIndex]} de ${yearWords}`;
  });
}

// Real production case: "12x R$ 943,00" (no "de") must read the same as
// "12x de R$ 943,00" — always inserting "de" between the spelled-out
// installment count and the currency amount that currency conversion
// (run right after this stage) will handle. Only matches when directly
// followed by "R$", so a bare "12x" elsewhere in the text is left alone.
function convertInstallments(text: string): string {
  return text.replace(/\b(\d+)x\s*(?:de\s+)?(?=R\$)/gi, (_match, count: string) => {
    const n = Number(count);
    const words = numberToWordsPtBr(n, true);
    const noun = n === 1 ? "parcela" : "parcelas";
    return `${words} ${noun} de `;
  });
}

// R$ amounts, decimal ("R$ 371,83") or rounded to mil/milhão ("R$ 120
// mil"), always spelled out in full — including plain amounts like
// "R$ 25.900" that ElevenLabs can mostly read as digits, since "mostly"
// isn't good enough for prices customers are deciding on.
const CURRENCY_PATTERN = /R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?(?:\s*(milhões|milhão|mil))?/gi;

function convertCurrency(text: string): string {
  return text.replace(CURRENCY_PATTERN, (_match, intPart: string, cents: string | undefined, scale: string | undefined) => {
    let reais = parseInt(intPart.replace(/\./g, ""), 10);
    if (scale) {
      reais *= /^milh/i.test(scale) ? 1_000_000 : 1_000;
    }
    const centavos = cents ? parseInt(cents, 10) : 0;

    const parts: string[] = [];
    if (reais > 0) {
      parts.push(`${numberToWordsPtBr(reais)} ${reais === 1 ? "real" : "reais"}`);
    }
    if (centavos > 0) {
      parts.push(`${numberToWordsPtBr(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`);
    }
    return parts.length > 0 ? parts.join(" e ") : "zero reais";
  });
}

function convertMonthlySuffix(text: string): string {
  return text.replace(/\/m[eê]s\b/gi, " por mês");
}

function convertPercentages(text: string): string {
  let result = text;
  // Decimal first ("1,5%") so the plain-integer pass below never sees a
  // dangling "5%" left over from a partial match.
  result = result.replace(/\b(\d+),(\d+)\s*%/g, (_match, intPart: string, decPart: string) => {
    const intWords = numberToWordsPtBr(Number(intPart));
    const decWords = decPart
      .split("")
      .map((d: string) => DIGIT_WORDS[Number(d)])
      .join(" ");
    return `${intWords} vírgula ${decWords} por cento`;
  });
  result = result.replace(/\b(\d+)\s*%/g, (_match, n: string) => `${numberToWordsPtBr(Number(n))} por cento`);
  return result;
}

function convertDistanceUnits(text: string): string {
  let result = text;
  result = result.replace(/(\d[\d.]*)\s*km\/h\b/gi, (_match, n: string) => `${numberToWordsPtBr(parseInt(n.replace(/\./g, ""), 10))} quilômetros por hora`);
  result = result.replace(/\b(\d[\d.]*)\s*km\b/gi, (_match, n: string) => `${numberToWordsPtBr(parseInt(n.replace(/\./g, ""), 10))} quilômetros`);
  return result;
}

// Extensible: add entries here to fix any other brand/model name
// ElevenLabs' Portuguese model mispronounces. Customer-facing text never
// sees these — only the TTS call does.
const PRONUNCIAS_TTS: Record<string, string> = {
  Fazer: "Fêizer",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyPronunciationDictionary(text: string): string {
  return Object.entries(PRONUNCIAS_TTS).reduce(
    (acc, [word, replacement]) => acc.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, "g"), replacement),
    text
  );
}

function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

export function normalizeTextForTts(text: string): string {
  let result = text;
  result = convertDates(result);
  result = convertInstallments(result);
  result = convertCurrency(result);
  result = convertMonthlySuffix(result);
  result = convertPercentages(result);
  result = convertDistanceUnits(result);
  result = applyPronunciationDictionary(result);
  result = normalizeWhitespace(result);
  return result;
}
