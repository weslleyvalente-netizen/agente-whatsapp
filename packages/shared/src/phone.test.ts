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

import { phoneMatchKey, samePhoneNumber } from "./phone.js";

describe("samePhoneNumber / phoneMatchKey", () => {
  it("com e sem o 9º dígito são o mesmo telefone, nas duas ordens", () => {
    expect(samePhoneNumber("5562996188374", "556296188374")).toBe(true);
    expect(samePhoneNumber("556296188374", "5562996188374")).toBe(true);
  });
  it("ignora formatação, + e espaços; aceita nacional sem 55", () => {
    expect(samePhoneNumber("+55 (62) 99618-8374", "556296188374")).toBe(true);
    expect(samePhoneNumber("62996188374", "5562996188374")).toBe(true);
    expect(samePhoneNumber("(62) 9618-8374", "5562996188374")).toBe(true);
  });
  it("DDD diferente não casa", () => {
    expect(samePhoneNumber("5511996188374", "5562996188374")).toBe(false);
  });
  it("fixo de 8 dígitos casa consigo mesmo e não com outro número", () => {
    expect(samePhoneNumber("556232451234", "62 3245-1234")).toBe(true);
    expect(samePhoneNumber("556232451234", "556232451235")).toBe(false);
  });
  it("número não brasileiro usa os dígitos completos", () => {
    expect(phoneMatchKey("+1 (415) 555-0132")).toBe("14155550132");
    expect(samePhoneNumber("+14155550132", "14155550132")).toBe(true);
    expect(samePhoneNumber("+14155550132", "+14155550133")).toBe(false);
  });
  it("vazio nunca casa", () => {
    expect(samePhoneNumber("", "")).toBe(false);
    expect(samePhoneNumber(null, "5562996188374")).toBe(false);
  });
});
