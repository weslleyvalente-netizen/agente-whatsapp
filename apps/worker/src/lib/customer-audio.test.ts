import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  getMessageById: vi.fn(), getConversationById: vi.fn(), getInstanceById: vi.fn(),
  setMessageMediaUrlIfEmpty: vi.fn(), listExpiredStoredAudioMessages: vi.fn(), clearMessageMediaUrls: vi.fn(),
}));
vi.mock("@aula-agente/database", () => m);
import { storeCustomerAudio, runCustomerAudioRetention } from "./customer-audio.js";

const job = { messageId: "msg", conversationId: "conv", organizationId: "org" };
const REF = "storage:customer-audio/org/conv/msg.mp4";

function makeDb(uploadResult: { error: { message: string; statusCode?: string } | null } = { error: null }) {
  const upload = vi.fn().mockResolvedValue(uploadResult);
  const remove = vi.fn().mockResolvedValue({ error: null });
  return { db: { storage: { from: vi.fn(() => ({ upload, remove })) } } as any, upload, remove };
}
const fetchAudio = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  m.getMessageById.mockResolvedValue({ id: "msg", organization_id: "org", conversation_id: "conv", role: "contact", media_type: "audio", media_url: null, evolution_message_id: "EVO1" });
  // O nome do campo é o da tabela real (conversations.evolution_instance_id); um nome errado aqui já derrubou toda a captura em produção.
  m.getConversationById.mockResolvedValue({ id: "conv", evolution_instance_id: "inst" });
  m.getInstanceById.mockImplementation(async (_db: unknown, id: string) => {
    if (id !== "inst") throw new Error(`instância não encontrada: ${id}`);
    return { instance_name: "minha-instancia" };
  });
  m.setMessageMediaUrlIfEmpty.mockResolvedValue(true);
  fetchAudio.mockResolvedValue({ base64: Buffer.from("abc").toString("base64"), mimetype: "audio/mp4" });
});

