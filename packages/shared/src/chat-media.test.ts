import { describe, expect, it } from "vitest";
import {
  sanitizeDownloadName,
  CHAT_MEDIA_BUCKET,
  CHAT_MEDIA_REF_PREFIX,
  CHAT_MEDIA_MAX_BYTES,
  buildChatMediaRef,
  parseChatMediaRef,
  isChatMediaRefFor,
  extensionFromMime,
} from "./chat-media.js";

const ids = { organizationId: "org1", conversationId: "conv1", messageId: "msg1" };

describe("chat media ref", () => {
  it("constantes", () => {
    expect(CHAT_MEDIA_BUCKET).toBe("chat-media");
    expect(CHAT_MEDIA_REF_PREFIX).toBe("storage:chat-media/");
    expect(CHAT_MEDIA_MAX_BYTES).toEqual({ image: 16 * 1024 * 1024, video: 16 * 1024 * 1024, document: 25 * 1024 * 1024 });
  });

  it("round-trip build/parse", () => {
    const ref = buildChatMediaRef({ ...ids, extension: "pdf" });
    expect(ref).toBe("storage:chat-media/org1/conv1/msg1.pdf");
    expect(parseChatMediaRef(ref)).toEqual({ bucket: "chat-media", path: "org1/conv1/msg1.pdf" });
  });

  it("parse rejeita inválidos", () => {
    expect(parseChatMediaRef("storage:chat-media/../x")).toBeNull();
    expect(parseChatMediaRef("storage:chat-media/a//b")).toBeNull();
    expect(parseChatMediaRef("storage:customer-audio/x")).toBeNull();
    expect(parseChatMediaRef("")).toBeNull();
    expect(parseChatMediaRef(null)).toBeNull();
    expect(parseChatMediaRef(undefined)).toBeNull();
  });

  it("isChatMediaRefFor", () => {
    expect(isChatMediaRefFor(buildChatMediaRef({ ...ids, extension: "jpg" }), ids)).toBe(true);
    expect(isChatMediaRefFor(buildChatMediaRef({ ...ids, messageId: "other", extension: "jpg" }), ids)).toBe(false);
    expect(isChatMediaRefFor(buildChatMediaRef({ ...ids, organizationId: "org2", extension: "jpg" }), ids)).toBe(false);
    expect(isChatMediaRefFor("storage:chat-media/org1/conv1/msg1.mp4/../x", ids)).toBe(false);
    expect(isChatMediaRefFor("storage:chat-media/org1/conv1/msg1.mp4/..", ids)).toBe(false);
    expect(isChatMediaRefFor("storage:chat-media/org1/conv1/msg1.toolongext1", ids)).toBe(false);
    expect(isChatMediaRefFor("storage:chat-media/org1/conv1/msg1.PDF", ids)).toBe(false);
    expect(isChatMediaRefFor(null, ids)).toBe(false);
  });
});

describe("extensionFromMime", () => {
  it("mapeia mimes conhecidos", () => {
    expect(extensionFromMime("application/pdf")).toBe("pdf");
    expect(extensionFromMime("video/mp4")).toBe("mp4");
    expect(extensionFromMime("image/jpeg")).toBe("jpg");
    expect(extensionFromMime("image/png; charset=x")).toBe("png");
  });
  it("usa extensão do nome quando mime genérico", () => {
    expect(extensionFromMime("application/octet-stream", "a.docx")).toBe("docx");
  });
  it("desconhecido vira bin", () => {
    expect(extensionFromMime("application/octet-stream")).toBe("bin");
    expect(extensionFromMime("application/octet-stream", "semext")).toBe("bin");
  });
});

describe("sanitizeDownloadName", () => {
  it("remove caracteres que alteram a query ou o cabeçalho", () => {
    expect(sanitizeDownloadName("x&token=abc.pdf")).toBe("xtoken=abc.pdf");
    expect(sanitizeDownloadName("a#b.pdf")).toBe("ab.pdf");
    expect(sanitizeDownloadName('a"b?c%d;e:f*g<h>i|j.pdf')).toBe("abcdefghij.pdf");
  });
  it("fica só com o nome-base", () => {
    expect(sanitizeDownloadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadName("C:\\temp\\x.pdf")).toBe("x.pdf");
  });
  it("remove CR/LF e controles", () => {
    const r = sanitizeDownloadName("evil\r\nSet-Cookie: a=b.pdf");
    expect(r).toBe("evilSet-Cookie a=b.pdf");
    expect(r).not.toMatch(/[\r\n]/);
    expect(sanitizeDownloadName("a\u0000b\u007f.pdf")).toBe("ab.pdf");
  });
  it("limita a 120 caracteres mantendo a extensão", () => {
    const r = sanitizeDownloadName("a".repeat(300) + ".pdf")!;
    expect(r.length).toBe(120);
    expect(r.endsWith(".pdf")).toBe(true);
  });
  it("vazio, só espaços ou só pontos -> null", () => {
    for (const v of ["", "   ", null, undefined, "..", "&#?"]) expect(sanitizeDownloadName(v)).toBeNull();
  });
  it("preserva acentos e travessão e colapsa espaços", () => {
    expect(sanitizeDownloadName("Proposta João – nº 12.pdf")).toBe("Proposta João – nº 12.pdf");
    expect(sanitizeDownloadName("  a   b.pdf ")).toBe("a b.pdf");
  });
});
