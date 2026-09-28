import type { OrganizationSettings } from "./types/organization.js";

export interface GreetingFilterConfig {
  enabled: boolean;
  words: string[];
  maxLength: number;
}

export const DEFAULT_GREETING_FILTER_ENABLED = true;

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
];

export const DEFAULT_GREETING_MAX_LENGTH = 15;

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

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Emoji ranges + variation selector/ZWJ, same set used across the codebase
// for "is this message just an emoji" checks.
function isOnlyEmoji(text: string): boolean {
  const stripped = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️‍\s]/gu, "");
  return stripped.length === 0 && text.trim().length > 0;
}

// A fromMe message counts as "só saudação ou confirmação curta" only when it
// is EXACTLY one of the configured words (or pure emoji) — never a plain
// length check. Fase 0 found fixed short tokens in production ("8121", an
// attendant's own name) that are not greetings at all; matching by length
// alone would silently swallow those, plus genuine short replies like "sim"
// or "manda", along with real greetings. maxLength is an extra sanity cap on
// the matched word, not an independent trigger.
export function isGreetingOrShortConfirmation(content: string, config: GreetingFilterConfig): boolean {
  if (!config.enabled) return false;

  const trimmed = content.trim();
  if (trimmed.length === 0) return false;

  if (isOnlyEmoji(trimmed)) return true;

  if (trimmed.length > config.maxLength) return false;

  const normalized = normalize(trimmed);
  return config.words.some((word) => normalize(word) === normalized);
}
