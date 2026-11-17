import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
const m = vi.hoisted(() => ({
  role: { value: "agent" }, getOrganizationById: vi.fn(), listAttentionCandidates: vi.fn(), listSalesReps: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({ ...m, getAdminClient: () => ({}) }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "marina-user", memberships: [{ organization_id: "org-1", role: m.role.value }] }; } }));
import routes from "./index.js";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const row = (id: string, owner: string | null, over: Record<string, unknown> = {}) => ({
  kind: "awaiting", conversation_id: id, contact_id: `p-${id}`, contact_name: null, contact_phone: "5511", owner_user_id: owner,
  is_human_takeover: false, waiting_since: ago(90), last_contact_at: ago(90), had_human_reply: true, unanswered_contents: ["qual o valor da entrada?"], ...over,
});
async function get() { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "GET", url: "/organizations/org-1/dashboard/needs-reply" }); await app.close(); return r; }
beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "agent";
  m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true, needs_reply_queue_enabled: true } });
  m.listSalesReps.mockResolvedValue([{ user_id: "marina-user", display_name: "Marina" }, { user_id: "marcio-user", display_name: "Márcio" }]);
  m.listAttentionCandidates.mockResolvedValue([row("minha", "marina-user"), row("do-marcio", "marcio-user"), row("sem-dono", null, { is_human_takeover: true })]);
});
describe("dashboard/needs-reply", () => {
  it("flag desligada (ausente): não consulta nada e devolve enabled=false", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: { lead_distribution_enabled: true } });
    const r = await get(); expect(r.json()).toEqual({ enabled: false }); expect(m.listAttentionCandidates).not.toHaveBeenCalled();
  });
  it("flag com valor diferente de true também fica desligada", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: { needs_reply_queue_enabled: "true" } });
    expect((await get()).json()).toEqual({ enabled: false });
  });
  it("vendedor só vê a própria fila; não recebe sem dono nem nomes de outros", async () => {
    const j = (await get()).json();
    expect(j.enabled).toBe(true);
    expect(j.awaiting.items.map((i: any) => i.conversationId)).toEqual(["minha"]);
    expect(j.unowned).toBeNull(); expect(j.ownerNames).toEqual({});
  });
  it("gestor vê todos os vendedores e os sem dono em separado, com nomes", async () => {
    m.role.value = "admin";
    const j = (await get()).json();
    expect(j.awaiting.items.map((i: any) => i.conversationId).sort()).toEqual(["do-marcio", "minha"]);
    expect(j.unowned.awaiting.items.map((i: any) => i.conversationId)).toEqual(["sem-dono"]);
    expect(j.ownerNames).toEqual({ "marina-user": "Marina", "marcio-user": "Márcio" });
  });
  it("quem não é da organização recebe 403", async () => {
    m.role.value = "agent";
    const app = Fastify(); await app.register(routes);
    // outra organização
    const r = await app.inject({ method: "GET", url: "/organizations/outra/dashboard/needs-reply" }); await app.close();
    expect(r.statusCode).toBe(403);
  });
  it("o endpoint não escreve nada (somente leitura)", async () => {
    await get(); expect(m.listAttentionCandidates).toHaveBeenCalledTimes(1);
    expect(Object.keys(m).filter((k) => /^(update|insert|create|set|assign)/i.test(k))).toEqual([]);
  });
  it("vendedor pede ao banco só o que é dele (p_owner = usuário); gestor pede tudo (null)", async () => {
    await get(); expect(m.listAttentionCandidates.mock.calls[0].slice(3)).toEqual([200, "marina-user"]);
    m.role.value = "admin"; await get(); expect(m.listAttentionCandidates.mock.calls[1].slice(3)).toEqual([200, null]);
  });
  it("casos de mais de 7 dias vão para 'older' sem sumir do total", async () => {
    m.listAttentionCandidates.mockResolvedValue([row("novo", "marina-user"), row("velho", "marina-user", { waiting_since: ago(10 * 24 * 60) })]);
    const j = (await get()).json();
    expect(j.awaiting.items.map((i: any) => i.conversationId)).toEqual(["novo"]); expect(j.awaiting.total).toBe(1);
    expect(j.awaiting.older.items.map((i: any) => i.conversationId)).toEqual(["velho"]); expect(j.awaiting.older.total).toBe(1);
  });
});
