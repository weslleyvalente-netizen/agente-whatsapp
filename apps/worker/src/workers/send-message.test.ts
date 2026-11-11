import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getAdminClient, getInstanceById, setMessageEvolutionId, updateMessageContent, download, createSignedUrl } = vi.hoisted(() => ({
  createSignedUrl: vi.fn(),
  getAdminClient: vi.fn(),
  updateMessageContent: vi.fn().mockResolvedValue(undefined),
  download: vi.fn(),
  getInstanceById: vi.fn(),
  setMessageEvolutionId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@aula-agente/database", () => ({
  shouldCancelPreFreezeAgentMessage:vi.fn().mockResolvedValue(false),
  syncSalesPipeline: vi.fn().mockResolvedValue(null),
  hasFrozenContact: vi.fn().mockResolvedValue(false), getAdminClient, getInstanceById, setMessageEvolutionId, updateMessageContent, getMessageById: vi.fn().mockResolvedValue(null), getConversationById: vi.fn() }));

import * as database from "@aula-agente/database";
import { processSendMessageJob } from "./send-message.js";

const originalFetch = global.fetch;

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("processSendMessageJob", () => {
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = "https://evolution.test";
    process.env.EVOLUTION_API_KEY = "test-key";
    getInstanceById.mockResolvedValue({ instance_name: "loja-1" });
    setMessageEvolutionId.mockClear();
    updateMessageContent.mockClear();
    download.mockReset();
    createSignedUrl.mockReset();
    getAdminClient.mockImplementation(() => ({ storage: { from: vi.fn(() => ({ download, createSignedUrl })) } }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("backfills evolution_message_id after a successful text send", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ key: { id: "EVO-TEXT-1" } })) as never;

    await processSendMessageJob({
      data: {
        conversationId: "conv-1",
        messageId: "msg-1",
        instanceId: "inst-1",
        phone: "5511999999999",
        content: "oi",
        organizationId: "org-1",
      },
    } as never);

    expect(setMessageEvolutionId).toHaveBeenCalledWith(expect.anything(), "msg-1", "EVO-TEXT-1");
  });

  it("backfills evolution_message_id after a successful media send", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ key: { id: "EVO-MEDIA-1" } })) as never;

    await processSendMessageJob({
      data: {
        conversationId: "conv-1",
        messageId: "msg-2",
        instanceId: "inst-1",
        phone: "5511999999999",
        content: "legenda",
        organizationId: "org-1",
        mediaUrl: "https://example.com/foto.jpg",
      },
    } as never);

    expect(setMessageEvolutionId).toHaveBeenCalledWith(expect.anything(), "msg-2", "EVO-MEDIA-1");
  });

  it("backfills using the text fallback's id when audio send fails", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, false)) // audio fails
      .mockResolvedValueOnce(jsonResponse({ key: { id: "EVO-FALLBACK-1" } })) as never; // text fallback

    await processSendMessageJob({
      data: {
        conversationId: "conv-1",
        messageId: "msg-3",
        instanceId: "inst-1",
        phone: "5511999999999",
        content: "oi",
        organizationId: "org-1",
        audioBase64: "base64audio",
      },
    } as never);

    expect(setMessageEvolutionId).toHaveBeenCalledWith(expect.anything(), "msg-3", "EVO-FALLBACK-1");
  });

  it("does not throw and skips the backfill when the Evolution response has no key.id", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({})) as never;

    await expect(
      processSendMessageJob({
        data: {
          conversationId: "conv-1",
          messageId: "msg-4",
          instanceId: "inst-1",
          phone: "5511999999999",
          content: "oi",
          organizationId: "org-1",
        },
      } as never)
    ).resolves.not.toThrow();

    expect(setMessageEvolutionId).not.toHaveBeenCalled();
  });
  describe("stored attachment (storedMediaRef)", () => {
    const ref = "storage:chat-media/org-1/conv-1/msg-media.pdf";
    const baseData = {
      conversationId: "conv-1",
      messageId: "msg-media",
      instanceId: "inst-1",
      phone: "5511999999999",
      content: "proposta.pdf",
      organizationId: "org-1",
      storedMediaRef: ref,
      mediaFileName: "proposta.pdf",
      mediaMime: "application/pdf",
      mediaKind: "document",
    };
    const mediaJob = (over: Record<string, unknown> = {}) => ({ data: { ...baseData, ...over } }) as never;

    beforeEach(() => {
      vi.mocked(database.getMessageById).mockResolvedValue({
        id: "msg-media", organization_id: "org-1", conversation_id: "conv-1", role: "human_agent",
        content: "proposta.pdf", metadata: { source: "seller_media" },
      } as never);
      createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://signed.test/x?token=1" }, error: null });
    });
    afterEach(() => {
      vi.mocked(database.getMessageById).mockResolvedValue(null as never);
    });

    it("signs the chat-media path for 300s and sends a document via sendMedia", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ key: { id: "EVO-MEDIA-1" } }));
      global.fetch = fetchMock as never;

      await processSendMessageJob(mediaJob({ caption: "segue" }));

      expect(createSignedUrl).toHaveBeenCalledWith("org-1/conv-1/msg-media.pdf", 300);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://evolution.test/message/sendMedia/loja-1");
      expect(JSON.parse(init.body)).toEqual({
        number: "5511999999999", mediatype: "document", media: "https://signed.test/x?token=1",
        caption: "segue", fileName: "proposta.pdf", mimetype: "application/pdf",
      });
      expect(setMessageEvolutionId).toHaveBeenCalledWith(expect.anything(), "msg-media", "EVO-MEDIA-1");
      expect(updateMessageContent).not.toHaveBeenCalled();
    });

    it("sends an image without caption or fileName when the seller typed none", async () => {
      vi.mocked(database.getMessageById).mockResolvedValue({
        id: "msg-media", organization_id: "org-1", conversation_id: "conv-1", role: "human_agent",
        content: "[imagem]", metadata: null,
      } as never);
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ key: { id: "EVO-IMG" } }));
      global.fetch = fetchMock as never;

      await processSendMessageJob(mediaJob({
        storedMediaRef: "storage:chat-media/org-1/conv-1/msg-media.jpg",
        content: "[imagem]", mediaKind: "image", mediaMime: "image/jpeg", mediaFileName: "foto.jpg",
      }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.mediatype).toBe("image");
      expect(body.caption ?? "").toBe("");
      expect(body.fileName).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("[imagem]");
    });

    it("uses the job caption exactly, and never the [imagem] content placeholder", async () => {
      const imgData = { storedMediaRef: "storage:chat-media/org-1/conv-1/msg-media.jpg", content: "[imagem]", mediaKind: "image", mediaMime: "image/jpeg", mediaFileName: "foto.jpg" };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ key: { id: "E" } }));
      global.fetch = fetchMock as never;
      await processSendMessageJob(mediaJob(imgData));
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).caption ?? "").toBe("");
      await processSendMessageJob(mediaJob({ ...imgData, content: "Segue a proposta", caption: "Segue a proposta" }));
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).caption).toBe("Segue a proposta");
    });

    it("redacts the signed URL from the error when Evolution echoes it", async () => {
      const signed = "https://signed.test/x?token=1";
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: `bad media ${signed}` }), text: async () => `bad media ${signed}` });
      global.fetch = fetchMock as never;

      const err = await processSendMessageJob(mediaJob()).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).not.toContain(signed);
      expect(String(err.message)).not.toContain("token=1");
      expect(updateMessageContent).toHaveBeenCalledWith(
        expect.anything(), "msg-media", "proposta.pdf",
        expect.objectContaining({ send_failed_at: expect.any(String) }),
      );
    });

    it("falls back to a neutral file name with the ref extension for documents", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ key: { id: "E" } }));
      global.fetch = fetchMock as never;

      await processSendMessageJob(mediaJob({ mediaFileName: undefined }));

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).fileName).toBe("arquivo.pdf");
    });

    it("signing failure marks send_failed_at, rethrows and never calls Evolution", async () => {
      createSignedUrl.mockResolvedValue({ data: null, error: { message: "nope" } });
      const fetchMock = vi.fn();
      global.fetch = fetchMock as never;

      await expect(processSendMessageJob(mediaJob())).rejects.toThrow();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMessageContent).toHaveBeenCalledWith(
        expect.anything(), "msg-media", "proposta.pdf",
        expect.objectContaining({ source: "seller_media", send_failed_at: expect.any(String) }),
      );
    });

    it("Evolution error marks send_failed_at, rethrows and never sends text", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, false));
      global.fetch = fetchMock as never;

      await expect(processSendMessageJob(mediaJob())).rejects.toThrow(/media send error/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).not.toContain("sendText");
      expect(updateMessageContent).toHaveBeenCalledWith(
        expect.anything(), "msg-media", "proposta.pdf",
        expect.objectContaining({ send_failed_at: expect.any(String) }),
      );
    });

    it("invalid ref counts as failure without signing", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as never;

      await expect(processSendMessageJob(mediaJob({ storedMediaRef: "garbage" }))).rejects.toThrow();

      expect(createSignedUrl).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMessageContent).toHaveBeenCalled();
    });

    it("ref from another conversation is rejected without signing", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as never;

      await expect(processSendMessageJob(mediaJob({
        storedMediaRef: "storage:chat-media/org-1/conv-OTHER/msg-media.pdf",
      }))).rejects.toThrow();

      expect(createSignedUrl).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMessageContent).toHaveBeenCalledWith(
        expect.anything(), "msg-media", "proposta.pdf",
        expect.objectContaining({ send_failed_at: expect.any(String) }),
      );
    });

    it("missing message row is rejected without signing", async () => {
      vi.mocked(database.getMessageById).mockResolvedValue(null as never);
      global.fetch = vi.fn() as never;

      await expect(processSendMessageJob(mediaJob())).rejects.toThrow();
      expect(createSignedUrl).not.toHaveBeenCalled();
    });

    it("AI image with mediaUrl keeps the legacy payload", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ key: { id: "EVO-AI" } }));
      global.fetch = fetchMock as never;

      await processSendMessageJob({
        data: { conversationId: "conv-1", messageId: "msg-ai", instanceId: "inst-1", phone: "5511999999999",
          content: "foto", organizationId: "org-1", mediaUrl: "https://img.test/a.jpg", caption: "olha" },
      } as never);

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        number: "5511999999999", mediatype: "image", media: "https://img.test/a.jpg", caption: "olha",
      });
      expect(createSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe("seller audio (storedAudioRef)", () => {
    const sellerJob = {
      data: {
        conversationId: "conv-1",
        messageId: "msg-seller",
        instanceId: "inst-1",
        phone: "5511999999999",
        content: "[audio]",
        organizationId: "org-1",
        storedAudioRef: "storage:customer-audio/org-1/conv-1/a.ogg",
      },
    } as never;

    beforeEach(() => {
      vi.mocked(database.getMessageById).mockResolvedValue({
        id: "msg-seller", role: "human_agent", content: "[audio]", metadata: { source: "seller_audio" },
      } as never);
    });
    afterEach(() => {
      vi.mocked(database.getMessageById).mockResolvedValue(null as never);
    });

    it("downloads from storage and sends audio as base64 without text", async () => {
      download.mockResolvedValue({ data: new Blob([Buffer.from("hello")]), error: null });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ key: { id: "EVO-SELLER-1" } }));
      global.fetch = fetchMock as never;

      await processSendMessageJob(sellerJob);

      expect(download).toHaveBeenCalledWith("org-1/conv-1/a.ogg");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://evolution.test/message/sendWhatsAppAudio/loja-1");
      expect(url).not.toContain("sendText");
      const body = JSON.parse(init.body);
      expect(body.audio).toBe(Buffer.from("hello").toString("base64"));
      expect(body.encoding).toBe(true);
      expect(setMessageEvolutionId).toHaveBeenCalledWith(expect.anything(), "msg-seller", "EVO-SELLER-1");
      expect(updateMessageContent).not.toHaveBeenCalled();
    });

    it("on Evolution error marks send_failed_at, rethrows and never sends text", async () => {
      download.mockResolvedValue({ data: new Blob([Buffer.from("x")]), error: null });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, false));
      global.fetch = fetchMock as never;

      await expect(processSendMessageJob(sellerJob)).rejects.toThrow(/audio send error/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).not.toContain("sendText");
      expect(updateMessageContent).toHaveBeenCalledWith(
        expect.anything(), "msg-seller", "[audio]",
        expect.objectContaining({ source: "seller_audio", send_failed_at: expect.any(String) }),
      );
    });

    it("on storage download failure marks send_failed_at, rethrows and never calls Evolution", async () => {
      download.mockResolvedValue({ data: null, error: { message: "not found" } });
      const fetchMock = vi.fn();
      global.fetch = fetchMock as never;

      await expect(processSendMessageJob(sellerJob)).rejects.toThrow();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMessageContent).toHaveBeenCalledWith(
        expect.anything(), "msg-seller", "[audio]",
        expect.objectContaining({ send_failed_at: expect.any(String) }),
      );
    });

    it("instance lookup failure marks send_failed_at, rethrows and sends nothing", async () => {
      getInstanceById.mockRejectedValueOnce(new Error("instance gone"));
      const fetchMock = vi.fn();
      global.fetch = fetchMock as never;

      await expect(processSendMessageJob(sellerJob)).rejects.toThrow("instance gone");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMessageContent).toHaveBeenCalledWith(
        expect.anything(), "msg-seller", "[audio]",
        expect.objectContaining({ source: "seller_audio", send_failed_at: expect.any(String) }),
      );
    });

    it("getMessageById failure still marks send_failed_at and rethrows", async () => {
      vi.mocked(database.getMessageById).mockRejectedValueOnce(new Error("db read failed"));
      const fetchMock = vi.fn();
      global.fetch = fetchMock as never;

      await expect(processSendMessageJob(sellerJob)).rejects.toThrow("db read failed");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMessageContent).toHaveBeenCalledWith(
        expect.anything(), "msg-seller", "[audio]",
        expect.objectContaining({ send_failed_at: expect.any(String) }),
      );
    });

    it("invalid ref counts as failure", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as never;
      const bad = { data: { ...(sellerJob as any).data, storedAudioRef: "garbage" } } as never;

      await expect(processSendMessageJob(bad)).rejects.toThrow();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMessageContent).toHaveBeenCalled();
    });

    it("still rethrows the original error if marking the failure itself fails", async () => {
      download.mockResolvedValue({ data: null, error: { message: "nope" } });
      updateMessageContent.mockRejectedValueOnce(new Error("db down"));
      global.fetch = vi.fn() as never;

      await expect(processSendMessageJob(sellerJob)).rejects.toThrow(/nope|download/i);
    });
  });
});

