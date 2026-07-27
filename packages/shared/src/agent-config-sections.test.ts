import { describe, it, expect } from "vitest";
import { SECTION_ORDER, SECTION_ITEMS, SECTION_LABELS, SECTION_TO_DRAFT_KEY, DRAFT_KEY_TO_SECTION } from "./agent-config-sections.js";

describe("agent-config-sections", () => {
  it("has a label for every section in SECTION_ORDER", () => {
    for (const key of SECTION_ORDER) {
      expect(SECTION_LABELS[key]).toBeTruthy();
    }
  });

  it("has an entry in SECTION_ITEMS for every section (null for sections without items)", () => {
    for (const key of SECTION_ORDER) {
      expect(key in SECTION_ITEMS).toBe(true);
    }
  });

  it("SECTION_TO_DRAFT_KEY and DRAFT_KEY_TO_SECTION are exact inverses of each other", () => {
    for (const key of SECTION_ORDER) {
      const draftKey = SECTION_TO_DRAFT_KEY[key];
      expect(DRAFT_KEY_TO_SECTION[draftKey]).toBe(key);
    }
  });
});
