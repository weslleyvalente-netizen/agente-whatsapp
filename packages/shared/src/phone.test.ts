import { describe, it, expect } from "vitest";
import { brazilPhoneAlternate, brazilPhoneVariants } from "./phone.js";

describe("brazilPhoneAlternate", () => {
  it("drops the 9th digit from a 9-digit mobile number", () => {
    expect(brazilPhoneAlternate("5562996807555")).toBe("556296807555");
  });

  it("adds the 9th digit to an 8-digit mobile number", () => {
    expect(brazilPhoneAlternate("556296807555")).toBe("5562996807555");
  });

  it("returns null for numbers that aren't Brazilian (55)", () => {
    expect(brazilPhoneAlternate("11996807555")).toBeNull();
  });

  it("returns null for a malformed length", () => {
    expect(brazilPhoneAlternate("5562")).toBeNull();
  });
});

describe("brazilPhoneVariants", () => {
  it("returns both digit-count forms for a valid Brazilian mobile number", () => {
    expect(brazilPhoneVariants("5562996807555")).toEqual(["5562996807555", "556296807555"]);
  });

  it("returns just the input when no alternate applies", () => {
    expect(brazilPhoneVariants("11996807555")).toEqual(["11996807555"]);
  });
});
