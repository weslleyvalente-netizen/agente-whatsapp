import { describe, expect, it } from "vitest";
import { adPlatformLabel, safeAdUrl, formatAdTouchDate, adTouchHeading } from "./ad-origin";

describe("adPlatformLabel", () => {
  it("nomes em português para as três plataformas; desconhecida vira Anúncio Meta", () => {
    expect(adPlatformLabel("instagram")).toBe("Instagram");
    expect(adPlatformLabel("facebook")).toBe("Facebook");
    expect(adPlatformLabel("meta")).toBe("Anúncio Meta");
    expect(adPlatformLabel("tiktok")).toBe("Anúncio Meta");
  });
});

describe("safeAdUrl", () => {
  it("só http(s) vira link; qualquer outra coisa não", () => {
    expect(safeAdUrl("https://www.instagram.com/p/AAA/")).toBe("https://www.instagram.com/p/AAA/");
    expect(safeAdUrl("http://fb.me/abc")).toBe("http://fb.me/abc");
    expect(safeAdUrl("javascript:alert(1)")).toBeNull();
    expect(safeAdUrl("data:text/html,x")).toBeNull();
    expect(safeAdUrl("//evil.com")).toBeNull();
    expect(safeAdUrl("")).toBeNull();
    expect(safeAdUrl(null)).toBeNull();
  });
});

describe("formatAdTouchDate", () => {
  it("data e hora em Brasília", () => {
    expect(formatAdTouchDate("2026-11-13T15:00:00Z")).toBe("13/11/2026 12:00");
  });
  it("data inválida devolve vazio", () => expect(formatAdTouchDate("x")).toBe(""));
});

describe("adTouchHeading", () => {
  it("título, senão id do anúncio, senão a plataforma", () => {
    expect(adTouchHeading({ ad_title: "Seu próximo carro", ad_id: "9", platform: "instagram" })).toBe("Seu próximo carro");
    expect(adTouchHeading({ ad_title: null, ad_id: "9", platform: "instagram" })).toBe("Anúncio 9");
    expect(adTouchHeading({ ad_title: " ", ad_id: null, platform: "facebook" })).toBe("Anúncio do Facebook");
  });
});
