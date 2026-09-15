import { describe, it, expect, vi, afterEach } from "vitest";

const { resolveApiKey } = vi.hoisted(() => ({ resolveApiKey: vi.fn() }));
vi.mock("@aula-agente/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aula-agente/agent-runtime")>();
  return { ...actual, resolveApiKey };
});

import { isSimpleEnoughForAudio, generateSpeech } from "./audio-generation.js";

describe("isSimpleEnoughForAudio", () => {
  it("accepts a short conversational reply", () => {
    expect(isSimpleEnoughForAudio("Oi! Vi que você se interessou pela Titan 160, qual seu CPF?")).toBe(true);
  });

  it("rejects a reply containing a link", () => {
    expect(isSimpleEnoughForAudio("Segue o link da simulação: https://link.icred.app/5gxJpdy")).toBe(false);
  });

  it("rejects a reply with a bulleted list of 2+ options", () => {
    const text = "As mais baratas hoje são:\n\n🔹 Avelloz AZ1 50cc – R$ 13.900\n🔹 Factor 150 ED – R$ 22.904";
    expect(isSimpleEnoughForAudio(text)).toBe(false);
  });

  it("rejects a reply with a numbered list of 2+ options", () => {
    const text = "Temos duas opções:\n1) Bros 160 azul\n2) Bros 160 preta";
    expect(isSimpleEnoughForAudio(text)).toBe(false);
  });

  it("accepts a reply with only a single list-like line", () => {
    const text = "Beleza! 🔹 Vou confirmar e te aviso.";
    expect(isSimpleEnoughForAudio(text)).toBe(true);
  });

  it("rejects a reply longer than 600 characters", () => {
    const text = "a".repeat(601);
    expect(isSimpleEnoughForAudio(text)).toBe(false);
  });

  it("accepts a normal-length conversational reply under 600 characters", () => {
    const text = "a".repeat(600);
    expect(isSimpleEnoughForAudio(text)).toBe(true);
  });
});

describe("generateSpeech", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("returns ok:true with the base64-encoded audio on success", async () => {
    resolveApiKey.mockResolvedValue("sk-test-key");
    const fakeAudioBytes = new TextEncoder().encode("fake-audio-bytes");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeAudioBytes.buffer,
      })
    );

    const result = await generateSpeech({
      text: "Oi! Vou te ajudar com isso.",
      voice: "alloy",
      organizationId: "org-1",
    });

    expect(result).toEqual({
      ok: true,
      audioBase64: Buffer.from(fakeAudioBytes).toString("base64"),
    });
  });

  it("returns ok:false (never throws) when the OpenAI response is not ok", async () => {
    resolveApiKey.mockResolvedValue("sk-test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "internal error",
      })
    );

    await expect(
      generateSpeech({ text: "Oi!", voice: "alloy", organizationId: "org-1" })
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("500"),
    });
  });

  it("returns ok:false (never throws) when resolveApiKey rejects", async () => {
    resolveApiKey.mockRejectedValue(new Error("No API key found for provider"));

    const result = await generateSpeech({ text: "Oi!", voice: "alloy", organizationId: "org-1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("No API key found for provider");
    }
  });
});
