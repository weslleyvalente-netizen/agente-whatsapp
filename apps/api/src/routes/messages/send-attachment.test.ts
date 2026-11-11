import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const { getAdminClient, getConversationById, getOrganizationById, canViewLead, sendPanelMessage } = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})),
  getConversationById: vi.fn(),
  getOrganizationById: vi.fn(),
  canViewLead: vi.fn(),
  sendPanelMessage: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ getAdminClient, getConversationById, getOrganizationById }));
vi.mock("../../lib/lead-access.js", () => ({ canViewLead }));
vi.mock("../../services/message-send.service.js", () => {
  class SellerAttachmentSendError extends Error {
    constructor(m: string, public readonly uploaded: boolean) { super(m); }
  }
  return { sendPanelMessage, SellerAttachmentSendError };
});

let memberships = [{ organization_id: "org-1", role: "agent" }];
vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { id: "user-1", email: "u@example.com", memberships };
  },
}));

import { SellerAttachmentSendError } from "../../services/message-send.service.js";
import messageSendAttachmentRoutes from "./send-attachment.js";
import { resetAttachmentLimitForTests } from "./send-attachment-limit.js";

const CONV = "11111111-1111-4111-8111-111111111111";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MB = 1024 * 1024;

function mp4(size: number): Buffer {
  const b = Buffer.alloc(size, 1);
  b.writeUInt32BE(24, 0);
  b.write("ftyp", 4, "latin1");
  b.write("isom", 8, "latin1");
  b.writeUInt32BE(0x200, 12);
  b.write("isom", 16, "latin1");
  b.write("mp41", 20, "latin1");
  return b;
}

function multipart(opts: { file: Buffer | null; fileName?: string; mime?: string; conversationId?: string; caption?: string; extraFields?: string[]; fileField?: string }) {
  const b = "----testboundary";
  const chunks: Buffer[] = [];
  if (opts.conversationId !== undefined) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="conversation_id"\r\n\r\n${opts.conversationId}\r\n`));
  }
  if (opts.caption !== undefined) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${opts.caption}\r\n`));
  }
  for (const [i, v] of (opts.extraFields ?? []).entries()) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="extra${i}"\r\n\r\n${v}\r\n`));
  }
  if (opts.file) {
    chunks.push(
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${opts.fileField ?? "file"}"; filename="${opts.fileName ?? "foto.jpg"}"\r\nContent-Type: ${opts.mime ?? "image/jpeg"}\r\n\r\n`),
      opts.file,
      Buffer.from("\r\n")
    );
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(messageSendAttachmentRoutes);
  await app.ready();
  return app;
}

const post = (app: FastifyInstance, opts: Parameters<typeof multipart>[0]) =>
  app.inject({ method: "POST", url: "/messages/send-attachment", ...multipart({ conversationId: CONV, ...opts }) });

