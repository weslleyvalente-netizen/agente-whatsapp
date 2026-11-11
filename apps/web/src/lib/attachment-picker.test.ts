import { describe, expect, it } from "vitest";
import { validateAttachmentFile, firstFileOf, attachmentErrorMessage } from "./attachment-picker";

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

describe("validateAttachmentFile: limites e nomes", () => {
  it("exatamente 16 MB (imagem) ok; 16 MB + 1 recusa", () => {
    expect(validateAttachmentFile(f("a.png", 16 * MB))).toEqual({ ok: true, kind: "image" });
    expect(validateAttachmentFile(f("a.png", 16 * MB + 1))).toEqual({ ok: false, error: "Arquivo acima de 16 MB" });
  });
  it("exatamente 25 MB (documento) ok; 25 MB + 1 recusa", () => {
    expect(validateAttachmentFile(f("a.pdf", 25 * MB))).toEqual({ ok: true, kind: "document" });
    expect(validateAttachmentFile(f("a.pdf", 25 * MB + 1))).toEqual({ ok: false, error: "Arquivo acima de 25 MB" });
  });
  it(".jpeg ok; nomes '.' e 'a.' recusados", () => {
    expect(validateAttachmentFile(f("a.jpeg", MB))).toEqual({ ok: true, kind: "image" });
    const bad = { ok: false, error: "Tipo de arquivo não suportado" };
    expect(validateAttachmentFile(f(".", MB))).toEqual(bad);
    expect(validateAttachmentFile(f("a.", MB))).toEqual(bad);
  });
});

describe("attachmentErrorMessage", () => {
  it("erro de rede vira mensagem em português", () => {
    expect(attachmentErrorMessage(new TypeError("Failed to fetch"))).toBe("Sem conexão. Tente de novo.");
  });
  it("mantém a mensagem da API e usa padrão para o resto", () => {
    expect(attachmentErrorMessage(new Error("Arquivo inválido"))).toBe("Arquivo inválido");
    expect(attachmentErrorMessage("x")).toBe("Erro ao enviar o anexo");
  });
});

describe("firstFileOf", () => {
  it("pega o primeiro e avisa quando há vários", () => {
    expect(firstFileOf(["a", "b"])).toEqual({ file: "a", multiple: true });
    expect(firstFileOf(["a"])).toEqual({ file: "a", multiple: false });
    expect(firstFileOf([])).toEqual({ file: null, multiple: false });
  });
});
