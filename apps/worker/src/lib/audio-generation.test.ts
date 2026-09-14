import { describe, it, expect } from "vitest";
import { isSimpleEnoughForAudio } from "./audio-generation.js";

describe("isSimpleEnoughForAudio", () => {
  it("accepts a short conversational reply", () => {
    expect(isSimpleEnoughForAudio("Oi! Vi que você se interessou pela Titan 160, qual seu CPF?")).toBe(true);
  });

  it("rejects a reply containing a link", () => {
    expect(isSimpleEnoughForAudio("Segue o link da simulação: https://link.icred.app/5gxJpdy")).toBe(false);
  });

  it("rejects a reply with a bulleted list of 2+ options", () => {
    const text = "As mais baratas hoje são:\n\n🔹 Avelloz AZ1 50cc – R$ 13.900\n🔹 Factor 150 ED – R$ 22.904";
    expect(isSimpleEnoughForAudio(text)).toBe(false);
  });

  it("rejects a reply with a numbered list of 2+ options", () => {
    const text = "Temos duas opções:\n1) Bros 160 azul\n2) Bros 160 preta";
    expect(isSimpleEnoughForAudio(text)).toBe(false);
  });

  it("accepts a reply with only a single list-like line", () => {
    const text = "Beleza! 🔹 Vou confirmar e te aviso.";
    expect(isSimpleEnoughForAudio(text)).toBe(true);
  });
});
