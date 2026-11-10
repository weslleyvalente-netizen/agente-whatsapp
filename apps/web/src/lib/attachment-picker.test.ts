import { describe, expect, it } from "vitest";
import { validateAttachmentFile, firstFileOf } from "./attachment-picker";

const MB = 1024 * 1024;
const f = (name: string, size: number, type = "") => ({ name, size, type });

describe("validateAttachmentFile", () => {
  it("imagem .JPG de 3 MB é ok", () => {
    expect(validateAttachmentFile(f("foto.JPG", 3 * MB))).toEqual({ ok: true, kind: "image" });
  });
  it("vídeo de 17 MB passa do limite de 16 MB", () => {
    expect(validateAttachmentFile(f("video.mp4", 17 * MB))).toEqual({ ok: false, error: "Arquivo acima de 16 MB" });
  });
  it("documento de 20 MB é ok (limite 25 MB)", () => {
    expect(validateAttachmentFile(f("planilha.xlsx", 20 * MB))).toEqual({ ok: true, kind: "document" });
    expect(validateAttachmentFile(f("grande.pdf", 26 * MB))).toEqual({ ok: false, error: "Arquivo acima de 25 MB" });
  });
  it("tipos não suportados", () => {
    const bad = { ok: false, error: "Tipo de arquivo não suportado" };
    expect(validateAttachmentFile(f("script.exe", 1000))).toEqual(bad);
    expect(validateAttachmentFile(f("semextensao", 1000))).toEqual(bad);
    expect(validateAttachmentFile(f("a.pdf.exe", 1000))).toEqual(bad);
    expect(validateAttachmentFile(f(".pdf", 1000))).toEqual(bad);
  });
  it("arquivo vazio é recusado", () => {
    expect(validateAttachmentFile(f("a.png", 0))).toEqual({ ok: false, error: "Arquivo vazio" });
  });
  it("reconhece vídeo mov e documentos", () => {
    expect(validateAttachmentFile(f("a.MOV", MB))).toEqual({ ok: true, kind: "video" });
    expect(validateAttachmentFile(f("a.csv", MB))).toEqual({ ok: true, kind: "document" });
  });
});

describe("firstFileOf", () => {
  it("pega o primeiro e avisa quando há vários", () => {
    expect(firstFileOf(["a", "b"])).toEqual({ file: "a", multiple: true });
    expect(firstFileOf(["a"])).toEqual({ file: "a", multiple: false });
    expect(firstFileOf([])).toEqual({ file: null, multiple: false });
  });
});
