import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentImageItem } from "@aula-agente/shared";
import { createSendRegisteredImageTool, createMockSendRegisteredImageTool } from "./send-registered-image.js";

const createMessage = vi.fn();
const addToQueue = vi.fn();

vi.mock("@aula-agente/database", () => ({
  createMessage: (...args: unknown[]) => createMessage(...args),
  getAdminClient: () => ({}),
  getLatestAgentVersion: vi.fn(),
  getAgentConfigIfExists: vi.fn(),
}));

vi.mock("@aula-agente/queue", () => ({
  getSendMessageQueue: () => ({ add: (...args: unknown[]) => addToQueue(...args) }),
}));

const context = { conversationId: "conv-1", organizationId: "org-1", instanceId: "inst-1", phone: "5562999999999" };
const catalogo: AgentImageItem = {
  id: "img-1",
  titulo: "Catálogo Libera Cred",
  quando_enviar: "cliente pede o catálogo",
  legenda: "Motos do plano Libera Cred — preços de referência do plano (tabela 23/09/2026).",
  url: "https://x.test/storage/v1/object/public/agent-media/org-1/agent-1/img-1.png",
  storage_path: "org-1/agent-1/img-1.png",
  ativo: true,
};

beforeEach(() => {
  createMessage.mockReset();
  createMessage.mockResolvedValue({ id: "msg-1" });
  addToQueue.mockReset();
});

describe("createSendRegisteredImageTool", () => {
  it("sends the published image with its caption through the send-message queue", async () => {
    const toolDef = createSendRegisteredImageTool(context, async () => [catalogo]);
    const result = await toolDef.execute!({ imagem_id: "img-1" }, {} as never);

    expect(result).toBe("Imagem enviada.");
    expect(createMessage).toHaveBeenCalledWith({}, expect.objectContaining({
      conversation_id: "conv-1", role: "agent", content: catalogo.legenda, media_url: catalogo.url, media_type: "image",
    }));
    expect(addToQueue).toHaveBeenCalledWith("send-message", expect.objectContaining({
      conversationId: "conv-1", messageId: "msg-1", mediaUrl: catalogo.url, mediaType: "image", caption: catalogo.legenda, phone: context.phone,
    }));
  });

  it("does not send and says so when the id is not in the published version (e.g. only in the draft)", async () => {
    const toolDef = createSendRegisteredImageTool(context, async () => []);
    const result = await toolDef.execute!({ imagem_id: "img-1" }, {} as never);

    expect(result).not.toContain("Imagem enviada");
    expect(result).toContain("não diga ao cliente que enviou");
    expect(createMessage).not.toHaveBeenCalled();
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("does not send an inactive image", async () => {
    const toolDef = createSendRegisteredImageTool(context, async () => [{ ...catalogo, ativo: false }]);
    const result = await toolDef.execute!({ imagem_id: "img-1" }, {} as never);

    expect(result).toContain("desativada");
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("reports a failure instead of claiming success when the queue throws", async () => {
    addToQueue.mockRejectedValue(new Error("redis down"));
    const toolDef = createSendRegisteredImageTool(context, async () => [catalogo]);
    const result = await toolDef.execute!({ imagem_id: "img-1" }, {} as never);

    expect(result).not.toContain("Imagem enviada");
    expect(result).toContain("Não foi possível enviar");
  });
});

describe("createMockSendRegisteredImageTool", () => {
  it("simulates using the loaded (draft) images and never enqueues", async () => {
    const toolDef = createMockSendRegisteredImageTool(async () => [catalogo]);
    const result = await toolDef.execute!({ imagem_id: "img-1" }, {} as never);

    expect(result).toContain("[SIMULADO]");
    expect(result).toContain("Catálogo Libera Cred");
    expect(createMessage).not.toHaveBeenCalled();
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("reports not-found in the simulation too", async () => {
    const toolDef = createMockSendRegisteredImageTool(async () => []);
    const result = await toolDef.execute!({ imagem_id: "nope" }, {} as never);
    expect(result).toContain("não diga ao cliente que enviou");
  });
});
