import { describe, expect, it } from "vitest";
import { bannerTitle, extraReasons } from "./health-banner-format";

const NOW = Date.parse("2026-10-17T12:00:00Z");
describe("bannerTitle", () => {
  it("horas", () => {
    expect(bannerTitle({ status: "warning", reasons: ["Sem mensagens de clientes há 9 h"], lastCustomerMessageAt: "2026-10-17T03:00:00Z" }, NOW)).toBe("Possível falha: sem mensagens de clientes há 9 h");
  });
  it("minutos quando menos de 1 h", () => {
    expect(bannerTitle({ status: "warning", reasons: ["Sem mensagens de clientes há 9 h"], lastCustomerMessageAt: "2026-10-17T11:20:00Z" }, NOW)).toContain("40 min");
  });
  it("sem mensagem registrada", () => {
    expect(bannerTitle({ status: "warning", reasons: ["Sem mensagens de clientes há 9 h"], lastCustomerMessageAt: null }, NOW)).toContain("nenhuma mensagem");
  });
});

describe("W1: título conforme o motivo", () => {
  it("sem motivo de silêncio não fala em silêncio", () => {
    const h = { status: "warning" as const, reasons: ["Redis fora do ar ou lento"], lastCustomerMessageAt: "2026-10-17T11:59:00Z" };
    expect(bannerTitle(h, NOW)).toBe("Possível falha: Redis fora do ar ou lento");
    expect(extraReasons(h, bannerTitle(h, NOW))).toEqual([]);
  });
  it("silêncio + Redis: título de silêncio e Redis como extra", () => {
    const h = { status: "warning" as const, reasons: ["Sem mensagens de clientes há 9 h", "Redis fora do ar"], lastCustomerMessageAt: "2026-10-17T03:00:00Z" };
    expect(extraReasons(h, bannerTitle(h, NOW))).toEqual(["Redis fora do ar"]);
  });
});
