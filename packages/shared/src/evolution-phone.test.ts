import { describe, it, expect } from "vitest";
import { resolveEvolutionPhone } from "./evolution-phone.js";

describe("resolveEvolutionPhone", () => {
  it("remove o sufixo @s.whatsapp.net", () => {
    expect(resolveEvolutionPhone({ remoteJid: "5511988301448@s.whatsapp.net" })).toBe("5511988301448");
  });

  it("@lid com remoteJidAlt válido usa o número real", () => {
    expect(
      resolveEvolutionPhone({ remoteJid: "85801266339926@lid", remoteJidAlt: "556296818769@s.whatsapp.net" })
    ).toBe("556296818769");
  });

  it.each([undefined, null, "", "123@lid", "abc", "0@s.whatsapp.net", "abc@s.whatsapp.net", "1234567@s.whatsapp.net", "1234567890123456@s.whatsapp.net", "+5511999990000@s.whatsapp.net"])("@lid com alt inválido (%s) devolve o remoteJid", (alt) => {
    expect(resolveEvolutionPhone({ remoteJid: "85801266339926@lid", remoteJidAlt: alt })).toBe("85801266339926@lid");
  });

  it("remoteJid normal ignora o alt", () => {
    expect(
      resolveEvolutionPhone({ remoteJid: "5511999990000@s.whatsapp.net", remoteJidAlt: "5511888880000@s.whatsapp.net" })
    ).toBe("5511999990000");
  });

  it("grupos ficam intocados", () => {
    expect(resolveEvolutionPhone({ remoteJid: "120363@g.us", remoteJidAlt: "5511@s.whatsapp.net" })).toBe("120363@g.us");
  });

  it("outro formato mantém o comportamento atual", () => {
    expect(resolveEvolutionPhone({ remoteJid: "5511988887777" })).toBe("5511988887777");
  });
});
