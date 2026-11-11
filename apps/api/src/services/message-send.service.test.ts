import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  saveMessage,
  updateConversation,
  getInstanceById,
  createHandoffEvent,
  getOpenHandoffEvent,
  markFirstHumanReply,
  handleConversationTakeover,
  enqueueSendMessage,
  recordHumanMessage,
  setMessageMediaUrlIfEmpty,
  updateMessageContent,
  upload,
  remove,
  fakeDb,
} = vi.hoisted(() => {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const remove = vi.fn().mockResolvedValue({ error: null });
  return {
  fakeDb: { storage: { from: vi.fn(() => ({ upload, remove })) } },
  remove,
  setMessageMediaUrlIfEmpty: vi.fn().mockResolvedValue(true),
  updateMessageContent: vi.fn().mockResolvedValue(undefined),
  upload,
  recordHumanMessage: vi.fn().mockResolvedValue("assign-1"),
  saveMessage: vi.fn(),
  updateConversation: vi.fn().mockResolvedValue(undefined),
  getInstanceById: vi.fn(),
  createHandoffEvent: vi.fn().mockResolvedValue({ id: "handoff-1" }),
  getOpenHandoffEvent: vi.fn().mockResolvedValue(null),
  markFirstHumanReply: vi.fn().mockResolvedValue(undefined),
  handleConversationTakeover: vi.fn().mockResolvedValue(undefined),
  enqueueSendMessage: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./message.service.js", () => ({ saveMessage }));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => fakeDb,
  setMessageMediaUrlIfEmpty,
  updateMessageContent,
  updateConversation,
  getInstanceById,
  createHandoffEvent,
  getOpenHandoffEvent,
  markFirstHumanReply,
  recordHumanMessage,
}));
// Espião sobre a implementação real: verifica a chamada e também o filtro de origem humana de verdade.
vi.mock("./lead-human-message.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lead-human-message.js")>();
  return { trackFirstHumanMessage: vi.fn(actual.trackFirstHumanMessage) };
});
import { trackFirstHumanMessage } from "./lead-human-message.js";
vi.mock("./task.service.js", () => ({ handleConversationTakeover }));
vi.mock("../lib/queue.js", () => ({ enqueueSendMessage }));

import { sendPanelMessage, SellerAudioSendError, SellerAttachmentSendError } from "./message-send.service.js";

const baseConversation = {
  id: "conv-1",
  organization_id: "org-1",
  is_human_takeover: false,
  evolution_instance_id: "evo-inst-1",
  wa_contacts: { phone: "5511999999999" },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  saveMessage.mockResolvedValue({ id: "msg-1" });
  getInstanceById.mockResolvedValue({ id: "instance-1", instance_name: "loja-1" });
  getOpenHandoffEvent.mockResolvedValue(null);
});

describe("sendPanelMessage", () => {
  it("activates takeover on first send (default), reassigns task, and logs painel_manual", async () => {
    const result = await sendPanelMessage({
      conversation: baseConversation,
      content: "Oi!",
      actorUserId: "user-1",
    });

    expect(result.message.id).toBe("msg-1");
    expect(updateConversation).toHaveBeenCalledWith(
      fakeDb,
      "conv-1",
      expect.objectContaining({ is_human_takeover: true, assigned_to: "user-1" })
    );
    expect(handleConversationTakeover).toHaveBeenCalledWith(fakeDb, "org-1", "conv-1", "user-1");
    expect(createHandoffEvent).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ trigger_type: "painel_manual" }));
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", messageId: "msg-1", instanceId: "instance-1" }),
      undefined
    );
  });

  it("does not set assigned_to or re-reassign when takeover was already active", async () => {
    await sendPanelMessage({
      conversation: { ...baseConversation, is_human_takeover: true },
      content: "Oi de novo",
      actorUserId: "user-1",
    });

    expect(updateConversation).toHaveBeenCalledWith(
      fakeDb,
      "conv-1",
      expect.not.objectContaining({ assigned_to: expect.anything() })
    );
    expect(handleConversationTakeover).not.toHaveBeenCalled();
    expect(createHandoffEvent).not.toHaveBeenCalled();
  });

  it("skips all takeover/handoff bookkeeping when activateTakeover is false (follow-up-from-task default)", async () => {
    await sendPanelMessage({
      conversation: baseConversation,
      content: "Follow-up sugerido",
      actorUserId: "user-1",
      activateTakeover: false,
    });

    expect(updateConversation).not.toHaveBeenCalled();
    expect(handleConversationTakeover).not.toHaveBeenCalled();
    expect(createHandoffEvent).not.toHaveBeenCalled();
    expect(enqueueSendMessage).toHaveBeenCalled();
  });

  it("still closes an existing open requestHuman handoff loop even when activateTakeover is false", async () => {
    getOpenHandoffEvent.mockResolvedValue({ id: "open-handoff-1" });

    await sendPanelMessage({
      conversation: baseConversation,
      content: "Follow-up",
      actorUserId: "user-1",
      activateTakeover: false,
    });

    expect(markFirstHumanReply).toHaveBeenCalledWith(fakeDb, "open-handoff-1", expect.any(String));
  });

  it("passes metadata through to saveMessage", async () => {
    await sendPanelMessage({
      conversation: baseConversation,
      content: "Follow-up",
      actorUserId: "user-1",
      activateTakeover: false,
      metadata: { source: "task_followup", task_id: "task-1" },
    });

    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { source: "task_followup", task_id: "task-1" } })
    );
  });

  it("throws when saveMessage returns null (echo/duplicate)", async () => {
    saveMessage.mockResolvedValue(null);

    await expect(
      sendPanelMessage({ conversation: baseConversation, content: "Oi", actorUserId: "user-1" })
    ).rejects.toThrow();

    expect(enqueueSendMessage).not.toHaveBeenCalled();
  });

  // Point 2: follow-up-from-task opts out of BullMQ's own retry so an
  // ambiguous timeout can never resolve into a silent second send — the
  // confirmation flow is the only path allowed to send again, and only
  // with an explicit force.
  it("passes attempts: 1 to the queue when noAutoRetry is set", async () => {
    await sendPanelMessage({
      conversation: baseConversation,
      content: "Follow-up",
      actorUserId: "user-1",
      activateTakeover: false,
      noAutoRetry: true,
    });

    expect(enqueueSendMessage).toHaveBeenCalledWith(expect.anything(), { attempts: 1 });
  });

  it("does not override the queue's default retry behavior when noAutoRetry is not set", async () => {
    await sendPanelMessage({ conversation: baseConversation, content: "Oi", actorUserId: "user-1" });

    expect(enqueueSendMessage).toHaveBeenCalledWith(expect.anything(), undefined);
  });
});

