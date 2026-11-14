import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getAdminClient, getInstanceById, setMessageEvolutionId, updateMessageContent, download, createSignedUrl, markMessageSendFailed, resolvePendency, createTaskDedup } = vi.hoisted(() => ({
  resolvePendency: vi.fn().mockResolvedValue(0), createTaskDedup: vi.fn().mockResolvedValue({}),
  markMessageSendFailed: vi.fn().mockResolvedValue(true),
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
  hasFrozenContact: vi.fn().mockResolvedValue(false), markMessageSendFailed, recoverSendFailures: resolvePendency, createTaskWithDedup: createTaskDedup, getAdminClient, getInstanceById, setMessageEvolutionId, updateMessageContent, getMessageById: vi.fn().mockResolvedValue(null), getConversationById: vi.fn() }));

const notifyMock = vi.hoisted(() => vi.fn().mockResolvedValue({ sent: 1, skipped: [] }));
vi.mock("../lib/send-failure-alert.js", () => ({ notifySendFailure: notifyMock }));
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

describe("falha de envio: a mensagem deixa de contar como entregue", () => {
  const data = { conversationId: "conv-1", messageId: "msg-1", instanceId: "inst-1", phone: "5562996188374", content: "oi", organizationId: "org-1" };
  const failing = (status = 400, body: unknown = { response: { message: ["Connection Closed"] } }) =>
    vi.fn().mockResolvedValue({ ok: false, status, text: async () => JSON.stringify(body) + " apikey: SEGREDO123 5562996188374", json: async () => body });
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = "https://evolution.test"; process.env.EVOLUTION_API_KEY = "test-key";
    getInstanceById.mockResolvedValue({ instance_name: "Pos venda" });
    getAdminClient.mockImplementation(() => ({})); markMessageSendFailed.mockClear();
  });
  afterEach(() => { global.fetch = originalFetch; });

  it("última tentativa falhou: marca como não enviada com o motivo (sem chave nem telefone) e repassa o erro", async () => {
    global.fetch = failing() as never;
    await expect(processSendMessageJob({ data, attemptsMade: 2, opts: { attempts: 3 } } as never)).rejects.toThrow(/400/);
    expect(markMessageSendFailed).toHaveBeenCalledTimes(1);
    const [, id, reason] = markMessageSendFailed.mock.calls[0];
    expect(id).toBe("msg-1"); expect(reason).toContain("400"); expect(reason).toContain("Connection Closed");
    expect(reason).not.toMatch(/SEGREDO123|5562996188374/);
  });
  it("com retry pendente NÃO marca (ainda pode dar certo)", async () => {
    global.fetch = failing() as never;
    await expect(processSendMessageJob({ data, attemptsMade: 0, opts: { attempts: 3 } } as never)).rejects.toThrow();
    expect(markMessageSendFailed).not.toHaveBeenCalled();
  });
  it("o erro lançado também não vaza chave nem telefone (aparece no log do BullMQ)", async () => {
    global.fetch = failing() as never;
    const err = await processSendMessageJob({ data, attemptsMade: 2, opts: { attempts: 3 } } as never).catch((e) => e);
    expect(String(err.message)).not.toMatch(/SEGREDO123|5562996188374/);
  });
  it("sucesso não marca; aviso interno (handoff-notify) nunca marca", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ key: { id: "E1" } }), text: async () => "" }) as never;
    await processSendMessageJob({ data, attemptsMade: 0, opts: { attempts: 3 } } as never);
    global.fetch = failing() as never;
    await expect(processSendMessageJob({ data: { ...data, messageId: "handoff-notify-1" }, attemptsMade: 2, opts: { attempts: 3 } } as never)).rejects.toThrow();
    expect(markMessageSendFailed).not.toHaveBeenCalled();
  });
  it("falha ao gravar a marca não esconde o erro original", async () => {
    global.fetch = failing() as never; markMessageSendFailed.mockRejectedValueOnce(new Error("db down"));
    await expect(processSendMessageJob({ data, attemptsMade: 2, opts: { attempts: 3 } } as never)).rejects.toThrow(/400/);
  });
});

