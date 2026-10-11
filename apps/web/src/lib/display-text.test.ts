import { describe, it, expect } from "vitest";
import { displayText, distinctDisplayTexts } from "./display-text";
describe("display text", () => {
 it("repairs observed Mac decoding artifacts", () => { expect(displayText("Evolu√ß√£o com evid√™ncia: Sim")).toBe("Evolução com evidência: Sim"); expect(displayText("Rodar simula√ß√£o de financiamento")).toBe("Rodar simulação de financiamento"); });
 it("preserves correct Portuguese, emoji, numbers and empty values", () => { expect(displayText("Simulação 🏍️ R$ 713,46")).toBe("Simulação 🏍️ R$ 713,46"); expect(displayText(null)).toBe(""); });
 it("deduplicates only equivalent text and preserves different facts", () => { expect(distinctDisplayTexts(["Simulação enviada", " simulação  enviada ", "Cliente pediu retorno amanhã", null])).toEqual(["Simulação enviada", "Cliente pediu retorno amanhã"]); });
});