describe("POST /messages/send-attachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAttachmentLimitForTests();
    memberships = [{ organization_id: "org-1", role: "agent" }];
    getConversationById.mockResolvedValue({ id: CONV, organization_id: "org-1", assigned_to: "user-1" });
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { seller_attachments_enabled: true } });
    canViewLead.mockResolvedValue(true);
    sendPanelMessage.mockResolvedValue({ message: { id: "msg-1" }, instanceId: "i-1" });
  });

  it("JPEG válido com legenda -> 200 e attachment.kind image", async () => {
    const res = await post(await buildApp(), { file: JPEG, caption: "  Olha só  " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, messageId: "msg-1" });
    expect(sendPanelMessage).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "user-1",
      attachment: expect.objectContaining({ kind: "image", mime: "image/jpeg", extension: "jpg", fileName: "foto.jpg", caption: "Olha só" }),
    }));
  });

  it("legenda vazia após trim é ausente", async () => {
    await post(await buildApp(), { file: JPEG, caption: "   " });
    const arg = sendPanelMessage.mock.calls[0][0];
    expect(arg.attachment.caption).toBeUndefined();
  });

  it("legenda acima de 1000 caracteres -> 400 sem consumir vaga", async () => {
    const app = await buildApp();
    const res = await post(app, { file: JPEG, caption: "a".repeat(1001) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/legenda/i);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("nome do arquivo é saneado", async () => {
    await post(await buildApp(), { file: JPEG, fileName: "..%2F..%2Fa&b#.jpg" });
    const name = sendPanelMessage.mock.calls[0][0].attachment.fileName as string;
    expect(name).not.toMatch(/[&#%/\\]/);
  });

  it("mime e extensão declarados não são confiados: PNG com nome .pdf -> 400", async () => {
    const app = await buildApp();
    const res = await post(app, { file: PNG, fileName: "x.pdf", mime: "application/pdf" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Tipo de arquivo não suportado." });
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("falha de validação devolve a vaga (61 tentativas inválidas seguidas ainda dão 400)", async () => {
    const app = await buildApp();
    for (let i = 0; i < 61; i++) expect((await post(app, { file: PNG, fileName: "x.pdf" })).statusCode).toBe(400);
    expect((await post(app, { file: JPEG })).statusCode).toBe(200);
  });

  it("arquivo vazio -> 400 e devolve a vaga", async () => {
    const app = await buildApp();
    for (let i = 0; i < 61; i++) expect((await post(app, { file: Buffer.alloc(0) })).statusCode).toBe(400);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("vídeo de 17 MB -> 413 e devolve a vaga", async () => {
    const app = await buildApp();
    const res = await post(app, { file: mp4(17 * MB), fileName: "v.mp4", mime: "video/mp4" });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/16 MB/);
    expect(sendPanelMessage).not.toHaveBeenCalled();
    for (let i = 0; i < 60; i++) expect((await post(app, { file: JPEG })).statusCode).toBe(200);
  });

  it("acima de 25 MB -> 413 'Arquivo acima do limite' e devolve a vaga", async () => {
    const app = await buildApp();
    const res = await post(app, { file: Buffer.concat([JPEG, Buffer.alloc(25 * MB, 1)]) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "Arquivo acima do limite" });
    for (let i = 0; i < 60; i++) expect((await post(app, { file: JPEG })).statusCode).toBe(200);
  });

  it("sem arquivo -> 400", async () => {
    expect((await post(await buildApp(), { file: null })).statusCode).toBe(400);
  });

  it("conversation_id inválido -> 400", async () => {
    expect((await post(await buildApp(), { file: JPEG, conversationId: "nao-uuid" })).statusCode).toBe(400);
  });

  it("conversa inexistente -> 404", async () => {
    getConversationById.mockResolvedValue(null);
    expect((await post(await buildApp(), { file: JPEG })).statusCode).toBe(404);
  });

  it("getConversationById lançando (conversa inexistente) -> 404 e sem consumir vaga", async () => {
    getConversationById.mockRejectedValue(new Error("JSON object requested, multiple (or no) rows returned"));
    const app = await buildApp();
    const res = await post(app, { file: JPEG });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Conversa não encontrada" });
    expect(sendPanelMessage).not.toHaveBeenCalled();
    getConversationById.mockResolvedValue({ id: CONV, organization_id: "org-1", assigned_to: "user-1" });
    for (let i = 0; i < 60; i++) expect((await post(app, { file: JPEG })).statusCode).toBe(200);
  });

  it("flag desligada -> 404", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
    const res = await post(await buildApp(), { file: JPEG });
    expect(res.statusCode).toBe(404);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("flag truthy mas não true -> 404", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { seller_attachments_enabled: "true" } });
    expect((await post(await buildApp(), { file: JPEG })).statusCode).toBe(404);
  });

  it("organização inexistente -> 404", async () => {
    getOrganizationById.mockResolvedValue(null);
    expect((await post(await buildApp(), { file: JPEG })).statusCode).toBe(404);
  });

  it("membro de outra organização -> 403", async () => {
    memberships = [{ organization_id: "org-2", role: "agent" }];
    expect((await post(await buildApp(), { file: JPEG })).statusCode).toBe(403);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("lead de outro vendedor -> 403", async () => {
    canViewLead.mockResolvedValue(false);
    expect((await post(await buildApp(), { file: JPEG })).statusCode).toBe(403);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("61º envio na hora -> 429 em português", async () => {
    const app = await buildApp();
    for (let i = 0; i < 60; i++) expect((await post(app, { file: JPEG })).statusCode).toBe(200);
    const res = await post(app, { file: JPEG });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/Limite de anexos por hora/);
    expect(sendPanelMessage).toHaveBeenCalledTimes(60);
  });

  it("legenda de 1000 'ç' (2000 bytes) é aceita", async () => {
    const res = await post(await buildApp(), { file: JPEG, caption: "ç".repeat(1000) });
    expect(res.statusCode).toBe(200);
    expect(sendPanelMessage.mock.calls[0][0].attachment.caption).toBe("ç".repeat(1000));
  });

  it("campo caption de 20 KB -> 4xx em português, sem 500 e sem consumir vaga", async () => {
    const app = await buildApp();
    const res = await post(app, { file: JPEG, caption: "a".repeat(20 * 1024) });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().error).toMatch(/[a-zç]/i);
    expect(sendPanelMessage).not.toHaveBeenCalled();
    for (let i = 0; i < 60; i++) expect((await post(app, { file: JPEG })).statusCode).toBe(200);
  });

  it("3 campos de texto antes do arquivo -> 4xx e sem consumir vaga", async () => {
    const app = await buildApp();
    const res = await post(app, { file: JPEG, caption: "oi", extraFields: ["x"] });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(sendPanelMessage).not.toHaveBeenCalled();
    for (let i = 0; i < 60; i++) expect((await post(app, { file: JPEG })).statusCode).toBe(200);
  });

  it("arquivo em campo que não se chama 'file' -> 400 e sem consumir vaga", async () => {
    const app = await buildApp();
    const res = await post(app, { file: JPEG, fileField: "outro" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Nenhum arquivo enviado." });
    expect(sendPanelMessage).not.toHaveBeenCalled();
    for (let i = 0; i < 60; i++) expect((await post(app, { file: JPEG })).statusCode).toBe(200);
  });

  it("arquivo antes do conversation_id -> 400", async () => {
    const b = "----testboundary";
    const payload = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      JPEG,
      Buffer.from(`\r\n--${b}\r\nContent-Disposition: form-data; name="conversation_id"\r\n\r\n${CONV}\r\n--${b}--\r\n`),
    ]);
    const res = await (await buildApp()).inject({ method: "POST", url: "/messages/send-attachment", payload, headers: { "content-type": `multipart/form-data; boundary=${b}` } });
    expect(res.statusCode).toBe(400);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  async function fillThenFail(err: Error) {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await buildApp();
    for (let i = 0; i < 59; i++) await post(app, { file: JPEG });
    sendPanelMessage.mockRejectedValueOnce(err);
    expect((await post(app, { file: JPEG })).statusCode).toBe(500);
    const next = await post(app, { file: JPEG });
    log.mockRestore();
    return next.statusCode;
  }

  it("falha ANTES do upload devolve a vaga", async () => {
    expect(await fillThenFail(new SellerAttachmentSendError("x", false))).toBe(200);
  });

  it("falha DEPOIS do upload não devolve a vaga", async () => {
    expect(await fillThenFail(new SellerAttachmentSendError("x", true))).toBe(429);
  });

  it("erro genérico devolve a vaga", async () => {
    expect(await fillThenFail(new Error("boom"))).toBe(200);
  });
});