describe("sendPanelMessage — primeira mensagem humana (distribuição de leads)", () => {
  // saveMessage devolve a linha gravada (role incluso); o papel vem dela.
  beforeEach(() => { saveMessage.mockResolvedValue({ id: "msg-1", role: "human_agent" }); });

  it("chama trackFirstHumanMessage com papel, autor e metadata, e o aceite vai como 'panel' do autor", async () => {
    await sendPanelMessage({ conversation: baseConversation, content: "Oi, sou a Marina", actorUserId: "user-1" });
    expect(trackFirstHumanMessage).toHaveBeenCalledWith(fakeDb, expect.objectContaining({
      organizationId: "org-1", conversationId: "conv-1", role: "human_agent", source: "panel", actorUserId: "user-1", metadata: null,
    }));
    expect(recordHumanMessage).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ organizationId: "org-1", conversationId: "conv-1", authorUserId: "user-1", via: "panel" }));
  });

  it("mensagem de follow-up de tarefa (metadata source=task_followup) ainda conta como humana", async () => {
    await sendPanelMessage({ conversation: baseConversation, content: "Passando para lembrar", actorUserId: "user-1", metadata: { source: "task_followup" } });
    expect(trackFirstHumanMessage).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ metadata: { source: "task_followup" }, actorUserId: "user-1" }));
    expect(recordHumanMessage).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ authorUserId: "user-1", via: "panel" }));
  });

  describe("com áudio do vendedor", () => {
    const audio = { buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]), extension: "webm" as const, durationSeconds: 7 };
    const REF = "storage:customer-audio/org-1/conv-1/msg-1.webm";

    it("salva, sobe, grava media_url e enfileira com storedAudioRef e attempts 1", async () => {
      await sendPanelMessage({ conversation: baseConversation, content: "[audio]", actorUserId: "user-1", audio });
      expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
        content: "[audio]", mediaType: "audio", role: "human_agent",
        metadata: { source: "seller_audio", duration_seconds: 7 },
      }));
      expect(fakeDb.storage.from).toHaveBeenCalledWith("customer-audio");
      expect(upload).toHaveBeenCalledWith("org-1/conv-1/msg-1.webm", audio.buffer, { contentType: "audio/webm", upsert: false });
      expect(setMessageMediaUrlIfEmpty).toHaveBeenCalledWith(fakeDb, "msg-1", REF);
      expect(enqueueSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "msg-1", storedAudioRef: REF }),
        { attempts: 1 }
      );
      expect(upload.mock.invocationCallOrder[0]).toBeLessThan(enqueueSendMessage.mock.invocationCallOrder[0]);
    });

    it("upload falhando marca send_failed_at, lança e não enfileira", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      upload.mockResolvedValueOnce({ error: new Error("storage down") });
      await expect(sendPanelMessage({ conversation: baseConversation, content: "[audio]", actorUserId: "user-1", audio })).rejects.toThrow();
      expect(updateMessageContent).toHaveBeenCalledWith(fakeDb, "msg-1", "[audio]", expect.objectContaining({ source: "seller_audio", send_failed_at: expect.any(String) }));
      expect(enqueueSendMessage).not.toHaveBeenCalled();
      expect(updateConversation).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it.each([
      ["enqueue", () => enqueueSendMessage.mockRejectedValueOnce(new Error("redis"))],
      ["getInstanceById", () => getInstanceById.mockRejectedValueOnce(new Error("db"))],
      ["updateConversation", () => updateConversation.mockRejectedValueOnce(new Error("db"))],
    ])("falha em %s após o upload marca send_failed_at e propaga com uploaded=true", async (_n, arm) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      arm();
      const err = await sendPanelMessage({ conversation: baseConversation, content: "[audio]", actorUserId: "user-1", audio }).catch((e) => e);
      expect(err).toBeInstanceOf(SellerAudioSendError);
      expect(err.uploaded).toBe(true);
      expect(updateMessageContent).toHaveBeenCalledWith(fakeDb, "msg-1", "[audio]", expect.objectContaining({ send_failed_at: expect.any(String) }));
      log.mockRestore();
    });

    it("falha de upload propaga com uploaded=false", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      upload.mockResolvedValueOnce({ error: new Error("x") });
      const err = await sendPanelMessage({ conversation: baseConversation, content: "[audio]", actorUserId: "user-1", audio }).catch((e) => e);
      expect(err).toBeInstanceOf(SellerAudioSendError);
      expect(err.uploaded).toBe(false);
      log.mockRestore();
    });

    it("media_url não gravado também falha sem enfileirar", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      setMessageMediaUrlIfEmpty.mockResolvedValueOnce(false);
      await expect(sendPanelMessage({ conversation: baseConversation, content: "[audio]", actorUserId: "user-1", audio })).rejects.toThrow();
      expect(updateMessageContent).toHaveBeenCalled();
      expect(enqueueSendMessage).not.toHaveBeenCalled();
      log.mockRestore();
    });
  });

  describe("com anexo do vendedor", () => {
    const attachment = {
      buffer: Buffer.from([0xff, 0xd8, 0xff, 1, 2]),
      kind: "image" as "image" | "video" | "document",
      mime: "image/jpeg",
      extension: "jpg",
      fileName: "foto.jpg",
    };
    const REF = "storage:chat-media/org-1/conv-1/msg-1.jpg";
    const send = (a: Partial<typeof attachment> & { caption?: string } = {}, conv = baseConversation) =>
      sendPanelMessage({ conversation: conv, content: "ignorado", actorUserId: "user-1", attachment: { ...attachment, ...a } });

    it("salva, sobe em chat-media, grava media_url e enfileira com os campos do anexo e attempts 1", async () => {
      await send({ caption: "Segue a foto" });
      expect(saveMessage).toHaveBeenCalledWith(expect.objectContaining({
        content: "Segue a foto", mediaType: "image", role: "human_agent",
        metadata: { source: "seller_attachment", media: { status: "stored", file_name: "foto.jpg", mime_type: "image/jpeg", size_bytes: 5 } },
      }));
      expect(fakeDb.storage.from).toHaveBeenCalledWith("chat-media");
      expect(upload).toHaveBeenCalledWith("org-1/conv-1/msg-1.jpg", attachment.buffer, { contentType: "image/jpeg", upsert: false });
      expect(setMessageMediaUrlIfEmpty).toHaveBeenCalledWith(fakeDb, "msg-1", REF);
      expect(enqueueSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "msg-1", content: "Segue a foto", storedMediaRef: REF,
          mediaFileName: "foto.jpg", mediaMime: "image/jpeg", mediaKind: "image",
        }),
        { attempts: 1 }
      );
      expect(upload.mock.invocationCallOrder[0]).toBeLessThan(enqueueSendMessage.mock.invocationCallOrder[0]);
    });

    it("sem legenda: [imagem], [video] ou o nome do arquivo", async () => {
      await send();
      expect(saveMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: "[imagem]" }));
      await send({ kind: "video", mime: "video/mp4", extension: "mp4", fileName: "v.mp4" });
      expect(saveMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: "[video]", mediaType: "video" }));
      await send({ kind: "document", mime: "application/pdf", extension: "pdf", fileName: "proposta.pdf" });
      expect(saveMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: "proposta.pdf", mediaType: "document" }));
    });

    it("takeover e handoff idênticos ao envio de texto", async () => {
      await send();
      expect(updateConversation).toHaveBeenCalledWith(fakeDb, "conv-1", expect.objectContaining({ is_human_takeover: true, assigned_to: "user-1" }));
      expect(handleConversationTakeover).toHaveBeenCalledWith(fakeDb, "org-1", "conv-1", "user-1");
      expect(createHandoffEvent).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ trigger_type: "painel_manual" }));
      expect(recordHumanMessage).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ authorUserId: "user-1", via: "panel" }));
    });

    it("não refaz takeover quando já ativo", async () => {
      await send({}, { ...baseConversation, is_human_takeover: true });
      expect(handleConversationTakeover).not.toHaveBeenCalled();
      expect(createHandoffEvent).not.toHaveBeenCalled();
    });

    it("upload falhando marca send_failed_at, lança uploaded=false e não enfileira", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      upload.mockResolvedValueOnce({ error: new Error("storage down") });
      const err = await send().catch((e) => e);
      expect(err).toBeInstanceOf(SellerAttachmentSendError);
      expect(err.uploaded).toBe(false);
      expect(updateMessageContent).toHaveBeenCalledWith(fakeDb, "msg-1", "[imagem]", expect.objectContaining({ source: "seller_attachment", send_failed_at: expect.any(String) }));
      expect(enqueueSendMessage).not.toHaveBeenCalled();
      expect(updateConversation).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it("falha ao enfileirar depois do upload lança uploaded=true e marca send_failed_at", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      enqueueSendMessage.mockRejectedValueOnce(new Error("redis"));
      const err = await send().catch((e) => e);
      expect(err).toBeInstanceOf(SellerAttachmentSendError);
      expect(err.uploaded).toBe(true);
      expect(updateMessageContent).toHaveBeenCalledWith(fakeDb, "msg-1", "[imagem]", expect.objectContaining({ send_failed_at: expect.any(String) }));
      log.mockRestore();
    });

    it("com legenda: o job leva caption com o texto", async () => {
      await send({ caption: "Segue a proposta" });
      expect(enqueueSendMessage).toHaveBeenCalledWith(expect.objectContaining({ caption: "Segue a proposta" }), { attempts: 1 });
    });

    it("sem legenda: o job não tem a chave caption e content é o placeholder", async () => {
      await send();
      const job = enqueueSendMessage.mock.calls[0][0];
      expect("caption" in job).toBe(false);
      expect(job.content).toBe("[imagem]");
      await send({ kind: "document", mime: "application/pdf", extension: "pdf", fileName: "proposta.pdf" });
      const doc = enqueueSendMessage.mock.calls[1][0];
      expect("caption" in doc).toBe(false);
      expect(doc.content).toBe("proposta.pdf");
    });

    it("media_url não gravado remove o objeto recém-enviado", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      setMessageMediaUrlIfEmpty.mockResolvedValueOnce(false);
      await expect(send()).rejects.toBeInstanceOf(SellerAttachmentSendError);
      expect(remove).toHaveBeenCalledWith(["org-1/conv-1/msg-1.jpg"]);
      log.mockRestore();
    });

    it("setMessageMediaUrlIfEmpty lançando também remove o objeto", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      setMessageMediaUrlIfEmpty.mockRejectedValueOnce(new Error("db"));
      const err = await send().catch((e) => e);
      expect(err).toBeInstanceOf(SellerAttachmentSendError);
      expect(err.uploaded).toBe(true);
      expect(remove).toHaveBeenCalledWith(["org-1/conv-1/msg-1.jpg"]);
      log.mockRestore();
    });

    it("erro na remoção não mascara o erro original", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      setMessageMediaUrlIfEmpty.mockResolvedValueOnce(false);
      remove.mockRejectedValueOnce(new Error("storage down"));
      const err = await send().catch((e) => e);
      expect(err).toBeInstanceOf(SellerAttachmentSendError);
      expect(err.message).toBe("Falha ao enviar o anexo");
      log.mockRestore();
    });

    it("upload falho ou falha ao enfileirar não removem o objeto", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      upload.mockResolvedValueOnce({ error: new Error("x") });
      await send().catch(() => {});
      enqueueSendMessage.mockRejectedValueOnce(new Error("redis"));
      await send().catch(() => {});
      expect(remove).not.toHaveBeenCalled();
      log.mockRestore();
    });

    it("media_url não gravado falha sem enfileirar", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      setMessageMediaUrlIfEmpty.mockResolvedValueOnce(false);
      await expect(send()).rejects.toBeInstanceOf(SellerAttachmentSendError);
      expect(enqueueSendMessage).not.toHaveBeenCalled();
      log.mockRestore();
    });
  });

  it("falha ao registrar não derruba o envio", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    recordHumanMessage.mockRejectedValueOnce(new Error("rpc down"));
    const result = await sendPanelMessage({ conversation: baseConversation, content: "Oi", actorUserId: "user-1" });
    expect(result.message.id).toBe("msg-1");
    expect(enqueueSendMessage).toHaveBeenCalled();
    log.mockRestore();
  });
});
