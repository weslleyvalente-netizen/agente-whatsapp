import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({
  role: { value: "agent" }, settings: { value: {} as Record<string, boolean> }, memberOrg: { value: "org-1" },
  getMessageById: vi.fn(), getConversationById: vi.fn(), getOrganizationById: vi.fn(), listSalesReps: vi.fn(),
  clearMessageMediaStatus: vi.fn(), enqueueStoreChatMedia: vi.fn(),
  createSignedUrl: vi.fn(), from: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  getMessageById: m.getMessageById, getConversationById: m.getConversationById,
  getOrganizationById: m.getOrganizationById, listSalesReps: m.listSalesReps,
  clearMessageMediaStatus: m.clearMessageMediaStatus,
  getAdminClient: () => ({ storage: { from: m.from } }),
}));
vi.mock("../../lib/queue.js", () => ({ enqueueStoreChatMedia: m.enqueueStoreChatMedia }));
vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (req: any) => { req.user = { id: MARINA, memberships: [{ organization_id: m.memberOrg.value, role: m.role.value }] }; },
}));
import mediaUrlRoutes from "./media-url.js";

const MARINA = "22222222-2222-4222-8222-222222222222"; const MARCIO = "33333333-3333-4333-8333-333333333333";
const MSG = "11111111-1111-4111-8111-111111111111";
const REF = `storage:chat-media/org-1/conv-1/${MSG}.pdf`;
const row = (over: Record<string, unknown> = {}) => ({
  id: MSG, conversation_id: "conv-1", organization_id: "org-1", role: "contact", media_type: "document", media_url: REF,
  metadata: { media: { status: "stored", file_name: "proposta.pdf", mime_type: "application/pdf" } }, ...over,
});

async function get(qs = "", id = MSG) {
  const app = Fastify(); await app.register(mediaUrlRoutes);
  const r = await app.inject({ method: "GET", url: `/messages/${id}/media-url${qs}` }); await app.close(); return r;
}
async function retry(id = MSG) {
  const app = Fastify(); await app.register(mediaUrlRoutes);
  const r = await app.inject({ method: "POST", url: `/messages/${id}/retry-media` }); await app.close(); return r;
}
const conv = (assigned: string | null) => m.getConversationById.mockResolvedValue({ id: "conv-1", organization_id: "org-1", assigned_to: assigned });

beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "agent"; m.settings.value = { seller_isolation_enabled: true }; m.memberOrg.value = "org-1";
  m.getMessageById.mockResolvedValue(row());
  conv(MARINA);
  m.getOrganizationById.mockImplementation(async () => ({ settings: m.settings.value }));
  m.listSalesReps.mockResolvedValue([{ user_id: MARINA }, { user_id: MARCIO }]);
  m.createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://signed.example/f?token=1" }, error: null });
  m.from.mockReturnValue({ createSignedUrl: m.createSignedUrl });
  m.clearMessageMediaStatus.mockResolvedValue(undefined);
  m.enqueueStoreChatMedia.mockResolvedValue({});
});

