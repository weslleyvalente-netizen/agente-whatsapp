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
vi.mock("../../services/message-send.service.js", () => ({ sendPanelMessage }));

let memberships = [{ organization_id: "org-1", role: "agent" }];
vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { id: "user-1", email: "u@example.com", memberships };
  },
}));

import messageSendAudioRoutes from "./send-audio.js";
import { resetSellerAudioLimitForTests } from "./send-audio-limit.js";

const CONV = "11111111-1111-4111-8111-111111111111";
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100, 1)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function multipart(opts: { file: Buffer | null; mime?: string; conversationId?: string; duration?: string }) {
  const b = "----testboundary";
  const chunks: Buffer[] = [];
  if (opts.conversationId !== undefined) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="conversation_id"\r\n\r\n${opts.conversationId}\r\n`));
  }
  if (opts.duration !== undefined) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="duration_seconds"\r\n\r\n${opts.duration}\r\n`));
  }
  if (opts.file) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.webm"\r\nContent-Type: ${opts.mime ?? "audio/webm"}\r\n\r\n`), opts.file, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(messageSendAudioRoutes);
  await app.ready();
  return app;
}

const post = (app: FastifyInstance, opts: Parameters<typeof multipart>[0]) =>
  app.inject({ method: "POST", url: "/messages/send-audio", ...multipart({ conversationId: CONV, ...opts }) });

describe("POST /messages/send-audio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSellerAudioLimitForTests();
    memberships = [{ organization_id: "org-1", role: "agent" }];
    getConversationById.mockResolvedValue({ id: CONV, organization_id: "org-1", assigned_to: "user-1" });
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { seller_audio_enabled: true } });
    canViewLead.mockResolvedValue(true);
    sendPanelMessage.mockResolvedValue({ message: { id: "msg-1" }, instanceId: "i-1" });
  });

  it("webm válido envia e responde 200", async () => {
    const app = await buildApp();
    const res = await post(app, { file: WEBM, duration: "12" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, messageId: "msg-1" });
    expect(sendPanelMessage).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "user-1",
      audio: expect.objectContaining({ extension: "webm", durationSeconds: 12 }),
    }));
  });

  it("bytes de PNG declarados como audio/webm -> 400", async () => {
    const res = await post(await buildApp(), { file: PNG });
    expect(res.statusCode).toBe(400);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("mime declarado fora da lista -> 400", async () => {
    const res = await post(await buildApp(), { file: WEBM, mime: "application/pdf" });
    expect(res.statusCode).toBe(400);
  });

  it("arquivo vazio -> 400", async () => {
    const res = await post(await buildApp(), { file: Buffer.alloc(0) });
    expect(res.statusCode).toBe(400);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("3 MB + 1 byte -> 413", async () => {
    const big = Buffer.concat([WEBM, Buffer.alloc(3 * 1024 * 1024 + 1 - WEBM.length, 1)]);
    const res = await post(await buildApp(), { file: big });
    expect(res.statusCode).toBe(413);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("sem arquivo -> 400", async () => {
    const res = await post(await buildApp(), { file: null });
    expect(res.statusCode).toBe(400);
  });

  it("conversation_id inválido -> 400", async () => {
    const res = await post(await buildApp(), { file: WEBM, conversationId: "nao-uuid" });
    expect(res.statusCode).toBe(400);
  });

  it("chave desligada -> 404 sem enviar", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
    const res = await post(await buildApp(), { file: WEBM });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Envio de áudio não está habilitado" });
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("membro de outra organização -> 403", async () => {
    memberships = [{ organization_id: "org-2", role: "agent" }];
    const res = await post(await buildApp(), { file: WEBM });
    expect(res.statusCode).toBe(403);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("lead de outro vendedor -> 403", async () => {
    canViewLead.mockResolvedValue(false);
    const res = await post(await buildApp(), { file: WEBM });
    expect(res.statusCode).toBe(403);
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("31º envio na mesma hora -> 429", async () => {
    const app = await buildApp();
    for (let i = 0; i < 30; i++) expect((await post(app, { file: WEBM })).statusCode).toBe(200);
    const res = await post(app, { file: WEBM });
    expect(res.statusCode).toBe(429);
    expect(sendPanelMessage).toHaveBeenCalledTimes(30);
  });

  it("falha no envio devolve a vaga e responde 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    sendPanelMessage.mockRejectedValueOnce(new Error("x"));
    const app = await buildApp();
    expect((await post(app, { file: WEBM })).statusCode).toBe(500);
    log.mockRestore();
  });
});
