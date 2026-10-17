import { describe, expect, it } from "vitest";
import { normalizeAlertPhone } from "./health-alert-phone";

describe("normalizeAlertPhone", () => {
  it("vazio vira null", () => expect(normalizeAlertPhone("  ")).toEqual({ ok: true, value: null }));
  it("limpa máscara", () => expect(normalizeAlertPhone("+55 (62) 99999-8888")).toEqual({ ok: true, value: "5562999998888" }));
  it("recusa letras e tamanhos inválidos", () => {
    expect(normalizeAlertPhone("abc").ok).toBe(false);
    expect(normalizeAlertPhone("12345").ok).toBe(false);
    expect(normalizeAlertPhone("1".repeat(16)).ok).toBe(false);
  });
});
