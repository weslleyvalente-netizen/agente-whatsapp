import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({
  role: { value: "agent" }, memberOrg: { value: "org-1" },
  contact: { value: null as Record<string, unknown> | null }, convs: { value: [] as Array<Record<string, unknown>> },
  getAdOriginForContact: vi.fn(), getOrganizationById: vi.fn(), listSalesReps: vi.fn(),
}));
vi.mock("../../services/lead-ad-origin.service.js", () => ({ getAdOriginForContact: m.getAdOriginForContact }));
vi.mock("@aula-agente/database", () => {
  const chain = (table: string) => {
    const api: Record<string, any> = {};
    api.select = () => api;
    api.eq = () => api;
    api.order = () => api; api.limit = () => (table === "conversations" ? Promise.resolve({ data: m.convs.value, error: null }) : api);
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
async function get(path = `/contacts/${C1}/ad-touches`) {
  const app = Fastify(); await app.register(adTouchesRoutes);
  const r = await app.inject({ method: "GET", url: path }); await app.close(); return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.role.value = "agent"; m.memberOrg.value = "org-1";
  m.contact.value = { id: C1, organization_id: "org-1" }; m.convs.value = [{ assigned_to: MARINA }];
  m.getAdOriginForContact.mockResolvedValue({ touches: [{ id: "b" }, { id: "a" }], total_touches: 2, first_touch_id: "a", attributed_touch_id: null, attribution: null });
  m.getOrganizationById.mockResolvedValue({ settings: { seller_isolation_enabled: true } });
  m.listSalesReps.mockResolvedValue([{ user_id: MARINA }, { user_id: MARCIO }]);
});

describe("GET /contacts/:contactId/ad-touches", () => {
  it("devolve o histórico de toques do contato (organização do contato, sem contexto de oportunidade)", async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ touches: [{ id: "b" }, { id: "a" }], total_touches: 2, first_touch_id: "a", attribution: null });
    expect(m.getAdOriginForContact).toHaveBeenCalledWith(expect.anything(), "org-1", C1);
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
    m.getAdOriginForContact.mockRejectedValue({ message: "relation secret_detail does not exist" });
    const r = await get();
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.json())).not.toContain("secret_detail");
  });
});