describe("roteamento das conversas comerciais NÃO usa a seleção de instância dos avisos internos", () => {
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = "https://evolution.test"; process.env.EVOLUTION_API_KEY = "test-key";
    getAdminClient.mockImplementation(() => ({}));
  });
  afterEach(() => { global.fetch = originalFetch; });

  it("envia SEMPRE pela instância gravada na conversa (job.instanceId), mesmo desconectada; nunca consulta estado nem troca de instância", async () => {
    // A instância da conversa ("Pos venda") está desconectada e existe outra conectada: o envio comercial NÃO a substitui.
    getInstanceById.mockImplementation(async (_db: unknown, id: string) => (id === "inst-pos-venda" ? { instance_name: "Pos venda" } : { instance_name: "weslley" }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => JSON.stringify({ response: { message: ["Connection Closed"] } }), json: async () => ({}) });
    global.fetch = fetchMock as never;
    const data = { conversationId: "conv-1", messageId: "msg-1", instanceId: "inst-pos-venda", phone: "5562900000000", content: "oi", organizationId: "org-1" };
    await expect(processSendMessageJob({ data, attemptsMade: 0, opts: { attempts: 3 } } as never)).rejects.toThrow(/400/);
    expect(getInstanceById).toHaveBeenCalledWith(expect.anything(), "inst-pos-venda");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["https://evolution.test/message/sendText/Pos venda"]); // uma chamada, na instância da conversa
    expect(urls.some((u) => u.includes("connectionState") || u.includes("fetchInstances") || u.includes("weslley"))).toBe(false);
  });

  it("o código de envio comercial e de roteamento não referencia a seleção de avisos (varredura de fonte)", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const roots = [fileURLToPath(new URL("..", import.meta.url)), fileURLToPath(new URL("../../../api/src", import.meta.url))];
    const allowed = new Set(["unanswered-lead-sweep.ts", "health-monitor.ts"]); // únicos usos permitidos: avisos internos
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(full); continue; }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts") || allowed.has(name)) continue;
        if (/rankSendInstances|deliverViaConnectedInstance|fetchConnectionState/.test(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});

describe("alerta de falha definitiva de envio (vendedor e gestores)", () => {
  const data = { conversationId: "conv-1", messageId: "msg-1", instanceId: "inst-1", phone: "5562900000000", content: "oi", organizationId: "org-1" };
  const failing = () => vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "{}", json: async () => ({}) });
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = "https://evolution.test"; process.env.EVOLUTION_API_KEY = "test-key";
    getInstanceById.mockResolvedValue({ instance_name: "weslley" }); getAdminClient.mockImplementation(() => ({}));
    vi.mocked(database.getConversationById).mockResolvedValue({ id: "conv-1", contact_id: "ct-1", assigned_to: "marina", wa_contacts: { name: "Romario" } } as never);
    vi.mocked(database.getMessageById).mockResolvedValue({ id: "msg-1", role: "human_agent", content: "oi", media_type: null, created_at: "2026-11-14T10:00:00Z", metadata: null } as never);
    markMessageSendFailed.mockReset().mockResolvedValue(true); notifyMock.mockClear();
  });
  afterEach(() => { global.fetch = originalFetch; vi.mocked(database.getMessageById).mockResolvedValue(null as never); });

  it("falha DEFINITIVA (última tentativa): avisa com cliente, responsável, instância e papel do remetente", async () => {
    global.fetch = failing() as never;
    await expect(processSendMessageJob({ data, attemptsMade: 2, opts: { attempts: 3 } } as never)).rejects.toThrow(/400/);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][1]).toEqual({ organizationId: "org-1", conversationId: "conv-1", contactId: "ct-1", messageId: "msg-1", messageCreatedAt: "2026-11-14T10:00:00Z", senderRole: "human_agent", contactName: "Romario", instanceName: "weslley", assigneeId: "marina" });
  });
  it("com retry pendente NÃO avisa (ainda pode dar certo)", async () => {
    global.fetch = failing() as never;
    await expect(processSendMessageJob({ data, attemptsMade: 0, opts: { attempts: 3 } } as never)).rejects.toThrow();
    expect(notifyMock).not.toHaveBeenCalled();
  });
  it("falha já marcada antes (reprocesso) não repete o aviso; aviso interno nunca avisa", async () => {
    global.fetch = failing() as never; markMessageSendFailed.mockResolvedValue(false);
    await expect(processSendMessageJob({ data, attemptsMade: 2, opts: { attempts: 3 } } as never)).rejects.toThrow();
    markMessageSendFailed.mockResolvedValue(true);
    await expect(processSendMessageJob({ data: { ...data, messageId: "handoff-notify-1" }, attemptsMade: 2, opts: { attempts: 3 } } as never)).rejects.toThrow();
    expect(notifyMock).not.toHaveBeenCalled();
  });
  it("envio bem-sucedido não avisa", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ key: { id: "E1" } }), text: async () => "" }) as never;
    await processSendMessageJob({ data, attemptsMade: 2, opts: { attempts: 3 } } as never);
    expect(notifyMock).not.toHaveBeenCalled();
  });
  it("falha do próprio alerta (ou do contexto) nunca esconde o erro do envio", async () => {
    global.fetch = failing() as never; notifyMock.mockRejectedValueOnce(new Error("push down"));
    await expect(processSendMessageJob({ data, attemptsMade: 2, opts: { attempts: 3 } } as never)).rejects.toThrow(/400/);
    vi.mocked(database.getConversationById).mockRejectedValueOnce(new Error("db down"));
    await expect(processSendMessageJob({ data, attemptsMade: 2, opts: { attempts: 3 } } as never)).rejects.toThrow(/400/);
  });
});

