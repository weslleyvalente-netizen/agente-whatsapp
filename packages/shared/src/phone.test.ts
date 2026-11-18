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

import { ignoredContactPhoneCandidates } from "./phone.js";
describe("ignoredContactPhoneCandidates (lista de ignorados com/sem o 9º dígito)", () => {
  const c = ignoredContactPhoneCandidates;
  it("celular com o 9 (13 dígitos) também procura a forma sem o 9, e vice-versa", () => {
    expect(c("5562996188374")).toEqual(expect.arrayContaining(["5562996188374", "556296188374"]));
    expect(c("556296188374")).toEqual(expect.arrayContaining(["556296188374", "5562996188374"]));
  });
  it("aceita formatação (+, espaços, traços) e devolve também só os dígitos", () => {
    expect(c("+55 (62) 99618-8374")).toEqual(expect.arrayContaining(["5562996188374", "556296188374"]));
  });
  it("NÃO casa números diferentes: mesmo DDD com final diferente, DDD diferente, 9 no lugar errado", () => {
    expect(c("5562996188374")).not.toContain("5562996188375");
    expect(c("5562996188374")).not.toContain("556196188374"); // outro DDD
    expect(c("5511996188374")).not.toContain("556296188374");
    expect(c("5562996188374")).not.toContain("5562996188374" + "0");
    // o candidato sem o 9 de 5562996188374 é 556296188374; um 12 dígitos DIFERENTE não entra
    expect(c("5562996188374")).not.toContain("556296188375");
  });
  it("telefone FIXO (começa com 2-5) nunca ganha/perde o 9: fixo 556233124567 não vira celular", () => {
    expect(c("556233124567")).toEqual(["556233124567"]);
    expect(c("5562933124567")).toEqual(["5562933124567"]); // 9 + dígito 3: não é celular válido, não remove o 9
  });
  it("DDD inválido, outro país, tamanho estranho e vazio: só o próprio valor", () => {
    expect(c("5502996188374")).toEqual(["5502996188374"]);
    expect(c("5562996188")).toEqual(["5562996188"]);
    expect(c("14155550123")).toEqual(["14155550123"]);
    expect(c("")).toEqual([]); expect(c(null)).toEqual([]);
  });
});
