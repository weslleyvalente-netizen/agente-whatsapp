import { describe, it, expect } from "vitest";
import { stripLeakedMetaNarration } from "./meta-narration-leak.js";

describe("stripLeakedMetaNarration", () => {
  // Confirmed in production (see docs/superpowers/plans/investigation/04-processing-pipeline-bugs.md):
  // the model invented this exact phrase instead of answering.
  it("strips 'A resposta já foi enviada.' when it's the entire message", () => {
    expect(stripLeakedMetaNarration("A resposta já foi enviada.")).toBe("");
  });

  it("strips the phrase without the accent or trailing period too", () => {
    expect(stripLeakedMetaNarration("a resposta ja foi enviada")).toBe("");
  });

  it("strips only the leaked fragment, keeping a legitimate answer around it", () => {
    const result = stripLeakedMetaNarration(
      "A resposta já foi enviada. A Fazer 250 sai por R$ 21.900 à vista."
    );
    expect(result).toBe("A Fazer 250 sai por R$ 21.900 à vista.");
  });

  it("strips a leaked fragment that appears after the real content", () => {
    const result = stripLeakedMetaNarration("Já te passei o endereço. Já enviei resposta.");
    expect(result).toBe("Já te passei o endereço.");
  });

  it("leaves a legitimate reply about prices/installments completely untouched", () => {
    const text = "A parcela fica R$ 698,99 em 48x. Quer que eu simule com entrada?";
    expect(stripLeakedMetaNarration(text)).toBe(text);
  });

  it("does not touch the word 'resposta' when it's not part of a meta-narration phrase", () => {
    const text = "Fico no aguardo da sua resposta pra seguir com a simulação.";
    expect(stripLeakedMetaNarration(text)).toBe(text);
  });

  it("collapses extra whitespace left behind after stripping, without eating real spacing", () => {
    const result = stripLeakedMetaNarration("Oi! A resposta já foi enviada. Qualquer coisa é só chamar.");
    expect(result).toBe("Oi! Qualquer coisa é só chamar.");
  });
});
