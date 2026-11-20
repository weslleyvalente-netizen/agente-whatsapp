import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptInstanceToken, encryptInstanceToken } from "./instance-token.js";

afterEach(() => vi.unstubAllEnvs());

describe("token da instância UAZAPI cifrado", () => {
  it("cifra e decifra; o texto guardado não contém o token", () => {
    vi.stubEnv("UAZAPI_ADMIN_TOKEN", "admin-1");
    const stored = encryptInstanceToken("tok-123");
    expect(stored).not.toContain("tok-123");
    expect(stored.split(":")).toHaveLength(3);
    expect(decryptInstanceToken(stored)).toBe("tok-123");
  });

  it("sem UAZAPI_ADMIN_TOKEN: erro claro", () => {
    vi.stubEnv("UAZAPI_ADMIN_TOKEN", "");
    expect(() => encryptInstanceToken("x")).toThrow("UAZAPI_ADMIN_TOKEN não configurado");
  });

  it("token de administrador trocado: ilegível", () => {
    vi.stubEnv("UAZAPI_ADMIN_TOKEN", "admin-1");
    const stored = encryptInstanceToken("tok-123");
    vi.stubEnv("UAZAPI_ADMIN_TOKEN", "admin-2");
    expect(() => decryptInstanceToken(stored)).toThrow("token da instância UAZAPI ilegível (token de administrador trocado?)");
  });
});
