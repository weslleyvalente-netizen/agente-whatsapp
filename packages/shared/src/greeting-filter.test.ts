import { describe, it, expect } from "vitest";
import {
  isGreetingOrShortConfirmation,
  resolveGreetingFilterConfig,
  DEFAULT_GREETING_FILTER_CONFIG,
} from "./greeting-filter.js";

// The matching-logic tests below exercise the filter as ON — DEFAULT_GREETING_FILTER_CONFIG
// itself ships disabled (see the dedicated test further down), by design for a safe rollout:
// merging Fase 1 must not change any org's behavior until they flip it on in Configurações.
const ENABLED_CONFIG = { ...DEFAULT_GREETING_FILTER_CONFIG, enabled: true };

describe("isGreetingOrShortConfirmation", () => {
  it("ships disabled by default, for a safe rollout (orgs opt in from Configurações)", () => {
    expect(DEFAULT_GREETING_FILTER_CONFIG.enabled).toBe(false);
    expect(isGreetingOrShortConfirmation("Bom dia", DEFAULT_GREETING_FILTER_CONFIG)).toBe(false);
  });

  it("matches a bare greeting word from the default list", () => {
    expect(isGreetingOrShortConfirmation("Bom dia", ENABLED_CONFIG)).toBe(true);
    expect(isGreetingOrShortConfirmation("boa tarde", ENABLED_CONFIG)).toBe(true);
    expect(isGreetingOrShortConfirmation("oi", ENABLED_CONFIG)).toBe(true);
  });

  it("is case- and accent-insensitive", () => {
    expect(isGreetingOrShortConfirmation("OLÁ", ENABLED_CONFIG)).toBe(true);
    expect(isGreetingOrShortConfirmation("Ola", ENABLED_CONFIG)).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(isGreetingOrShortConfirmation("  bom dia  ", ENABLED_CONFIG)).toBe(true);
  });

  it("matches a message that is only emoji, regardless of the word list", () => {
    expect(isGreetingOrShortConfirmation("👍", ENABLED_CONFIG)).toBe(true);
    expect(isGreetingOrShortConfirmation("😊🙏", ENABLED_CONFIG)).toBe(true);
  });

  // This is the case that matters most: real production data (Fase 0) shows
  // fixed short tokens ("8121", an attendant's own name) that are NOT
  // greetings — a bare length check would wrongly swallow these along with
  // genuine short replies like "sim" or "manda". Only an exact match against
  // the configured word list (or pure emoji) may filter.
  it("does NOT match a short message that isn't a configured greeting word", () => {
    expect(isGreetingOrShortConfirmation("8121", ENABLED_CONFIG)).toBe(false);
    expect(isGreetingOrShortConfirmation("marina", ENABLED_CONFIG)).toBe(false);
    expect(isGreetingOrShortConfirmation("sim", ENABLED_CONFIG)).toBe(false);
    expect(isGreetingOrShortConfirmation("manda", ENABLED_CONFIG)).toBe(false);
  });

  it("does NOT match a real sentence that merely starts with a greeting word", () => {
    expect(
      isGreetingOrShortConfirmation("Bom dia, vamos prosseguir com a compra", ENABLED_CONFIG)
    ).toBe(false);
  });

  it("respects the configured max length even for a listed word", () => {
    const strict = { ...ENABLED_CONFIG, maxLength: 5 };
    expect(isGreetingOrShortConfirmation("boa noite", strict)).toBe(false); // 9 chars, over the cap
    expect(isGreetingOrShortConfirmation("oi", strict)).toBe(true);
  });

  it("respects a custom word list", () => {
    const custom = { ...ENABLED_CONFIG, words: ["eae"] };
    expect(isGreetingOrShortConfirmation("eae", custom)).toBe(true);
    expect(isGreetingOrShortConfirmation("oi", custom)).toBe(false);
  });

  it("never matches anything when the filter is disabled for the organization", () => {
    const disabled = { ...ENABLED_CONFIG, enabled: false };
    expect(isGreetingOrShortConfirmation("Bom dia", disabled)).toBe(false);
    expect(isGreetingOrShortConfirmation("👍", disabled)).toBe(false);
  });

  it("does not match empty content", () => {
    expect(isGreetingOrShortConfirmation("", ENABLED_CONFIG)).toBe(false);
    expect(isGreetingOrShortConfirmation("   ", ENABLED_CONFIG)).toBe(false);
  });

  // Real WhatsApp punctuation/emoji habits — a human typing "Bom dia!" or
  // "bom dia 😊" means the exact same thing as a bare "bom dia" and must
  // still be filtered; only the exact word itself decides the match, edge
  // punctuation/emoji/case/accent must never block it.
  describe("normalizes case, accents, edge punctuation and edge emoji", () => {
    it("matches with trailing punctuation", () => {
      expect(isGreetingOrShortConfirmation("Bom dia!", ENABLED_CONFIG)).toBe(true);
      expect(isGreetingOrShortConfirmation("Boa tarde.", ENABLED_CONFIG)).toBe(true);
      expect(isGreetingOrShortConfirmation("Oi?", ENABLED_CONFIG)).toBe(true);
    });

    it("matches with a trailing emoji", () => {
      expect(isGreetingOrShortConfirmation("bom dia 😊", ENABLED_CONFIG)).toBe(true);
      expect(isGreetingOrShortConfirmation("Boa noite🌙", ENABLED_CONFIG)).toBe(true);
    });

    it("matches with a leading emoji", () => {
      expect(isGreetingOrShortConfirmation("😊 bom dia", ENABLED_CONFIG)).toBe(true);
    });

    it("matches with both leading and trailing punctuation/emoji combined", () => {
      expect(isGreetingOrShortConfirmation("🎉Bom dia!!! 😊", ENABLED_CONFIG)).toBe(true);
    });

    it("still rejects a real sentence even when it carries trailing punctuation/emoji", () => {
      expect(
        isGreetingOrShortConfirmation("Bom dia! Vamos prosseguir com a compra 😊", ENABLED_CONFIG)
      ).toBe(false);
    });
  });

  // Common WhatsApp opener variants the org asked to treat as greetings too.
  describe("default word list includes common opener variants", () => {
    it.each([
      "bom dia tudo bem",
      "Bom dia, tudo bem?",
      "boa tarde tudo bem",
      "Boa tarde, tudo bem?",
      "oi tudo bem",
      "Oi, tudo bem?",
      "olá tudo bem",
      "Olá, tudo bem?",
    ])("matches %j", (message) => {
      expect(isGreetingOrShortConfirmation(message, ENABLED_CONFIG)).toBe(true);
    });
  });
});

describe("resolveGreetingFilterConfig", () => {
  it("falls back to every default (disabled) when the org hasn't configured anything", () => {
    expect(resolveGreetingFilterConfig(undefined)).toEqual(DEFAULT_GREETING_FILTER_CONFIG);
    expect(resolveGreetingFilterConfig({})).toEqual(DEFAULT_GREETING_FILTER_CONFIG);
    expect(resolveGreetingFilterConfig(undefined).enabled).toBe(false);
  });

  it("uses the org's own configured values when present, including opting in", () => {
    const resolved = resolveGreetingFilterConfig({
      takeover_greeting_filter_enabled: true,
      takeover_greeting_words: ["eae"],
      takeover_greeting_max_length: 5,
    });
    expect(resolved).toEqual({ enabled: true, words: ["eae"], maxLength: 5 });
  });
});
