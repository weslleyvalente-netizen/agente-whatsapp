import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
const m = vi.hoisted(() => ({
  role: { value: "agent" }, settings: { value: {} as Record<string, boolean> },
  getConversationById: vi.fn(), updateConversation: vi.fn(), getOrganizationById: vi.fn(), listSalesReps: vi.fn(), sendPanelMessage: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({ ...m, getAdminClient: () => ({}) }));
vi.mock("../../services/task.service.js", () => ({ handleConversationTakeover: vi.fn() }));
vi.mock("../../services/message-send.service.js", () => ({ sendPanelMessage: m.sendPanelMessage }));
vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (req: any) => { req.user = { id: "22222222-2222-4222-8222-222222222222", memberships: [{ organization_id: "org-1", role: m.role.value }] }; },
  requireOrg: () => async () => {},
}));
import conversationRoutes from "./index.js";
import messageSendRoutes from "../messages/send.js";

const MARINA = "22222222-2222-4222-8222-222222222222"; const MARCIO = "33333333-3333-4333-8333-333333333333";
const CONV = "11111111-1111-4111-8111-111111111111";
async function call(method: "PATCH" | "POST", url: string, payload: unknown) {
  const app = Fastify(); await app.register(conversationRoutes); await app.register(messageSendRoutes);
  const r = await app.inject({ method, url, payload: payload as any }); await app.close(); return r;
}
const conv = (assigned: string | null) => m.getConversationById.mockResolvedValue({ id: CONV, organization_id: "org-1", assigned_to: assigned, is_human_takeover: false });
const patch = (body: unknown) => call("PATCH", `/conversations/${CONV}`, body);
const send = () => call("POST", "/messages/send", { conversation_id: CONV, content: "oi" });

beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "agent"; m.settings.value = { seller_isolation_enabled: true };
  m.getOrganizationById.mockImplementation(async () => ({ settings: m.settings.value }));
  m.listSalesReps.mockResolvedValue([{ user_id: MARINA }, { user_id: MARCIO }]);
  m.updateConversation.mockResolvedValue({ id: CONV });
  m.sendPanelMessage.mockResolvedValue({ message: { id: "msg" } });
});

describe("PATCH /conversations/:id (somente seller_isolation_enabled)", () => {
  it("vendedor não altera conversa de outro vendedor", async () => {
    conv(MARCIO); const r = await patch({ status: "closed" });
    expect(r.statusCode).toBe(403); expect(m.updateConversation).not.toHaveBeenCalled();
  });
  it("vendedor altera a própria, a sem dono e a de dono legado", async () => {
    for (const owner of [MARINA, null, "conta-compartilhada"]) { conv(owner); expect((await patch({ status: "closed" })).statusCode).toBe(200); }
  });
  it("vendedor não passa a própria conversa a outro vendedor", async () => {
    conv(MARINA); const r = await patch({ assigned_to: MARCIO });
    expect(r.statusCode).toBe(403); expect(m.updateConversation).not.toHaveBeenCalled();
  });
  it("vendedor pode assumir conversa sem dono e soltar a própria", async () => {
    conv(null); expect((await patch({ assigned_to: MARINA })).statusCode).toBe(200);
    conv(MARINA); expect((await patch({ assigned_to: null })).statusCode).toBe(200);
    conv(MARINA); expect((await patch({ is_human_takeover: false })).statusCode).toBe(200); // solta (assigned_to = null)
  });
  it("assumir via is_human_takeover atribui ao próprio usuário e passa", async () => {
    conv(null); expect((await patch({ is_human_takeover: true })).statusCode).toBe(200);
  });
  it("gestor é irrestrito", async () => {
    m.role.value = "owner"; conv(MARCIO);
    expect((await patch({ assigned_to: MARINA })).statusCode).toBe(200);
  });
  it("com os dois interruptores desligados nada é restrito", async () => {
    m.settings.value = {}; conv(MARCIO);
    expect((await patch({ assigned_to: MARINA })).statusCode).toBe(200);
  });
});

describe("POST /messages/send", () => {
  it("vendedor não envia em conversa de outro vendedor", async () => {
    conv(MARCIO); const r = await send();
    expect(r.statusCode).toBe(403); expect(m.sendPanelMessage).not.toHaveBeenCalled();
  });
  it("vendedor envia na própria, sem dono e legado; gestor em qualquer uma", async () => {
    for (const owner of [MARINA, null, "conta-compartilhada"]) { conv(owner); expect((await send()).statusCode).toBe(200); }
    m.role.value = "admin"; conv(MARCIO); expect((await send()).statusCode).toBe(200);
  });
  it("com os interruptores desligados nada é restrito", async () => {
    m.settings.value = {}; conv(MARCIO); expect((await send()).statusCode).toBe(200);
  });
});
