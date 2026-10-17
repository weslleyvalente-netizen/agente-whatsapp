import { describe, expect, it } from "vitest";
import { bannerTitle } from "./health-banner-format";

const NOW = Date.parse("2026-10-17T12:00:00Z");
describe("bannerTitle", () => {
  it("horas", () => {
    expect(bannerTitle({ status: "warning", reasons: [], lastCustomerMessageAt: "2026-10-17T03:00:00Z" }, NOW)).toBe("Possível falha: sem mensagens de clientes há 9 h");
  });
  it("minutos quando menos de 1 h", () => {
    expect(bannerTitle({ status: "warning", reasons: [], lastCustomerMessageAt: "2026-10-17T11:20:00Z" }, NOW)).toContain("40 min");
  });
  it("sem mensagem registrada", () => {
    expect(bannerTitle({ status: "warning", reasons: [], lastCustomerMessageAt: null }, NOW)).toContain("nenhuma mensagem");
  });
});
