import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  getMessageById: vi.fn(), getConversationById: vi.fn(), getInstanceById: vi.fn(),
  setMessageMediaUrlIfEmpty: vi.fn(), mergeMessageMetadata: vi.fn(),
  listExpiredStoredAudioMessages: vi.fn(), clearMessageMediaUrls: vi.fn(),
}));
vi.mock("@aula-agente/database", () => m);
import { storeChatMedia, runChatMediaRetention } from "./chat-media.js";

const job = { messageId: "msg", conversationId: "conv", organizationId: "org" };
const REF = "storage:chat-media/org/conv/msg.jpg";

function makeDb(uploadResult: { error: { message: string; statusCode?: string } | null } = { error: null }) {
  const upload = vi.fn().mockResolvedValue(uploadResult);
  const remove = vi.fn().mockResolvedValue({ error: null });
  return { db: { storage: { from: vi.fn(() => ({ upload, remove })) } } as any, upload, remove };
}
const fetchMedia = vi.fn();

function msg(over: Record<string, unknown> = {}) {
  return { id: "msg", organization_id: "org", conversation_id: "conv", role: "contact", media_type: "image", media_url: null, evolution_message_id: "EVO1", content: "", ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getMessageById.mockResolvedValue(msg());
  m.getConversationById.mockResolvedValue({ id: "conv", evolution_instance_id: "inst" });
  m.getInstanceById.mockResolvedValue({ instance_name: "minha-instancia" });
  m.setMessageMediaUrlIfEmpty.mockResolvedValue(true);
  fetchMedia.mockResolvedValue({ base64: Buffer.from("abc").toString("base64"), mimetype: "image/jpeg" });
});

