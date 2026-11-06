import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getAdminClient, getInstanceById, setMessageEvolutionId, updateMessageContent, download } = vi.hoisted(() => ({
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
    getAdminClient.mockImplementation(() => ({ storage: { from: vi.fn(() => ({ download })) } }));
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
