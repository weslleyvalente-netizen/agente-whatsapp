import { describe, expect, it } from "vitest";
import { chatMediaState, formatBytes, isMediaPlaceholder } from "./chat-media";

const NOW = new Date("2026-11-09T12:00:00Z");
const base = { media_type: "image", media_url: null, metadata: null, created_at: "2026-11-09T11:58:00Z" };

describe("chatMediaState", () => {
  it("stored quando media_url é referência do chat-media", () => {
    expect(chatMediaState({ ...base, media_url: "storage:chat-media/o/c/m.jpg" }, NOW)).toBe("stored");
  });
  it("expired: sem media_url mas status stored", () => {
    expect(chatMediaState({ ...base, metadata: { media: { status: "stored" } } }, NOW)).toBe("expired");
  });
  it("too_large e failed vêm do status", () => {
    expect(chatMediaState({ ...base, metadata: { media: { status: "too_large" } } }, NOW)).toBe("too_large");
    expect(chatMediaState({ ...base, metadata: { media: { status: "failed" } } }, NOW)).toBe("failed");
  });
  it("pending: sem url, sem status, menos de 10 min", () => {
    expect(chatMediaState(base, NOW)).toBe("pending");
  });
  it("none: mensagem antiga sem status", () => {
    expect(chatMediaState({ ...base, created_at: "2026-11-09T11:40:00Z" }, NOW)).toBe("none");
  });
  it("none: URL pública (imagem da IA), texto e outros tipos", () => {
    expect(chatMediaState({ ...base, media_url: "https://x/y.jpg" }, NOW)).toBe("none");
    expect(chatMediaState({ ...base, media_type: "text" }, NOW)).toBe("none");
    expect(chatMediaState({ ...base, media_type: null }, NOW)).toBe("none");
    expect(chatMediaState({ ...base, media_type: "audio", media_url: "storage:customer-audio/a.mp4" }, NOW)).toBe("none");
  });
  it("aceita video e document", () => {
    expect(chatMediaState({ ...base, media_type: "video" }, NOW)).toBe("pending");
    expect(chatMediaState({ ...base, media_type: "document", media_url: "storage:chat-media/a/b/c.pdf" }, NOW)).toBe("stored");
  });
});

describe("formatBytes", () => {
  it("formata com vírgula decimal", () => {
    expect(formatBytes(1_258_291)).toBe("1,2 MB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(0)).toBe("0 B");
  });
  it("entradas inválidas viram string vazia", () => {
    expect(formatBytes(NaN)).toBe("");
    expect(formatBytes(-1)).toBe("");
  });
});

describe("isMediaPlaceholder", () => {
  it("reconhece os placeholders do webhook", () => {
    for (const c of ["[imagem]", "[video]", "[vídeo]", "[documento]", " [Imagem] "]) expect(isMediaPlaceholder(c)).toBe(true);
    expect(isMediaPlaceholder("olha essa foto")).toBe(false);
  });
});
