import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({
  role: { value: "agent" }, settings: { value: {} as Record<string, boolean> }, memberOrg: { value: "org-1" },
  getMessageById: vi.fn(), getConversationById: vi.fn(), getOrganizationById: vi.fn(), listSalesReps: vi.fn(),
  createSignedUrl: vi.fn(), from: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  getMessageById: m.getMessageById, getConversationById: m.getConversationById,
  getOrganizationById: m.getOrganizationById, listSalesReps: m.listSalesReps,
  getAdminClient: () => ({ storage: { from: m.from } }),
}));
vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (req: any) => { req.user = { id: MARINA, memberships: [{ organization_id: m.memberOrg.value, role: m.role.value }] }; },
}));
import audioUrlRoutes from "./audio-url.js";

const MARINA = "22222222-2222-4222-8222-222222222222"; const MARCIO = "33333333-3333-4333-8333-333333333333";
const MSG = "11111111-1111-4111-8111-111111111111";
const REF = `storage:customer-audio/org-1/conv-1/${MSG}.mp4`;

async function get(id = MSG) {
  const app = Fastify(); await app.register(audioUrlRoutes);
  const r = await app.inject({ method: "GET", url: `/messages/${id}/audio-url` }); await app.close(); return r;
}
const conv = (assigned: string | null) => m.getConversationById.mockResolvedValue({ id: "conv-1", organization_id: "org-1", assigned_to: assigned });

beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "agent"; m.settings.value = { seller_isolation_enabled: true }; m.memberOrg.value = "org-1";
  m.getMessageById.mockResolvedValue({ id: MSG, conversation_id: "conv-1", organization_id: "org-1", role: "contact", media_type: "audio", media_url: REF });
  conv(MARINA);
  m.getOrganizationById.mockImplementation(async () => ({ settings: m.settings.value }));
  m.listSalesReps.mockResolvedValue([{ user_id: MARINA }, { user_id: MARCIO }]);
  m.createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://signed.example/a.mp4?token=1" }, error: null });
  m.from.mockReturnValue({ createSignedUrl: m.createSignedUrl });
});

describe("GET /messages/:messageId/audio-url", () => {
  it("devolve link temporário de 300 s para o dono da conversa", async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ url: "https://signed.example/a.mp4?token=1", expiresIn: 300 });
    expect(m.from).toHaveBeenCalledWith("customer-audio");
    expect(m.createSignedUrl).toHaveBeenCalledWith(`org-1/conv-1/${MSG}.mp4`, 300);
  });

  it("id que não é uuid -> 400", async () => {
    expect((await get("nao-e-uuid")).statusCode).toBe(400);
    expect(m.getMessageById).not.toHaveBeenCalled();
  });

  it("mensagem inexistente -> 404", async () => {
    m.getMessageById.mockResolvedValue(null);
    expect((await get()).statusCode).toBe(404);
  });

  it("sem arquivo guardado (media_url nulo, http ou de outro bucket) -> 404", async () => {
    for (const media_url of [null, "https://x/y.mp3", "storage:agent-media/a/b.png"]) {
      m.getMessageById.mockResolvedValue({ id: MSG, conversation_id: "conv-1", organization_id: "org-1", role: "contact", media_type: "audio", media_url });
      expect((await get()).statusCode).toBe(404);
    }
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("referência forjada (outra org, conversa ou mensagem, extensão ou traversal) -> 404 sem assinar", async () => {
    for (const media_url of [
      `storage:customer-audio/org-2/conv-1/${MSG}.mp4`, `storage:customer-audio/org-1/conv-9/${MSG}.mp4`,
      "storage:customer-audio/org-1/conv-1/outra-msg.mp4", `storage:customer-audio/org-1/conv-1/${MSG}.exe`,
      `storage:customer-audio/org-1/conv-1/${MSG}.mp4/../../../org-2/c/x.mp4`,
    ]) {
      m.getMessageById.mockResolvedValue({ id: MSG, conversation_id: "conv-1", organization_id: "org-1", role: "contact", media_type: "audio", media_url });
      expect((await get()).statusCode).toBe(404);
    }
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("só áudio de cliente: mensagem de agente ou não-áudio -> 404", async () => {
    m.getMessageById.mockResolvedValue({ id: MSG, conversation_id: "conv-1", organization_id: "org-1", role: "agent", media_type: "audio", media_url: REF });
    expect((await get()).statusCode).toBe(404);
    m.getMessageById.mockResolvedValue({ id: MSG, conversation_id: "conv-1", organization_id: "org-1", role: "contact", media_type: "image", media_url: REF });
    expect((await get()).statusCode).toBe(404);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("conversa de outra organização que a da mensagem -> 404", async () => {
    m.getConversationById.mockResolvedValue({ id: "conv-1", organization_id: "org-2", assigned_to: null });
    expect((await get()).statusCode).toBe(404);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("conversa inexistente (getConversationById lança) -> 404, não 500", async () => {
    m.getConversationById.mockRejectedValue(new Error("not found"));
    expect((await get()).statusCode).toBe(404);
  });

  it("usuário de outra organização -> 403", async () => {
    m.memberOrg.value = "org-2";
    const r = await get();
    expect(r.statusCode).toBe(403);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("vendedor de outra carteira -> 403 (isolamento ligado)", async () => {
    conv(MARCIO);
    const r = await get();
    expect(r.statusCode).toBe(403);
    expect(m.createSignedUrl).not.toHaveBeenCalled();
  });

  it("gestor ouve de qualquer carteira; sem dono e isolamento desligado também passam", async () => {
    m.role.value = "owner"; conv(MARCIO); expect((await get()).statusCode).toBe(200);
    m.role.value = "agent"; conv(null); expect((await get()).statusCode).toBe(200);
    m.settings.value = {}; conv(MARCIO); expect((await get()).statusCode).toBe(200);
  });

  it("falha do Storage ao assinar -> 404 (arquivo apagado pela retenção) sem vazar detalhe", async () => {
    m.createSignedUrl.mockResolvedValue({ data: null, error: { message: "Object not found" } });
    const r = await get();
    expect(r.statusCode).toBe(404);
  });
});
