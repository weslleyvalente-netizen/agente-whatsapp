import { describe, it, expect, vi, afterEach } from "vitest";

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

  // Regression: this exact reply went out as a voice note in production
  // because the old fixed-emoji allowlist (🔹, -, •) didn't include 🏍️,
  // which this agent uses as the bullet marker for motorcycle listings.
  it("rejects a reply with a 🏍️-bulleted list of 2+ motorcycles", () => {
    const text =
      "Temos várias opções em estoque, Carla! Alguns exemplos:\n\n" +
      "🏍️ AZ160 Xtreme (elétrica, 0km)\n" +
      "🏍️ R15 ABS, R3 ABS Connected (preta ou azul) e Lander Connected — todas Yamaha 0km\n\n" +
      "Isso é só uma parte do estoque — se você tiver uma moto específica em mente, me diz o modelo que eu confirmo disponibilidade certinha.";
    expect(isSimpleEnoughForAudio(text)).toBe(false);
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
  const originalKey = process.env.ELEVENLABS_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    if (originalKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = originalKey;
    }
  });

  it("returns ok:true with the base64-encoded audio on success", async () => {
    process.env.ELEVENLABS_API_KEY = "sk-test-key";
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
      voice: "GDzHdQOi6jjf8zaXhCYD",
    });

    expect(result).toEqual({
      ok: true,
      audioBase64: Buffer.from(fakeAudioBytes).toString("base64"),
    });
  });

  it("returns ok:false (never throws) when the ElevenLabs response is not ok", async () => {
    process.env.ELEVENLABS_API_KEY = "sk-test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "internal error",
      })
    );

    await expect(
      generateSpeech({ text: "Oi!", voice: "GDzHdQOi6jjf8zaXhCYD" })
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("500"),
    });
  });

  it("returns ok:false (never throws) when ELEVENLABS_API_KEY is not set", async () => {
    delete process.env.ELEVENLABS_API_KEY;

    const result = await generateSpeech({ text: "Oi!", voice: "GDzHdQOi6jjf8zaXhCYD" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ELEVENLABS_API_KEY");
    }
  });
});
