import { describe, it, expect } from "vitest";
import { normalizeTextForTts, numberToWordsPtBr } from "./tts-normalization.js";

describe("numberToWordsPtBr", () => {
  it("spells out basic numbers", () => {
    expect(numberToWordsPtBr(0)).toBe("zero");
    expect(numberToWordsPtBr(1)).toBe("um");
    expect(numberToWordsPtBr(15)).toBe("quinze");
    expect(numberToWordsPtBr(21)).toBe("vinte e um");
    expect(numberToWordsPtBr(100)).toBe("cem");
    expect(numberToWordsPtBr(101)).toBe("cento e um");
    expect(numberToWordsPtBr(371)).toBe("trezentos e setenta e um");
  });

  it("joins thousands with 'e' only when the remainder is under 100", () => {
    expect(numberToWordsPtBr(1060)).toBe("mil e sessenta");
    expect(numberToWordsPtBr(1250)).toBe("mil duzentos e cinquenta");
    expect(numberToWordsPtBr(50000)).toBe("cinquenta mil");
    expect(numberToWordsPtBr(25900)).toBe("vinte e cinco mil novecentos");
  });

  it("handles millions", () => {
    expect(numberToWordsPtBr(1000000)).toBe("um milhão");
    expect(numberToWordsPtBr(1050000)).toBe("um milhão e cinquenta mil");
  });

  it("uses feminine forms (uma/duas, -entas) when requested", () => {
    expect(numberToWordsPtBr(1, true)).toBe("uma");
    expect(numberToWordsPtBr(2, true)).toBe("duas");
    expect(numberToWordsPtBr(21, true)).toBe("vinte e uma");
    expect(numberToWordsPtBr(22, true)).toBe("vinte e duas");
    expect(numberToWordsPtBr(72, true)).toBe("setenta e duas");
    expect(numberToWordsPtBr(200, true)).toBe("duzentas");
  });
});