describe("GET /messages/:messageId/media-url", () => {
  it("documento assina com download = nome do arquivo e devolve metadados", async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ url: "https://signed.example/f?token=1", expiresIn: 300, fileName: "proposta.pdf", mimeType: "application/pdf" });
    expect(m.from).toHaveBeenCalledWith("chat-media");
    expect(m.createSignedUrl).toHaveBeenCalledWith(`org-1/conv-1/${MSG}.pdf`, 300, { download: "proposta.pdf" });
  });

  it("documento sem nome assina com download: true", async () => {
    m.getMessageById.mockResolvedValue(row({ metadata: {} }));
    const r = await get();
    expect(r.json()).toMatchObject({ fileName: null, mimeType: null });
    expect(m.createSignedUrl).toHaveBeenCalledWith(`org-1/conv-1/${MSG}.pdf`, 300, { download: true });
  });

  it("imagem assina sem download; com download=1 assina com download", async () => {
    m.getMessageById.mockResolvedValue(row({ media_type: "image", media_url: `storage:chat-media/org-1/conv-1/${MSG}.jpg`, metadata: { media: { status: "stored", mime_type: "image/jpeg" } } }));
    expect((await get()).statusCode).toBe(200);
    expect(m.createSignedUrl).toHaveBeenLastCalledWith(`org-1/conv-1/${MSG}.jpg`, 300);
    await get("?download=1");
    expect(m.createSignedUrl).toHaveBeenLastCalledWith(`org-1/conv-1/${MSG}.jpg`, 300, { download: true });
  });

  it("id inválido -> 400", async () => {
    expect((await get("", "nao-e-uuid")).statusCode).toBe(400);
    expect(m.getMessageById).not.toHaveBeenCalled();
  });

  it("mensagem inexistente -> 404", async () => {
    m.getMessageById.mockResolvedValue(null);
    expect((await get()).statusCode).toBe(404);
  });

  it("usuário de outra organização -> 403", async () => {
    m.memberOrg.value = "org-2";
    expect((await get()).statusCode).toBe(403);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("role agent/system ou media_type audio/null -> 404", async () => {
    for (const over of [{ role: "agent" }, { role: "system" }, { media_type: "audio" }, { media_type: null }]) {
      m.getMessageById.mockResolvedValue(row(over));
      expect((await get()).statusCode).toBe(404);
    }
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("human_agent com o próprio caminho -> 200", async () => {
    m.getMessageById.mockResolvedValue(row({ role: "human_agent" }));
    expect((await get()).statusCode).toBe(200);
  });

  it("conversa de outra organização ou inexistente -> 404", async () => {
    m.getConversationById.mockResolvedValue({ id: "conv-1", organization_id: "org-2", assigned_to: null });
    expect((await get()).statusCode).toBe(404);
    m.getConversationById.mockRejectedValue(new Error("not found"));
    expect((await get()).statusCode).toBe(404);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("vendedor de outro lead -> 403", async () => {
    conv(MARCIO);
    expect((await get()).statusCode).toBe(403);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("gestor acessa qualquer carteira", async () => {
    m.role.value = "owner"; conv(MARCIO);
    expect((await get()).statusCode).toBe(200);
  });

  it("sem media_url -> 404", async () => {
    m.getMessageById.mockResolvedValue(row({ media_url: null }));
    expect((await get()).statusCode).toBe(404);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("media_url forjada -> 404 sem assinar", async () => {
    for (const media_url of [
      `storage:chat-media/outra-org/conv-1/${MSG}.pdf`, `storage:chat-media/org-1/conv-9/${MSG}.pdf`,
      "storage:chat-media/org-1/conv-1/outra-msg.pdf", `storage:chat-media/org-1/conv-1/${MSG}.pdf/../../x/y.pdf`,
      `storage:customer-audio/org-1/conv-1/${MSG}.pdf`, "https://x/y.pdf",
    ]) {
      m.getMessageById.mockResolvedValue(row({ media_url }));
      expect((await get()).statusCode).toBe(404);
    }
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("falha do Storage ao assinar -> 404", async () => {
    m.createSignedUrl.mockResolvedValue({ data: null, error: { message: "Object not found" } });
    expect((await get()).statusCode).toBe(404);
  });
});

describe("POST /messages/:messageId/retry-media", () => {
  const failed = (over: Record<string, unknown> = {}) =>
    row({ media_url: null, metadata: { media: { status: "failed", file_name: "a.pdf" } }, ...over });

  it("failed + contato + sem media_url: enfileira uma vez com retry e zera o status", async () => {
    m.getMessageById.mockResolvedValue(failed());
    const r = await retry();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(m.clearMessageMediaStatus).toHaveBeenCalledWith(expect.anything(), MSG);
    expect(m.enqueueStoreChatMedia).toHaveBeenCalledTimes(1);
    expect(m.enqueueStoreChatMedia).toHaveBeenCalledWith({ messageId: MSG, conversationId: "conv-1", organizationId: "org-1" }, { retry: true });
  });

  it("status stored -> 409 sem enfileirar", async () => {
    m.getMessageById.mockResolvedValue(failed({ metadata: { media: { status: "stored" } } }));
    expect((await retry()).statusCode).toBe(409);
    expect(m.enqueueStoreChatMedia).not.toHaveBeenCalled();
    expect(m.clearMessageMediaStatus).not.toHaveBeenCalled();
  });

  it("failed mas com media_url preenchido -> 409", async () => {
    m.getMessageById.mockResolvedValue(failed({ media_url: REF }));
    expect((await retry()).statusCode).toBe(409);
    expect(m.enqueueStoreChatMedia).not.toHaveBeenCalled();
  });

  it("não é do contato (human_agent) -> 409", async () => {
    m.getMessageById.mockResolvedValue(failed({ role: "human_agent" }));
    expect((await retry()).statusCode).toBe(409);
    expect(m.enqueueStoreChatMedia).not.toHaveBeenCalled();
  });

  it("não é image/video/document -> 404", async () => {
    m.getMessageById.mockResolvedValue(failed({ media_type: "audio" }));
    expect((await retry()).statusCode).toBe(404);
  });

  it("vendedor de outro lead -> 403; outra organização -> 403; id inválido -> 400; inexistente -> 404", async () => {
    m.getMessageById.mockResolvedValue(failed());
    conv(MARCIO);
    expect((await retry()).statusCode).toBe(403);
    conv(MARINA); m.memberOrg.value = "org-2";
    expect((await retry()).statusCode).toBe(403);
    m.memberOrg.value = "org-1";
    expect((await retry("x")).statusCode).toBe(400);
    m.getMessageById.mockResolvedValue(null);
    expect((await retry()).statusCode).toBe(404);
    expect(m.enqueueStoreChatMedia).not.toHaveBeenCalled();
  });
});
