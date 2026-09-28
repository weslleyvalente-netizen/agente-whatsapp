import { describe, it, expect } from "vitest";
import {
  isGreetingOrShortConfirmation,
  resolveGreetingFilterConfig,
  DEFAULT_GREETING_FILTER_CONFIG,
} from "./greeting-filter.js";

describe("isGreetingOrShortConfirmation", () => {
  it("matches a bare greeting word from the default list", () => {
    expect(isGreetingOrShortConfirmation("Bom dia", DEFAULT_GREETING_FILTER_CONFIG)).toBe(true);
    expect(isGreetingOrShortConfirmation("boa tarde", DEFAULT_GREETING_FILTER_CONFIG)).toBe(true);
    expect(isGreetingOrShortConfirmation("oi", DEFAULT_GREETING_FILTER_CONFIG)).toBe(true);
  });

  it("is case- and accent-insensitive", () => {
    expect(isGreetingOrShortConfirmation("OLÁ", DEFAULT_GREETING_FILTER_CONFIG)).toBe(true);
    expect(isGreetingOrShortConfirmation("Ola", DEFAULT_GREETING_FILTER_CONFIG)).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(isGreetingOrShortConfirmation("  bom dia  ", DEFAULT_GREETING_FILTER_CONFIG)).toBe(true);
  });

  it("matches a message that is only emoji, regardless of the word list", () => {
    expect(isGreetingOrShortConfirmation("👍", DEFAULT_GREETING_FILTER_CONFIG)).toBe(true);
    expect(isGreetingOrShortConfirmation("😊🙏", DEFAULT_GREETING_FILTER_CONFIG)).toBe(true);
  });

  // This is the case that matters most: real production data (Fase 0) shows
  // fixed short tokens ("8121", an attendant's own name) that are NOT
  // greetings — a bare length check would wrongly swallow these along with
  // genuine short replies like "sim" or "manda". Only an exact match against
  // the configured word list (or pure emoji) may filter.
  it("does NOT match a short message that isn't a configured greeting word", () => {
    expect(isGreetingOrShortConfirmation("8121", DEFAULT_GREETING_FILTER_CONFIG)).toBe(false);
    expect(isGreetingOrShortConfirmation("marina", DEFAULT_GREETING_FILTER_CONFIG)).toBe(false);
    expect(isGreetingOrShortConfirmation("sim", DEFAULT_GREETING_FILTER_CONFIG)).toBe(false);
    expect(isGreetingOrShortConfirmation("manda", DEFAULT_GREETING_FILTER_CONFIG)).toBe(false);
  });

  it("does NOT match a real sentence that merely starts with a greeting word", () => {
    expect(
      isGreetingOrShortConfirmation("Bom dia, vamos prosseguir com a compra", DEFAULT_GREETING_FILTER_CONFIG)
    ).toBe(false);
  });

  it("respects the configured max length even for a listed word", () => {
    const strict = { ...DEFAULT_GREETING_FILTER_CONFIG, maxLength: 5 };
    expect(isGreetingOrShortConfirmation("boa noite", strict)).toBe(false); // 9 chars, over the cap
    expect(isGreetingOrShortConfirmation("oi", strict)).toBe(true);
  });

  it("respects a custom word list", () => {
    const custom = { ...DEFAULT_GREETING_FILTER_CONFIG, words: ["eae"] };
    expect(isGreetingOrShortConfirmation("eae", custom)).toBe(true);
    expect(isGreetingOrShortConfirmation("oi", custom)).toBe(false);
  });

  it("never matches anything when the filter is disabled for the organization", () => {
    const disabled = { ...DEFAULT_GREETING_FILTER_CONFIG, enabled: false };
    expect(isGreetingOrShortConfirmation("Bom dia", disabled)).toBe(false);
    expect(isGreetingOrShortConfirmation("👍", disabled)).toBe(false);
  });

  it("does not match empty content", () => {
    expect(isGreetingOrShortConfirmation("", DEFAULT_GREETING_FILTER_CONFIG)).toBe(false);
    expect(isGreetingOrShortConfirmation("   ", DEFAULT_GREETING_FILTER_CONFIG)).toBe(false);
  });
});

describe("resolveGreetingFilterConfig", () => {
  it("falls back to every default when the org hasn't configured anything", () => {
    expect(resolveGreetingFilterConfig(undefined)).toEqual(DEFAULT_GREETING_FILTER_CONFIG);
    expect(resolveGreetingFilterConfig({})).toEqual(DEFAULT_GREETING_FILTER_CONFIG);
  });

  it("uses the org's own configured values when present", () => {
    const resolved = resolveGreetingFilterConfig({
      takeover_greeting_filter_enabled: false,
      takeover_greeting_words: ["eae"],
      takeover_greeting_max_length: 5,
    });
    expect(resolved).toEqual({ enabled: false, words: ["eae"], maxLength: 5 });
  });
});
