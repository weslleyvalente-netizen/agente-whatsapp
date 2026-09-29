import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getAdminClient, getInstanceById, setMessageEvolutionId } = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})),
  getInstanceById: vi.fn(),
  setMessageEvolutionId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@aula-agente/database", () => ({ getAdminClient, getInstanceById, setMessageEvolutionId }));

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
});