it("cancela job antigo da IA gravado antes do congelamento sem chamar Evolution",async()=>{
 vi.mocked(database.getMessageById).mockResolvedValue({role:"agent",created_at:"2026-10-01T10:00:00Z",metadata:null} as any);
 vi.mocked(database.getConversationById).mockResolvedValue({contact_id:"p"} as any);
 vi.mocked(database.shouldCancelPreFreezeAgentMessage).mockResolvedValue(true);
 global.fetch=vi.fn();
 await processSendMessageJob({data:{conversationId:"c",messageId:"m",instanceId:"i",phone:"5511",content:"Retorno",organizationId:"org"}});
 expect(global.fetch).not.toHaveBeenCalled();
 vi.mocked(database.getMessageById).mockResolvedValue(null);vi.mocked(database.shouldCancelPreFreezeAgentMessage).mockResolvedValue(false);
 global.fetch=originalFetch;
});
it("cancela follow-up da tarefa congelada, mas preserva envio manual deliberado",async()=>{
 getInstanceById.mockResolvedValue({instance_name:"loja-1"});
 vi.mocked(database.getConversationById).mockResolvedValue({contact_id:"p"} as any);
 vi.mocked(database.hasFrozenContact).mockResolvedValue(true);
 global.fetch=vi.fn().mockResolvedValue(jsonResponse({key:{id:"manual"}})) as any;
 const data={conversationId:"c",messageId:"m",instanceId:"i",phone:"5511",content:"Retorno",organizationId:"org"};
 vi.mocked(database.getMessageById).mockResolvedValue({role:"human_agent",metadata:{source:"task_followup"}} as any);
 await processSendMessageJob({data});expect(global.fetch).not.toHaveBeenCalled();
 vi.mocked(database.getMessageById).mockResolvedValue({role:"human_agent",metadata:null} as any);
 await processSendMessageJob({data});expect(global.fetch).toHaveBeenCalledTimes(1);
 vi.mocked(database.getMessageById).mockResolvedValue(null);vi.mocked(database.hasFrozenContact).mockResolvedValue(false);global.fetch=originalFetch;
});

it("mantém aviso interno requestHuman com identificador sintético",async()=>{
 getInstanceById.mockResolvedValue({instance_name:"loja-1"});
 vi.mocked(database.getMessageById).mockRejectedValueOnce(new Error("invalid input syntax for type uuid"));
 global.fetch=vi.fn().mockResolvedValue(jsonResponse({key:{id:"notify"}})) as any;
 await expect(processSendMessageJob({data:{conversationId:"c",messageId:"handoff-notify-123",instanceId:"i",phone:"5511",content:"Handoff interno",organizationId:"org"}})).resolves.toBeUndefined();
 expect(global.fetch).toHaveBeenCalledTimes(1);
 vi.mocked(database.getMessageById).mockReset().mockResolvedValue(null);global.fetch=originalFetch;

});
