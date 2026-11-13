import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({
  role: { value: "agent" }, memberOrg: { value: "org-1" },
  contact: { value: null as Record<string, unknown> | null }, convs: { value: [] as Array<Record<string, unknown>> },
  touches: { value: [] as Array<Record<string, unknown>> }, touchesError: { value: null as unknown },
  getOrganizationById: vi.fn(), listSalesReps: vi.fn(), selects: [] as string[], eqs: [] as Array<[string, unknown]>,
}));
vi.mock("@aula-agente/database", () => {
  const chain = (table: string) => {
    const api: Record<string, any> = {};
    api.select = (cols: string) => { m.selects.push(`${table}:${cols}`); return api; };
    api.eq = (c: string, v: unknown) => { m.eqs.push([`${table}.${c}`, v]); return api; };
    api.order = () => api; api.limit = () => (table === "conversations" ? Promise.resolve({ data: m.convs.value, error: null }) : table === "lead_ad_touches" ? Promise.resolve({ data: m.touches.value, error: m.touchesError.value }) : api);
    api.maybeSingle = async () => ({ data: m.contact.value, error: null });
    return api;
  };
  return { getOrganizationById: m.getOrganizationById, listSalesReps: m.listSalesReps, getAdminClient: () => ({ from: (t: string) => chain(t) }) };
});
vi.mock("../../middleware/auth.js", () => ({
  authMiddleware: async (req: any) => { req.user = { id: MARINA, memberships: [{ organization_id: m.memberOrg.value, role: m.role.value }] }; },
}));
import adTouchesRoutes from "./ad-touches.js";

const MARINA = "22222222-2222-4222-8222-222222222222"; const MARCIO = "33333333-3333-4333-8333-333333333333";
const C1 = "11111111-1111-4111-8111-111111111111";
const touch = (id: string, at: string) => ({ id, touched_at: at, platform: "instagram", source_type: "ad", ad_id: "9", ad_title: "T", ad_body: "B", ad_url: "https://x", campaign_id: null, campaign_name: null, conversation_id: null });

async function get(path = `/contacts/${C1}/ad-touches`) {
  const app = Fastify(); await app.register(adTouchesRoutes);
  const r = await app.inject({ method: "GET", url: path }); await app.close(); return r;
}

beforeEach(() => {
  vi.clearAllMocks(); m.selects.length = 0; m.eqs.length = 0;
  m.role.value = "agent"; m.memberOrg.value = "org-1"; m.touchesError.value = null;
  m.contact.value = { id: C1, organization_id: "org-1" }; m.convs.value = [{ assigned_to: MARINA }];
  m.touches.value = [touch("b", "2026-11-12T10:00:00Z"), touch("a", "2026-11-01T10:00:00Z")];
  m.getOrganizationById.mockResolvedValue({ settings: { seller_isolation_enabled: true } });
  m.listSalesReps.mockResolvedValue([{ user_id: MARINA }, { user_id: MARCIO }]);
});

describe("GET /contacts/:contactId/ad-touches", () => {
  it("devolve o histórico de toques do contato, sem ctwa_clid nem campos internos", async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json().touches.map((t: any) => t.id)).toEqual(["b", "a"]);
    expect(r.json().attributed_touch_id).toBeNull();
    const cols = m.selects.find((s) => s.startsWith("lead_ad_touches:"))!;
    expect(cols).not.toContain("ctwa_clid");
    expect(cols).not.toContain("available_fields");
    expect(cols).not.toContain("touch_key");
  });

  it("filtra pela organização do contato", async () => {
    await get();
    expect(m.eqs).toContainEqual(["lead_ad_touches.organization_id", "org-1"]);
    expect(m.eqs).toContainEqual(["lead_ad_touches.contact_id", C1]);
  });

  it("id inválido -> 400; contato inexistente ou de outra organização -> 404", async () => {
    expect((await get("/contacts/xyz/ad-touches")).statusCode).toBe(400);
    m.contact.value = null;
    expect((await get()).statusCode).toBe(404);
    m.contact.value = { id: C1, organization_id: "outra-org" };
    expect((await get()).statusCode).toBe(404);
  });

  it("vendedor não vê o lead de outro vendedor -> 403; gestor vê", async () => {
    m.convs.value = [{ assigned_to: MARCIO }];
    expect((await get()).statusCode).toBe(403);
    m.role.value = "owner";
    expect((await get()).statusCode).toBe(200);
  });

  it("contato sem conversa é visível; falha ao ler toques -> 500 sem vazar detalhes", async () => {
    m.convs.value = [];
    expect((await get()).statusCode).toBe(200);
    m.touchesError.value = { message: "relation secret_detail does not exist" };
    const r = await get();
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.json())).not.toContain("secret_detail");
  });
});
