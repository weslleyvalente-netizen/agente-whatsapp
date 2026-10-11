const repairs: Record<string, string> = {"√°": "á", "Ã¡": "á", "√†": "à", "Ã ": "à", "√¢": "â", "Ã¢": "â", "√£": "ã", "Ã£": "ã", "√§": "ä", "Ã¤": "ä", "√©": "é", "Ã©": "é", "√™": "ê", "Ãª": "ê", "√´": "ë", "Ã«": "ë", "√≠": "í", "Ã­": "í", "√Ø": "ï", "Ã¯": "ï", "√≥": "ó", "Ã³": "ó", "√¥": "ô", "Ã´": "ô", "√µ": "õ", "Ãµ": "õ", "√∂": "ö", "Ã¶": "ö", "√∫": "ú", "Ãº": "ú", "√º": "ü", "Ã¼": "ü", "√ß": "ç", "Ã§": "ç", "√Å": "Á", "Ã": "Á", "√Ä": "À", "Ã": "À", "Ã€": "À", "√Ç": "Â", "Ã": "Â", "Ã‚": "Â", "√É": "Ã", "Ã": "Ã", "Ãƒ": "Ã", "√Ñ": "Ä", "Ã": "Ä", "Ã„": "Ä", "√â": "É", "Ã": "É", "Ã‰": "É", "√ä": "Ê", "Ã": "Ê", "ÃŠ": "Ê", "√ã": "Ë", "Ã": "Ë", "Ã‹": "Ë", "√ç": "Í", "Ã": "Í", "√è": "Ï", "Ã": "Ï", "√ì": "Ó", "Ã": "Ó", "Ã“": "Ó", "√î": "Ô", "Ã": "Ô", "Ã”": "Ô", "√ï": "Õ", "Ã": "Õ", "Ã•": "Õ", "√ñ": "Ö", "Ã": "Ö", "Ã–": "Ö", "√ö": "Ú", "Ã": "Ú", "Ãš": "Ú", "√ú": "Ü", "Ã": "Ü", "Ãœ": "Ü", "√á": "Ç", "Ã": "Ç", "Ã‡": "Ç"};

/** Repair known UTF-8 decoding artifacts without rewriting stored customer data. */
export function displayText(value: string | null | undefined): string {
 let result = value ?? "";
 for (let pass = 0; pass < 2; pass++) {
  for (const [broken, correct] of Object.entries(repairs)) result = result.split(broken).join(correct);
 }
 return result;
}

export function distinctDisplayTexts(values: Array<string | null | undefined>): string[] {
 const seen = new Set<string>();
 return values.map(displayText).filter(text => {
  const key = text.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
  if (!key || seen.has(key)) return false;
  seen.add(key); return true;
 });
}
