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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("returns ok:true with the base64-encoded audio on success", async () => {
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
      apiKey: "sk-test-key",
    });

    expect(result).toEqual({
      ok: true,
      audioBase64: Buffer.from(fakeAudioBytes).toString("base64"),
    });
  });

  // The actual pt-BR normalization rules (currency, installments,
  // percentages, pronunciation dictionary, etc.) are unit-tested directly
  // in tts-normalization.test.ts. This just proves generateSpeech actually
  // routes text through that layer before calling ElevenLabs, and that the
  // customer-facing `params.text` passed in is never itself mutated.
  it("normalizes text for TTS before sending it to ElevenLabs, without mutating the input", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("audio").buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    const originalText = "A Yamaha Fazer está disponível em 80x de R$ 371,83.";
    const result = await generateSpeech({
      text: originalText,
      voice: "GDzHdQOi6jjf8zaXhCYD",
      apiKey: "sk-test-key",
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.text).toBe(
      "A Yamaha Fêizer está disponível em oitenta parcelas de trezentos e setenta e um reais e oitenta e três centavos."
    );
    expect(result).toEqual({ ok: true, audioBase64: expect.any(String) });
    // The string passed in is untouched — confirms no shared-reference mutation.
    expect(originalText).toBe("A Yamaha Fazer está disponível em 80x de R$ 371,83.");
  });

  it("returns ok:false (never throws) when the ElevenLabs response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "internal error",
      })
    );

    await expect(
      generateSpeech({ text: "Oi!", voice: "GDzHdQOi6jjf8zaXhCYD", apiKey: "sk-test-key" })
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("500"),
    });
  });

  it("returns ok:false (never throws) when no API key is resolved", async () => {
    const result = await generateSpeech({ text: "Oi!", voice: "GDzHdQOi6jjf8zaXhCYD", apiKey: null });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ELEVENLABS_API_KEY");
    }
  });
});
