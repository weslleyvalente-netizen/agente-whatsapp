import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({
  getOpportunityById: vi.fn(), getContactById: vi.fn(), getQualificationByConversationId: vi.fn(), getOpportunityEvents: vi.fn(),
  getOpenTasksByContact: vi.fn(), getAdOriginForContact: vi.fn(),
}));
vi.mock("@aula-agente/database", () => ({
  ...m,
  getAdminClient: () => ({ from: () => { const c: any = { select: () => c, eq: () => c, order: () => c, limit: () => c, maybeSingle: async () => ({ data: null, error: null }) }; return c; } }),
}));
vi.mock("../../services/lead-ad-origin.service.js", () => ({ getAdOriginForContact: m.getAdOriginForContact }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "user-1", memberships: [{ organization_id: "org-1", role: "admin" }] }; } }));
import routes from "./index.js";

const opportunity = { id: "opp-1", organization_id: "org-1", contact_id: "contact-1", status: "open", stage: "qualification", created_at: "2026-11-11T12:00:00Z" };
async function details() { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "GET", url: "/opportunities/opp-1/details" }); await app.close(); return r; }

beforeEach(() => {
  vi.clearAllMocks();
  m.getOpportunityById.mockResolvedValue(opportunity);
  m.getContactById.mockResolvedValue({ id: "contact-1", organization_id: "org-1", name: "Ana", phone: "5561999999999", metadata: { lead_origin: { source: "instagram_ads", evidence: "https://x" } } });
  m.getQualificationByConversationId.mockResolvedValue(null);
  m.getOpportunityEvents.mockResolvedValue([]);
  m.getOpenTasksByContact.mockResolvedValue([]);
  m.getAdOriginForContact.mockResolvedValue({ touches: [{ id: "t2" }, { id: "t1" }], attributed_touch_id: "t1" });
});

describe("detalhes da oportunidade: origem por anúncio", () => {
  it("inclui o histórico de toques e o toque que originou a oportunidade, sem mexer na origem existente", async () => {
    const r = await details();
    expect(r.statusCode).toBe(200);
    expect(r.json().ad_origin).toEqual({ touches: [{ id: "t2" }, { id: "t1" }], attributed_touch_id: "t1" });
    expect(r.json().origin).toMatchObject({ source: "instagram_ads" });
    expect(m.getAdOriginForContact).toHaveBeenCalledWith(expect.anything(), "org-1", "contact-1", "2026-11-11T12:00:00Z");
  });

  it("falha ao ler os toques (ex.: tabela ainda não criada) não derruba os detalhes: ad_origin vem nulo", async () => {
    m.getAdOriginForContact.mockRejectedValue(new Error("relation lead_ad_touches does not exist"));
    const r = await details();
    expect(r.statusCode).toBe(200);
    expect(r.json().ad_origin).toBeNull();
    expect(r.json().customer).toMatchObject({ name: "Ana" });
  });
});
