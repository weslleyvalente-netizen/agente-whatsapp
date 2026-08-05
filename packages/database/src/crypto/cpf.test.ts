import { describe, it, expect, beforeAll } from "vitest";
import { encryptCpf, decryptCpf, hashCpf } from "./cpf.js";

beforeAll(() => {
  process.env.QUALIFICATION_CPF_ENCRYPTION_KEY = "0".repeat(64); // 32 bytes of zeros, test-only
  process.env.QUALIFICATION_CPF_HASH_PEPPER = "test-pepper";
});

describe("encryptCpf / decryptCpf", () => {
  it("round-trips a CPF through encryption and decryption", () => {
    const plain = "12345678900";
    const encrypted = encryptCpf(plain);
    expect(encrypted).not.toBe(plain);
    expect(decryptCpf(encrypted)).toBe(plain);
  });

  it("produces a different ciphertext each call (random IV) but both decrypt correctly", () => {
    const plain = "12345678900";
    const a = encryptCpf(plain);
    const b = encryptCpf(plain);
    expect(a).not.toBe(b);
    expect(decryptCpf(a)).toBe(plain);
    expect(decryptCpf(b)).toBe(plain);
  });
});

describe("hashCpf", () => {
  it("hashes the same CPF identically every time", () => {
    expect(hashCpf("12345678900")).toBe(hashCpf("12345678900"));
  });

  it("hashes different CPFs differently", () => {
    expect(hashCpf("12345678900")).not.toBe(hashCpf("98765432100"));
  });

  it("does not return the plain CPF", () => {
    expect(hashCpf("12345678900")).not.toBe("12345678900");
  });
});