describe("storeCustomerAudio", () => {
  it("baixa da Evolution, sobe no bucket privado sem upsert e grava a referência", async () => {
    const { db, upload } = makeDb();
    const r = await storeCustomerAudio(db, job, fetchAudio);
    expect(r).toEqual({ ok: true, mediaUrl: REF });
    expect(fetchAudio).toHaveBeenCalledWith("minha-instancia", "EVO1");
    expect(db.storage.from).toHaveBeenCalledWith("customer-audio");
    expect(upload).toHaveBeenCalledWith("org/conv/msg.mp4", expect.any(Buffer), { contentType: "audio/mp4", upsert: false });
    expect(m.setMessageMediaUrlIfEmpty).toHaveBeenCalledWith(db, "msg", REF);
  });

  it("é idempotente: mensagem que já tem media_url não é refeita", async () => {
    m.getMessageById.mockResolvedValue({ id: "msg", role: "contact", media_type: "audio", media_url: REF, evolution_message_id: "EVO1" });
    const { db, upload } = makeDb();
    expect(await storeCustomerAudio(db, job, fetchAudio)).toEqual({ ok: true, skipped: "already_stored" });
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("ignora mensagens que não são áudio de cliente", async () => {
    m.getMessageById.mockResolvedValue({ id: "msg", role: "agent", media_type: "audio", media_url: null, evolution_message_id: "EVO1" });
    const { db } = makeDb();
    expect(await storeCustomerAudio(db, job, fetchAudio)).toEqual({ ok: true, skipped: "not_customer_audio" });
    expect(fetchAudio).not.toHaveBeenCalled();
  });

  it("falha no download não lança: devolve ok:false", async () => {
    fetchAudio.mockRejectedValue(new Error("Evolution media fetch error 404"));
    const { db, upload } = makeDb();
    const r = await storeCustomerAudio(db, job, fetchAudio);
    expect(r).toEqual({ ok: false, reason: "Evolution media fetch error 404" });
    expect(upload).not.toHaveBeenCalled();
    expect(m.setMessageMediaUrlIfEmpty).not.toHaveBeenCalled();
  });

  it("falha no upload não lança nem grava media_url", async () => {
    const { db } = makeDb({ error: { message: "boom" } });
    const r = await storeCustomerAudio(db, job, fetchAudio);
    expect(r).toEqual({ ok: false, reason: "boom" });
    expect(m.setMessageMediaUrlIfEmpty).not.toHaveBeenCalled();
  });

  it("arquivo já existente no bucket (retentativa após falha ao gravar) só grava a referência", async () => {
    const { db } = makeDb({ error: { message: "The resource already exists", statusCode: "409" } });
    expect(await storeCustomerAudio(db, job, fetchAudio)).toEqual({ ok: true, mediaUrl: REF });
    expect(m.setMessageMediaUrlIfEmpty).toHaveBeenCalledWith(db, "msg", REF);
  });

  it("áudio vazio é falha", async () => {
    fetchAudio.mockResolvedValue({ base64: "", mimetype: "audio/mp4" });
    const { db, upload } = makeDb();
    expect(await storeCustomerAudio(db, job, fetchAudio)).toEqual({ ok: false, reason: "empty_audio", permanent: true });
    expect(upload).not.toHaveBeenCalled();
  });

  it("sem evolution_message_id é falha permanente (sem retentativa)", async () => {
    m.getMessageById.mockResolvedValue({ id: "msg", organization_id: "org", conversation_id: "conv", role: "contact", media_type: "audio", media_url: null, evolution_message_id: null });
    const { db } = makeDb();
    expect(await storeCustomerAudio(db, job, fetchAudio)).toMatchObject({ ok: false, permanent: true });
  });

  it("arquivo acima do limite é ignorado sem subir nem repetir", async () => {
    fetchAudio.mockResolvedValue({ base64: Buffer.alloc(50 * 1024 * 1024 + 1).toString("base64"), mimetype: "audio/mp4" });
    const { db, upload } = makeDb();
    expect(await storeCustomerAudio(db, job, fetchAudio)).toEqual({ ok: true, skipped: "too_large" });
    expect(upload).not.toHaveBeenCalled();
    expect(m.setMessageMediaUrlIfEmpty).not.toHaveBeenCalled();
  });

  it("mimetype ausente assume audio/mp4", async () => {
    fetchAudio.mockResolvedValue({ base64: Buffer.from("abc").toString("base64"), mimetype: undefined });
    const { db, upload } = makeDb();
    expect(await storeCustomerAudio(db, job, fetchAudio)).toEqual({ ok: true, mediaUrl: REF });
    expect(upload).toHaveBeenCalledWith("org/conv/msg.mp4", expect.any(Buffer), { contentType: "audio/mp4", upsert: false });
  });
});

describe("runCustomerAudioRetention", () => {
  const now = new Date("2026-10-16T12:00:00Z");

  it("apaga do bucket os arquivos com mais de 90 dias e zera media_url", async () => {
    m.listExpiredStoredAudioMessages.mockResolvedValueOnce([
      { id: "a", organization_id: "o", conversation_id: "c", media_url: "storage:customer-audio/o/c/a.mp4" },
      { id: "b", organization_id: "o", conversation_id: "c", media_url: "storage:customer-audio/o/c/b.mp3" },
    ]);
    const { db, remove } = makeDb();
    const r = await runCustomerAudioRetention(db, now);
    expect(m.listExpiredStoredAudioMessages).toHaveBeenCalledWith(db, "storage:customer-audio/", "2026-07-18T12:00:00.000Z", 500);
    expect(remove).toHaveBeenCalledWith(["o/c/a.mp4", "o/c/b.mp3"]);
    expect(m.clearMessageMediaUrls).toHaveBeenCalledWith(db, ["a", "b"]);
    expect(r).toEqual({ deleted: 2 });
  });

  it("sem mensagens vencidas não mexe em nada", async () => {
    m.listExpiredStoredAudioMessages.mockResolvedValue([]);
    const { db, remove } = makeDb();
    expect(await runCustomerAudioRetention(db, now)).toEqual({ deleted: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(m.clearMessageMediaUrls).not.toHaveBeenCalled();
  });

  it("se a remoção no bucket falha, mantém media_url (tenta de novo no dia seguinte)", async () => {
    m.listExpiredStoredAudioMessages.mockResolvedValue([{ id: "a", organization_id: "o", conversation_id: "c", media_url: "storage:customer-audio/o/c/a.mp4" }]);
    const { db, remove } = makeDb();
    remove.mockResolvedValue({ error: { message: "x" } });
    await expect(runCustomerAudioRetention(db, now)).rejects.toThrow();
    expect(m.clearMessageMediaUrls).not.toHaveBeenCalled();
  });

  it("referência forjada (de outra org/conversa/mensagem) não apaga nada: só zera media_url", async () => {
    m.listExpiredStoredAudioMessages.mockResolvedValueOnce([
      { id: "a", organization_id: "o", conversation_id: "c", media_url: "storage:customer-audio/OUTRA/c/a.mp4" },
      { id: "b", organization_id: "o", conversation_id: "c", media_url: "storage:customer-audio/o/c/outra-msg.mp4" },
      { id: "d", organization_id: "o", conversation_id: "c", media_url: "storage:customer-audio/o/c/d.mp4" },
    ]);
    const { db, remove } = makeDb();
    expect(await runCustomerAudioRetention(db, now)).toEqual({ deleted: 3 });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(["o/c/d.mp4"]);
    expect(m.clearMessageMediaUrls).toHaveBeenCalledWith(db, ["a", "b", "d"]);
  });

  it("só referências forjadas: não chama remove", async () => {
    m.listExpiredStoredAudioMessages.mockResolvedValueOnce([{ id: "a", organization_id: "o", conversation_id: "c", media_url: "storage:customer-audio/x/y/z.mp4" }]);
    const { db, remove } = makeDb();
    await runCustomerAudioRetention(db, now);
    expect(remove).not.toHaveBeenCalled();
    expect(m.clearMessageMediaUrls).toHaveBeenCalledWith(db, ["a"]);
  });

  it("processa em lotes até esvaziar", async () => {
    const batch = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, organization_id: "o", conversation_id: "c", media_url: `storage:customer-audio/o/c/m${i}.mp4` }));
    m.listExpiredStoredAudioMessages.mockResolvedValueOnce(batch).mockResolvedValueOnce([{ id: "z", organization_id: "o", conversation_id: "c", media_url: "storage:customer-audio/o/c/z.mp4" }]);
    const { db } = makeDb();
    expect(await runCustomerAudioRetention(db, now)).toEqual({ deleted: 501 });
  });
});
