import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  resolve: vi.fn(), sendText: vi.fn(), sendMedia: vi.fn(), getInstanceById: vi.fn(), setId: vi.fn(), report: vi.fn(),
  getMessageById: vi.fn(), createSignedUrl: vi.fn(),
}));
vi.mock("@aula-agente/agent-runtime", async () => {
  const { UazapiHttpError } = await vi.importActual<typeof import("@aula-agente/agent-runtime")>("@aula-agente/agent-runtime");
  return { resolveWhatsAppTarget: m.resolve, uazapiSendText: m.sendText, uazapiSendMedia: m.sendMedia, UazapiHttpError };
});
vi.mock("@aula-agente/database", () => ({
  shouldCancelPreFreezeAgentMessage: vi.fn().mockResolvedValue(false), syncSalesPipeline: vi.fn().mockResolvedValue(null),
  hasFrozenContact: vi.fn().mockResolvedValue(false), reportSendFailure: m.report, recoverSendFailures: vi.fn().mockResolvedValue(0),
  createTaskWithDedup: vi.fn(), getAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: m.createSignedUrl }) } }),
  getInstanceById: m.getInstanceById, setMessageEvolutionId: m.setId, updateMessageContent: vi.fn(), getMessageById: m.getMessageById,
  getConversationById: vi.fn(),
}));

import { CHAT_MEDIA_REF_PREFIX } from "@aula-agente/shared";
import { processSendMessageJob } from "./send-message.js";
import { UazapiHttpError } from "@aula-agente/agent-runtime";

const job = (data: Record<string, unknown>, attemptsMade = 0) =>
  ({ data: { messageId: "msg-1", instanceId: "i1", organizationId: "o1", conversationId: "c1", phone: "5562999990000", content: "oi", ...data }, opts: { attempts: 1 }, attemptsMade }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.getInstanceById.mockResolvedValue({ instance_name: "w" });
  m.getMessageById.mockResolvedValue(null);
  m.report.mockResolvedValue({ claim: "claimed" });
  m.resolve.mockResolvedValue({ provider: "uazapi", instanceName: "w", token: "tok" });
  m.sendText.mockResolvedValue({ key: { id: "3EB0X" } });
  m.sendMedia.mockResolvedValue({ key: { id: "M1" } });
});

describe("envio pela UAZAPI", () => {
  it("texto: usa a UAZAPI e grava o id do WhatsApp", async () => {
    await processSendMessageJob(job({}));
    expect(m.sendText).toHaveBeenCalledWith("tok", "5562999990000", "oi", undefined);
    expect(m.setId).toHaveBeenCalledWith(expect.anything(), "msg-1", "3EB0X");
  });

  it("áudio da IA: ptt com o base64", async () => {
    await processSendMessageJob(job({ audioBase64: "QUJD" }));
    expect(m.sendMedia).toHaveBeenCalledWith("tok", "5562999990000", { type: "ptt", file: "QUJD" });
  });

  it("anexo do vendedor: documento com nome do arquivo", async () => {
    const ref = `${CHAT_MEDIA_REF_PREFIX}o1/c1/msg-1.pdf`;
    m.getMessageById.mockResolvedValue({ id: "msg-1", organization_id: "o1", conversation_id: "c1", role: "human_agent", content: "", metadata: {}, created_at: "2026-11-20T10:00:00Z" });
    m.createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://s/x.pdf" }, error: null });
    await processSendMessageJob(job({ storedMediaRef: ref, mediaKind: "document", mediaFileName: "rg.pdf", caption: "segue" }));
    expect(m.sendMedia).toHaveBeenCalledWith("tok", "5562999990000", { type: "document", file: "https://s/x.pdf", caption: "segue", docName: "rg.pdf", mimetype: undefined });
  });

  it("recusa da UAZAPI: falha de envio reportada e o job lança", async () => {
    m.sendText.mockRejectedValue(new UazapiHttpError(500, '{"error":"boom"}'));
    await expect(processSendMessageJob(job({}))).rejects.toThrow(/500/);
    expect(m.report).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ messageId: "msg-1" }));
  });

  it("instância em UAZAPI sem token: falha de envio reportada", async () => {
    m.resolve.mockRejectedValue(new Error("instância em UAZAPI sem token: conecte a UAZAPI antes de virar"));
    await expect(processSendMessageJob(job({}))).rejects.toThrow("sem token");
    expect(m.report).toHaveBeenCalled();
  });

  it("Evolution continua pelo fetch de antes", async () => {
    m.resolve.mockResolvedValue({ provider: "evolution", instanceName: "w" });
    process.env.EVOLUTION_API_URL = "https://evo.test"; process.env.EVOLUTION_API_KEY = "k";
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ key: { id: "E1" } }) });
    vi.stubGlobal("fetch", f);
    await processSendMessageJob(job({}));
    expect(String(f.mock.calls[0][0])).toBe("https://evo.test/message/sendText/w");
    expect(m.sendText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
