import type { OrganizationSettings } from "./types/organization.js";

export interface GreetingFilterConfig {
  enabled: boolean;
  words: string[];
  maxLength: number;
}

// Off by default: a fresh org (or an org that hasn't visited Configurações
// yet) must see zero behavior change from this feature until they opt in —
// deploy-safety requirement so Fase 1 can merge with everything inert and
// be turned on one org/feature at a time.
export const DEFAULT_GREETING_FILTER_ENABLED = false;

export const DEFAULT_GREETING_WORDS = [
  "bom dia",
  "boa tarde",
  "boa noite",
  "oi",
  "oii",
  "oie",
  "ola",
  "olá",
  "ok",
  "blz",
  "beleza",
  "opa",
  "bom dia tudo bem",
  "boa tarde tudo bem",
  "boa noite tudo bem",
  "oi tudo bem",
  "olá tudo bem",
];

// Must cover the longest default word above ("boa tarde tudo bem" / "boa
// noite tudo bem", 18 chars) with a little headroom for org-configured
// variants. Checked against the NORMALIZED message (punctuation/emoji
// already stripped), not the raw content — see isGreetingOrShortConfirmation.
export const DEFAULT_GREETING_MAX_LENGTH = 22;

export const DEFAULT_GREETING_FILTER_CONFIG: GreetingFilterConfig = {
  enabled: DEFAULT_GREETING_FILTER_ENABLED,
  words: DEFAULT_GREETING_WORDS,
  maxLength: DEFAULT_GREETING_MAX_LENGTH,
};

// Orgs that haven't configured any of this fall back to the defaults above —
// same pattern as human_takeover_timeout_minutes.
export function resolveGreetingFilterConfig(
  settings: Pick<
    OrganizationSettings,
    "takeover_greeting_filter_enabled" | "takeover_greeting_words" | "takeover_greeting_max_length"
  > | undefined
): GreetingFilterConfig {
  return {
    enabled: settings?.takeover_greeting_filter_enabled ?? DEFAULT_GREETING_FILTER_ENABLED,
    words: settings?.takeover_greeting_words ?? DEFAULT_GREETING_WORDS,
    maxLength: settings?.takeover_greeting_max_length ?? DEFAULT_GREETING_MAX_LENGTH,
  };
}

// Emoji ranges + variation selector/ZWJ, same set used across the codebase
// for "is this message just an emoji" checks.
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️‍]/gu;

// Punctuation a human commonly types around/inside a short greeting
// ("Bom dia!", "Oi, tudo bem?") — stripped anywhere in the string, not just
// at the edges, since removing it never changes which word was meant.
const PUNCTUATION_PATTERN = /[.,!?;:()"'`\-–—~*_]/g;

// Case, accents, punctuation and emoji all collapse away before comparison —
// "Bom dia!", "bom dia 😊" and "bom dia" must all normalize to the exact
// same string as the configured word "bom dia".
function normalize(text: string): string {
  const noEmoji = text.replace(EMOJI_PATTERN, "");
  const deaccented = noEmoji.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const noPunctuation = deaccented.replace(PUNCTUATION_PATTERN, "");
  return noPunctuation.toLowerCase().replace(/\s+/g, " ").trim();
}

function isOnlyEmoji(text: string): boolean {
  const stripped = text.replace(EMOJI_PATTERN, "").replace(/\s/g, "");
  return stripped.length === 0 && text.trim().length > 0;
}

// A fromMe message counts as "só saudação ou confirmação curta" only when it
// is EXACTLY one of the configured words (or pure emoji) — never a plain
// length check. Fase 0 found fixed short tokens in production ("8121", an
// attendant's own name) that are not greetings at all; matching by length
// alone would silently swallow those, plus genuine short replies like "sim"
// or "manda", along with real greetings. maxLength is an extra sanity cap on
// the matched word (checked on the NORMALIZED string, so decorative
// punctuation/emoji around a short greeting never inflates it past the
// cap), not an independent trigger.
export function isGreetingOrShortConfirmation(content: string, config: GreetingFilterConfig): boolean {
  if (!config.enabled) return false;

  const trimmed = content.trim();
  if (trimmed.length === 0) return false;

  if (isOnlyEmoji(trimmed)) return true;

  const normalized = normalize(trimmed);
  if (normalized.length === 0 || normalized.length > config.maxLength) return false;

  return config.words.some((word) => normalize(word) === normalized);
}
