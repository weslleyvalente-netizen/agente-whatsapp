import { describe, it, expect } from "vitest";
import { isNoOpReply } from "./no-op-reply.js";

describe("isNoOpReply", () => {
  // Real production cases: the "stay silent on generic acknowledgment"
  // system-prompt rule got satisfied literally instead of with truly
  // empty text, and these exact strings were sent to real customers.
  it("detects the exact placeholder sent to a real customer", () => {
    expect(isNoOpReply("(sem resposta necessária)")).toBe(true);
  });

  it("detects the italicized variant sent to another real customer", () => {
    expect(isNoOpReply("*(sem resposta necessária)*")).toBe(true);
  });

  it("detects the phrasing the user paraphrased it as", () => {
    expect(isNoOpReply("(sem necessidade de nova resposta)")).toBe(true);
  });

  it("detects the phrase without surrounding punctuation", () => {
    expect(isNoOpReply("sem resposta necessária")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isNoOpReply("Sem Resposta Necessária")).toBe(true);
  });

  it("does not flag a real conversational reply", () => {
    expect(isNoOpReply("Perfeito! Qualquer coisa me chama 😊")).toBe(false);
  });

  it("does not flag a real reply that happens to be short", () => {
    expect(isNoOpReply("Blz!")).toBe(false);
  });
});