describe("storeChatMedia", () => {
  it("imagem de contato: sobe no bucket, grava media_url e metadata stored", async () => {
    const { db, upload } = makeDb();
    expect(await storeChatMedia(db, job, fetchMedia)).toEqual({ ok: true, mediaUrl: REF });
    expect(fetchMedia).toHaveBeenCalledWith("minha-instancia", "EVO1");
    expect(db.storage.from).toHaveBeenCalledWith("chat-media");
    expect(upload).toHaveBeenCalledWith("org/conv/msg.jpg", expect.any(Buffer), { contentType: "image/jpeg", upsert: false });
    expect(m.setMessageMediaUrlIfEmpty).toHaveBeenCalledWith(db, "msg", REF);
    expect(m.mergeMessageMetadata).toHaveBeenCalledWith(db, "msg", { media: { status: "stored", mime_type: "image/jpeg", size_bytes: 3 } });
  });

  it("documento: file_name vem do Evolution, senão do content", async () => {
    m.getMessageById.mockResolvedValue(msg({ media_type: "document", content: "contrato.pdf" }));
    fetchMedia.mockResolvedValue({ base64: Buffer.from("abc").toString("base64"), mimetype: "application/pdf", fileName: "Contrato Final.pdf" });
    const { db, upload } = makeDb();
    expect(await storeChatMedia(db, job, fetchMedia)).toEqual({ ok: true, mediaUrl: "storage:chat-media/org/conv/msg.pdf" });
    expect(upload).toHaveBeenCalledWith("org/conv/msg.pdf", expect.any(Buffer), { contentType: "application/pdf", upsert: false });
    expect(m.mergeMessageMetadata).toHaveBeenCalledWith(db, "msg", { media: { status: "stored", mime_type: "application/pdf", size_bytes: 3, file_name: "Contrato Final.pdf" } });

    fetchMedia.mockResolvedValue({ base64: Buffer.from("abc").toString("base64"), mimetype: "application/pdf" });
    await storeChatMedia(db, job, fetchMedia);
    expect(m.mergeMessageMetadata).toHaveBeenLastCalledWith(db, "msg", { media: { status: "stored", mime_type: "application/pdf", size_bytes: 3, file_name: "contrato.pdf" } });
  });

  it("acima do limite do tipo: too_large, sem upload", async () => {
    fetchMedia.mockResolvedValue({ base64: Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64"), mimetype: "image/jpeg" });
    const { db, upload } = makeDb();
    expect(await storeChatMedia(db, job, fetchMedia)).toEqual({ ok: true, skipped: "too_large" });
    expect(upload).not.toHaveBeenCalled();
    expect(m.setMessageMediaUrlIfEmpty).not.toHaveBeenCalled();
    expect(m.mergeMessageMetadata).toHaveBeenCalledWith(db, "msg", { media: { status: "too_large", mime_type: "image/jpeg", size_bytes: 16 * 1024 * 1024 + 1 } });
  });

  it.each([[""], [undefined]])("base64 vazio/ausente (%s): falha permanente e status failed", async (b64) => {
    fetchMedia.mockResolvedValue({ base64: b64, mimetype: "image/jpeg" });
    const { db, upload } = makeDb();
    expect(await storeChatMedia(db, job, fetchMedia)).toMatchObject({ ok: false, permanent: true });
    expect(upload).not.toHaveBeenCalled();
    expect(m.mergeMessageMetadata).toHaveBeenCalledWith(db, "msg", { media: { status: "failed" } });
  });

  it("já com media_url: already_stored", async () => {
    m.getMessageById.mockResolvedValue(msg({ media_url: REF }));
    const { db, upload } = makeDb();
    expect(await storeChatMedia(db, job, fetchMedia)).toEqual({ ok: true, skipped: "already_stored" });
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([["agent", "image"], ["contact", "audio"], ["contact", null]])("role=%s media_type=%s: not_chat_media", async (role, mediaType) => {
    m.getMessageById.mockResolvedValue(msg({ role, media_type: mediaType }));
    const { db } = makeDb();
    expect(await storeChatMedia(db, job, fetchMedia)).toEqual({ ok: true, skipped: "not_chat_media" });
    expect(fetchMedia).not.toHaveBeenCalled();
  });

  it("upload 409 é sucesso", async () => {
    const { db } = makeDb({ error: { message: "The resource already exists", statusCode: "409" } });
    expect(await storeChatMedia(db, job, fetchMedia)).toEqual({ ok: true, mediaUrl: REF });
    expect(m.setMessageMediaUrlIfEmpty).toHaveBeenCalledWith(db, "msg", REF);
  });

  it("erro de upload e falha no download não lançam: ok:false transitório", async () => {
    const { db } = makeDb({ error: { message: "boom" } });
    expect(await storeChatMedia(db, job, fetchMedia)).toEqual({ ok: false, reason: "boom" });
    fetchMedia.mockRejectedValue(new Error("Evolution media fetch error 404"));
    expect(await storeChatMedia(db, job, fetchMedia)).toEqual({ ok: false, reason: "Evolution media fetch error 404" });
  });

  it("sem evolution_message_id: falha permanente", async () => {
    m.getMessageById.mockResolvedValue(msg({ evolution_message_id: null }));
    const { db } = makeDb();
    expect(await storeChatMedia(db, job, fetchMedia)).toEqual({ ok: false, reason: "missing_evolution_message_id", permanent: true });
  });
});

describe("runChatMediaRetention", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const row = (id: string, url: string) => ({ id, organization_id: "o", conversation_id: "c", media_url: url });

  it("apaga arquivos com mais de 30 dias, zera media_url e não toca metadata.media", async () => {
    m.listExpiredStoredAudioMessages.mockResolvedValueOnce([
      row("a", "storage:chat-media/o/c/a.jpg"), row("b", "storage:chat-media/o/c/b.pdf"),
    ]);
    const { db, remove } = makeDb();
    expect(await runChatMediaRetention(db, now)).toEqual({ deleted: 2 });
    expect(m.listExpiredStoredAudioMessages).toHaveBeenCalledWith(db, "storage:chat-media/", "2026-09-16T12:00:00.000Z", 500);
    expect(db.storage.from).toHaveBeenCalledWith("chat-media");
    expect(remove).toHaveBeenCalledWith(["o/c/a.jpg", "o/c/b.pdf"]);
    expect(m.clearMessageMediaUrls).toHaveBeenCalledWith(db, ["a", "b"]);
    expect(m.mergeMessageMetadata).not.toHaveBeenCalled();
  });

  it("referência forjada só tem media_url zerado, sem remove", async () => {
    m.listExpiredStoredAudioMessages.mockResolvedValueOnce([
      row("a", "storage:chat-media/OUTRA/c/a.jpg"), row("b", "storage:chat-media/o/c/outra.jpg"), row("d", "storage:chat-media/o/c/d.jpg"),
    ]);
    const { db, remove } = makeDb();
    expect(await runChatMediaRetention(db, now)).toEqual({ deleted: 3 });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(["o/c/d.jpg"]);
    expect(m.clearMessageMediaUrls).toHaveBeenCalledWith(db, ["a", "b", "d"]);
  });

  it("só forjadas: não chama remove", async () => {
    m.listExpiredStoredAudioMessages.mockResolvedValueOnce([row("a", "storage:chat-media/x/y/z.jpg")]);
    const { db, remove } = makeDb();
    await runChatMediaRetention(db, now);
    expect(remove).not.toHaveBeenCalled();
    expect(m.clearMessageMediaUrls).toHaveBeenCalledWith(db, ["a"]);
  });

  it("falha no remove lança e mantém media_url", async () => {
    m.listExpiredStoredAudioMessages.mockResolvedValue([row("a", "storage:chat-media/o/c/a.jpg")]);
    const { db, remove } = makeDb();
    remove.mockResolvedValue({ error: { message: "x" } });
    await expect(runChatMediaRetention(db, now)).rejects.toThrow();
    expect(m.clearMessageMediaUrls).not.toHaveBeenCalled();
  });

  it("sem vencidas não mexe em nada; lotes até esvaziar", async () => {
    m.listExpiredStoredAudioMessages.mockResolvedValueOnce([]);
    const a = makeDb();
    expect(await runChatMediaRetention(a.db, now)).toEqual({ deleted: 0 });
    const batch = Array.from({ length: 500 }, (_, i) => row(`m${i}`, `storage:chat-media/o/c/m${i}.jpg`));
    m.listExpiredStoredAudioMessages.mockResolvedValueOnce(batch).mockResolvedValueOnce([row("z", "storage:chat-media/o/c/z.jpg")]);
    const { db } = makeDb();
    expect(await runChatMediaRetention(db, now)).toEqual({ deleted: 501 });
  });
});
