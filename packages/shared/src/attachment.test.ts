import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMIT_PER_HOUR, detectAttachmentFormat } from "./attachment.js";

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const WEBP = cat(text("RIFF"), bytes(0, 0, 0, 0), text("WEBP"));
const MP4 = cat(bytes(0, 0, 0, 0x18), text("ftypisom"));
const MOV = cat(bytes(0, 0, 0, 0x14), text("ftypqt  "));
const PDF = text("%PDF-1.7\n");
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0);
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

describe("detectAttachmentFormat", () => {
  it("define o limite por hora", () => {
    expect(ATTACHMENT_LIMIT_PER_HOUR).toBe(60);
  });

  it("reconhece imagens", () => {
    expect(detectAttachmentFormat(JPEG, "foto.jpg")).toEqual({ kind: "image", mime: "image/jpeg", extension: "jpg" });
    expect(detectAttachmentFormat(JPEG, "foto.jpeg")).toEqual({ kind: "image", mime: "image/jpeg", extension: "jpg" });
    expect(detectAttachmentFormat(PNG, "a.png")).toEqual({ kind: "image", mime: "image/png", extension: "png" });
    expect(detectAttachmentFormat(WEBP, "a.webp")).toEqual({ kind: "image", mime: "image/webp", extension: "webp" });
  });

  it("aceita extensão em maiúsculas", () => {
    expect(detectAttachmentFormat(JPEG, "FOTO.JPG")?.mime).toBe("image/jpeg");
  });

  it("reconhece vídeos pela caixa ftyp", () => {
    expect(detectAttachmentFormat(MP4, "v.mp4")).toEqual({ kind: "video", mime: "video/mp4", extension: "mp4" });
    expect(detectAttachmentFormat(MOV, "v.mov")).toEqual({ kind: "video", mime: "video/quicktime", extension: "mov" });
  });

  it("reconhece documentos", () => {
    expect(detectAttachmentFormat(PDF, "a.pdf")).toEqual({ kind: "document", mime: "application/pdf", extension: "pdf" });
    expect(detectAttachmentFormat(ZIP, "a.docx")?.extension).toBe("docx");
    expect(detectAttachmentFormat(ZIP, "a.xlsx")?.extension).toBe("xlsx");
    expect(detectAttachmentFormat(ZIP, "a.pptx")?.extension).toBe("pptx");
    expect(detectAttachmentFormat(OLE, "a.doc")?.extension).toBe("doc");
    expect(detectAttachmentFormat(OLE, "a.xls")?.extension).toBe("xls");
    expect(detectAttachmentFormat(OLE, "a.ppt")?.extension).toBe("ppt");
    expect(detectAttachmentFormat(text("a,b\n1,2\n"), "a.csv")).toEqual({ kind: "document", mime: "text/csv", extension: "csv" });
    expect(detectAttachmentFormat(text("olá"), "a.txt")).toEqual({ kind: "document", mime: "text/plain", extension: "txt" });
  });

  it("rejeita divergência entre extensão e bytes", () => {
    expect(detectAttachmentFormat(PNG, "a.pdf")).toBeNull();
    expect(detectAttachmentFormat(PNG, "a.jpg")).toBeNull();
    expect(detectAttachmentFormat(ZIP, "a.pdf")).toBeNull();
    expect(detectAttachmentFormat(ZIP, "a.zip")).toBeNull();
    expect(detectAttachmentFormat(OLE, "a.docx")).toBeNull();
    expect(detectAttachmentFormat(MP4, "v.mov")).toBeNull();
    expect(detectAttachmentFormat(PDF, "a")).toBeNull();
  });

  it("rejeita executáveis, vazio e texto com NUL", () => {
    expect(detectAttachmentFormat(text("MZ\u0090\u0000"), "a.exe")).toBeNull();
    expect(detectAttachmentFormat(text("MZ\u0090\u0000"), "a.txt")).toBeNull();
    expect(detectAttachmentFormat(new Uint8Array(0), "a.txt")).toBeNull();
    expect(detectAttachmentFormat(new Uint8Array(0), "a.png")).toBeNull();
    expect(detectAttachmentFormat(bytes(0x61, 0, 0x62), "a.txt")).toBeNull();
  });
  it("não deixa extensões do protótipo de Object casarem", () => {
    for (const name of ["a.constructor", "a.__proto__", "a.toString", "a.hasOwnProperty", "a.valueOf"]) {
      expect(detectAttachmentFormat(ZIP, name)).toBeNull();
      expect(detectAttachmentFormat(OLE, name)).toBeNull();
      expect(detectAttachmentFormat(text("oi"), name)).toBeNull();
    }
  });

  it("devolve mime sempre string nos casos aceitos", () => {
    const cases: Array<[Uint8Array, string]> = [
      [JPEG, "a.jpg"], [PNG, "a.png"], [WEBP, "a.webp"], [MP4, "a.mp4"], [MOV, "a.mov"], [PDF, "a.pdf"],
      [ZIP, "a.docx"], [OLE, "a.xls"], [text("x"), "a.txt"], [text("x"), "a.csv"],
    ];
    for (const [b, n] of cases) {
      const r = detectAttachmentFormat(b, n);
      expect(r).not.toBeNull();
      expect(typeof r?.mime).toBe("string");
      expect(typeof r?.extension).toBe("string");
    }
  });

  it("rejeita buffers truncados", () => {
    expect(detectAttachmentFormat(bytes(0xff, 0xd8), "a.jpg")).toBeNull();
    expect(detectAttachmentFormat(text("RIFF"), "a.webp")).toBeNull();
    expect(detectAttachmentFormat(cat(text("RIFF"), bytes(0, 0, 0, 0), text("WAVE")), "a.webp")).toBeNull();
    expect(detectAttachmentFormat(cat(bytes(0, 0, 0, 0x14), text("ftyp")), "a.mp4")).toBeNull();
  });

  it("rejeita marca qt com .mp4 e texto/pdf-dupla-extensão", () => {
    expect(detectAttachmentFormat(MOV, "v.mp4")).toBeNull();
    expect(detectAttachmentFormat(text("texto puro"), "a.pdf")).toBeNull();
    expect(detectAttachmentFormat(PDF, "a.pdf.exe")).toBeNull();
  });

  it("só examina os primeiros 8 KB em busca de NUL", () => {
    const late = new Uint8Array(9000).fill(0x61);
    late[8192] = 0;
    expect(detectAttachmentFormat(late, "a.txt")?.extension).toBe("txt");
    const early = new Uint8Array(9000).fill(0x61);
    early[100] = 0;
    expect(detectAttachmentFormat(early, "a.txt")).toBeNull();
  });

  it("rejeita nomes sem nome-base ou extensão vazia", () => {
    expect(detectAttachmentFormat(text("x"), "a.")).toBeNull();
    expect(detectAttachmentFormat(text("x"), ".")).toBeNull();
    expect(detectAttachmentFormat(text("x"), ".txt")).toBeNull();
    expect(detectAttachmentFormat(PDF, ".pdf")).toBeNull();
  });
});