describe("envio aceito aciona a recuperação por EVIDÊNCIA da falha 'Mensagem não enviada'", () => {
  const data = { conversationId: "conv-1", messageId: "msg-2", instanceId: "inst-1", phone: "5562900000000", content: "reenvio", organizationId: "org-1" };
  const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ key: { id: "E2" } }), text: async () => "" });
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = "https://evolution.test"; process.env.EVOLUTION_API_KEY = "test-key";
    getInstanceById.mockResolvedValue({ instance_name: "weslley" }); getAdminClient.mockImplementation(() => ({}));
    vi.mocked(database.getConversationById).mockResolvedValue({ id: "conv-1", contact_id: "ct-1" } as never);
    vi.mocked(database.getMessageById).mockResolvedValue({ id: "msg-2", role: "human_agent", content: "reenvio", media_type: null, created_at: "2026-11-16T15:10:00Z", metadata: { resend_of: "msg-1" } } as never);
    resolvePendency.mockReset().mockResolvedValue(1);
  });
  afterEach(() => { global.fetch = originalFetch; vi.mocked(database.getMessageById).mockResolvedValue(null as never); });

  it("envio aceito: passa à recuperação a mensagem aceita, a CONVERSA dela e o contato (nunca 'qualquer mensagem do contato')", async () => {
    global.fetch = ok() as never;
    await processSendMessageJob({ data } as never);
    expect(resolvePendency).toHaveBeenCalledWith(expect.anything(), "org-1", "ct-1",
      { id: "msg-2", conversation_id: "conv-1", content: "reenvio", media_type: null, metadata: { resend_of: "msg-1" }, created_at: "2026-11-16T15:10:00Z" });
  });
  it("envio que falha não aciona a recuperação", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "{}", json: async () => ({}) }) as never;
    await expect(processSendMessageJob({ data, attemptsMade: 0, opts: { attempts: 3 } } as never)).rejects.toThrow();
    expect(resolvePendency).not.toHaveBeenCalled();
  });
  it("falha ao recuperar nunca derruba o envio", async () => {
    global.fetch = ok() as never; resolvePendency.mockRejectedValueOnce(new Error("db down"));
    await expect(processSendMessageJob({ data } as never)).resolves.toBeUndefined();
  });
});

describe("tarefa 'Mensagem não enviada' criada pela falha definitiva", () => {
  const ctx = { organizationId: "org-1", conversationId: "conv-9", contactId: "ct-9", messageId: "msg-9", messageCreatedAt: null, senderRole: "human_agent", contactName: "Ana", instanceName: "weslley", assigneeId: null };
  const text = { description: "d", reason: "r" };
  beforeEach(() => createTaskDedup.mockClear());
  it("guarda a referência da mensagem e da conversa; sem responsável fica SEM responsável (não 'da IA')", async () => {
    const { realSendFailureDeps } = await import("./send-message.js");
    await realSendFailureDeps({} as never).createTask(ctx as never, text);
    const input = createTaskDedup.mock.calls[0][1];
    expect(input).toMatchObject({ type: "message_send_failed", conversation_id: "conv-9", assignee_type: null, assignee_id: null, failed_message: { message_id: "msg-9", conversation_id: "conv-9" } });
  });
  it("com responsável: atribui ao vendedor e leva a pendência junto na consolidação", async () => {
    const { realSendFailureDeps } = await import("./send-message.js");
    await realSendFailureDeps({} as never).createTask({ ...ctx, assigneeId: "marina" } as never, text);
    expect(createTaskDedup.mock.calls[0][1]).toMatchObject({ assignee_type: "human", assignee_id: "marina", assign_on_merge: true, failed_message: { message_id: "msg-9" } });
  });
});
