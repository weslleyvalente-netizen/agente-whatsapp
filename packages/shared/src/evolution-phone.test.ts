import { describe, it, expect } from "vitest";
import { resolveEvolutionPhone, lidPairOf } from "./evolution-phone.js";

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

describe("lidPairOf (par @lid + número real vindo do próprio WhatsApp)", () => {
  it("chat @lid com alt de telefone", () => {
    expect(lidPairOf({ remoteJid: "88683172618347@lid", remoteJidAlt: "5562999991234@s.whatsapp.net" }, "5562999991234")).toEqual({ lid: "88683172618347@lid", phone: "5562999991234" });
  });
  it("chat já com o telefone e o @lid no alt (UAZAPI chatlid)", () => {
    expect(lidPairOf({ remoteJid: "5562999991234@s.whatsapp.net", remoteJidAlt: "88683172618347@lid" }, "5562999991234")).toEqual({ lid: "88683172618347@lid", phone: "5562999991234" });
  });
  it("sem número real confiável não há par", () => {
    expect(lidPairOf({ remoteJid: "88683172618347@lid", remoteJidAlt: null }, "88683172618347@lid")).toBeNull();
    expect(lidPairOf({ remoteJid: "88683172618347@lid", remoteJidAlt: "0@s.whatsapp.net" }, "0")).toBeNull();
    expect(lidPairOf({ remoteJid: "5562999991234@s.whatsapp.net" }, "5562999991234")).toBeNull();
  });
  it("número da própria loja nunca é usado", () => {
    expect(lidPairOf({ remoteJid: "1@lid", remoteJidAlt: "5562988880000@s.whatsapp.net" }, "5562988880000", "5562988880000")).toBeNull();
  });
});
