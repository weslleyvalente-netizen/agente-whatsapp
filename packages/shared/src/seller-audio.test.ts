import { describe, expect, it } from "vitest";
import {
  SELLER_AUDIO_MAX_BYTES,
  SELLER_AUDIO_MAX_SECONDS,
  SELLER_AUDIO_MIN_SECONDS,
  detectSellerAudioFormat,
} from "./seller-audio.js";

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe("constantes do áudio do vendedor", () => {
  it("define limites de tamanho e duração", () => {
    expect(SELLER_AUDIO_MAX_BYTES).toBe(3 * 1024 * 1024);
    expect(SELLER_AUDIO_MAX_SECONDS).toBe(300);
    expect(SELLER_AUDIO_MIN_SECONDS).toBe(1);
  });
});

describe("detectSellerAudioFormat", () => {
  it("detecta webm pelo cabeçalho EBML", () => {
    expect(detectSellerAudioFormat(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00))).toEqual({
      extension: "webm",
      mimeType: "audio/webm",
    });
  });

  it("detecta mp4 por 'ftyp' nos bytes 4-7", () => {
    expect(
      detectSellerAudioFormat(bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d))
    ).toEqual({ extension: "mp4", mimeType: "audio/mp4" });
  });

  it("detecta ogg por 'OggS'", () => {
    expect(detectSellerAudioFormat(bytes(0x4f, 0x67, 0x67, 0x53, 0x00, 0x02))).toEqual({
      extension: "ogg",
      mimeType: "audio/ogg",
    });
  });

  it("devolve null para texto, PNG e buffers vazios ou curtos", () => {
    expect(detectSellerAudioFormat(text("hello world"))).toBeNull();
    expect(detectSellerAudioFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBeNull();
    expect(detectSellerAudioFormat(new Uint8Array())).toBeNull();
    expect(detectSellerAudioFormat(bytes(0x1a, 0x45))).toBeNull();
  });
});