describe("normalizeTextForTts", () => {
  // Currency — decimal
  it("converts R$ 371,83", () => {
    expect(normalizeTextForTts("R$ 371,83")).toBe("trezentos e setenta e um reais e oitenta e três centavos");
  });

  it("converts R$ 1.060,31", () => {
    expect(normalizeTextForTts("R$ 1.060,31")).toBe("mil e sessenta reais e trinta e um centavos");
  });

  it("converts R$ 1.250,00 (drops zero cents)", () => {
    expect(normalizeTextForTts("R$ 1.250,00")).toBe("mil duzentos e cinquenta reais");
  });

  it("converts R$ 50.000,00", () => {
    expect(normalizeTextForTts("R$ 50.000,00")).toBe("cinquenta mil reais");
  });

  it("converts R$ 1,00 (singular real)", () => {
    expect(normalizeTextForTts("R$ 1,00")).toBe("um real");
  });

  it("converts R$ 0,50 (cents only)", () => {
    expect(normalizeTextForTts("R$ 0,50")).toBe("cinquenta centavos");
  });

  it("converts R$ 1,01 (singular real and singular centavo)", () => {
    expect(normalizeTextForTts("R$ 1,01")).toBe("um real e um centavo");
  });

  it("converts R$ 2,01 (plural reais, singular centavo)", () => {
    expect(normalizeTextForTts("R$ 2,01")).toBe("dois reais e um centavo");
  });

  // Currency — plain / rounded
  it("converts a plain amount with no decimal comma (R$ 500/mês)", () => {
    expect(normalizeTextForTts("R$ 500/mês")).toBe("quinhentos reais por mês");
  });

  it("converts a plain thousands-separated amount previously left as digits", () => {
    expect(normalizeTextForTts("R$ 25.900")).toBe("vinte e cinco mil novecentos reais");
  });

  it("converts R$ 391,99/mês", () => {
    expect(normalizeTextForTts("R$ 391,99/mês")).toBe("trezentos e noventa e um reais e noventa e nove centavos por mês");
  });

  // Installments
  it("converts 12x de R$ 500,00", () => {
    expect(normalizeTextForTts("12x de R$ 500,00")).toBe("doze parcelas de quinhentos reais");
  });

  it("converts 80x de R$ 371,83", () => {
    expect(normalizeTextForTts("80x de R$ 371,83")).toBe(
      "oitenta parcelas de trezentos e setenta e um reais e oitenta e três centavos"
    );
  });

  it("converts 72x R$ 567,94 (no 'de' in the source)", () => {
    expect(normalizeTextForTts("72x R$ 567,94")).toBe(
      "setenta e duas parcelas de quinhentos e sessenta e sete reais e noventa e quatro centavos"
    );
  });

  it("converts 1x de R$ 500,00 (singular parcela, feminine uma)", () => {
    expect(normalizeTextForTts("1x de R$ 500,00")).toBe("uma parcela de quinhentos reais");
  });

  it("converts 21x de R$ 500,00 (vinte e uma, not vinte e um)", () => {
    expect(normalizeTextForTts("21x de R$ 500,00")).toBe("vinte e uma parcelas de quinhentos reais");
  });

  it("converts 22x de R$ 500,00 (vinte e duas, not vinte e dois)", () => {
    expect(normalizeTextForTts("22x de R$ 500,00")).toBe("vinte e duas parcelas de quinhentos reais");
  });

  // Real production case: "12x R$ 943,00" with no "de" and no space
  // convention matching the other examples — confirmed live.
  it("converts 12x R$ 943,00 (real production phrasing)", () => {
    expect(normalizeTextForTts("12x R$ 943,00")).toBe("doze parcelas de novecentos e quarenta e três reais");
  });

  it("leaves a bare installment count with no following R$ untouched", () => {
    expect(normalizeTextForTts("Você tem interesse em fechar em 12x?")).toBe("Você tem interesse em fechar em 12x?");
  });

  // Percentages
  it("converts 10%", () => {
    expect(normalizeTextForTts("10%")).toBe("dez por cento");
  });

  it("converts 1,5%", () => {
    expect(normalizeTextForTts("1,5%")).toBe("um vírgula cinco por cento");
  });

  it("converts 0,7%", () => {
    expect(normalizeTextForTts("0,7%")).toBe("zero vírgula sete por cento");
  });

  // Pronunciation dictionary
  it("respells Fazer as Fêizer", () => {
    expect(normalizeTextForTts("Yamaha Fazer")).toBe("Yamaha Fêizer");
  });

  it("does not touch the lowercase verb 'fazer'", () => {
    expect(normalizeTextForTts("Posso fazer isso pra você.")).toBe("Posso fazer isso pra você.");
  });

  // Distance units
  it("converts 0km", () => {
    expect(normalizeTextForTts("Bros 160 CBS 0km")).toBe("Bros 160 CBS zero quilômetros");
  });

  it("converts km/h", () => {
    expect(normalizeTextForTts("Vai até 120km/h")).toBe("Vai até cento e vinte quilômetros por hora");
  });

  // Dates
  it("converts a full date", () => {
    expect(normalizeTextForTts("Nasceu em 23/05/1970.")).toBe("Nasceu em vinte e três de maio de mil novecentos e setenta.");
  });

  // Combined real sentences
  it("converts a full real sentence combining currency, installments, dates and 0km", () => {
    const input =
      "Achei a Bros 160 CBS 0km, Nivaldo — tem em azul e preta, por R$ 28.970 e R$ 27.900. Quer que eu te mande as fotos?";
    const output = normalizeTextForTts(input);
    expect(output).toContain("zero quilômetros");
    expect(output).toContain("vinte e oito mil novecentos e setenta reais");
    expect(output).toContain("vinte e sete mil novecentos reais");
  });

  it("converts the exact example from the request spec", () => {
    const input = "Temos a Yamaha Fazer em 80x de R$ 371,83. Também temos uma condição com 10% de lance.";
    const expected =
      "Temos a Yamaha Fêizer em oitenta parcelas de trezentos e setenta e um reais e oitenta e três centavos. Também temos uma condição com dez por cento de lance.";
    expect(normalizeTextForTts(input)).toBe(expected);
  });

  it("preserves punctuation and pauses in a natural sentence", () => {
    const input = "Olá! A parcela fica em R$ 371,83. Quer que eu faça uma simulação?";
    const expected = "Olá! A parcela fica em trezentos e setenta e um reais e oitenta e três centavos. Quer que eu faça uma simulação?";
    expect(normalizeTextForTts(input)).toBe(expected);
  });
});
