import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({ createOpportunity: vi.fn(), addOpportunityEvent: vi.fn(), updates: [] as unknown[], tables: {} as Record<string, { data: unknown }> }));
vi.mock("@aula-agente/database", () => ({
  createOpportunity: m.createOpportunity, addOpportunityEvent: m.addOpportunityEvent,
  getAdminClient: () => ({
    from: (table: string) => {
      const chain: any = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, update: (v: unknown) => { m.updates.push(v); return chain; }, single: async () => ({ data: { id: "existing-opp", ...(m.updates.at(-1) as object) }, error: null }), maybeSingle: async () => ({ data: m.tables[table]?.data ?? null, error: null }) };
      return chain;
    },
  }),
  freezeOpportunity: vi.fn(), getUnidentifiedSalesContacts: vi.fn(), getOrganizationById: vi.fn(), getOpportunitiesByOrganization: vi.fn(), getOpportunityById: vi.fn(),
  getContactById: vi.fn(), getQualificationByConversationId: vi.fn(), getOpportunityEvents: vi.fn(), getOpenTasksByContact: vi.fn(), decryptCpf: vi.fn(), listSalesReps: vi.fn(),
}));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "user-1", memberships: [{ organization_id: "org-1", role: "admin" }] }; } }));
import routes from "./index.js";

const payload = { contact_id: "6f1b8c5e-1c1b-4b0e-9d2a-3a5b6c7d8e9f", operation: "consortium", stage: "interest_received", owner_id: "6f1b8c5e-1c1b-4b0e-9d2a-3a5b6c7d8e90", next_action: "Ligar", next_action_due_date: "2026-10-25" };
async function post() { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "POST", url: "/organizations/org-1/opportunities", payload }); await app.close(); return r; }

beforeEach(() => {
  vi.clearAllMocks(); m.updates = [];
  m.tables = { wa_contacts: { data: { id: payload.contact_id } } };
  m.createOpportunity.mockResolvedValue({ id: "new-opp", operation: "consortium", stage: "interest_received" });
});

describe("POST /organizations/:id/opportunities: guarda de negócio aberto", () => {
  it("contato que já tem negócio aberto: 409 com o id do existente e nada é criado", async () => {
    m.tables.opportunities = { data: { id: "existing-opp" } };
    const r = await post();
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ opportunity_id: "existing-opp" });
    expect(typeof r.json().error).toBe("string"); // o formulário mostra err.message
    expect(m.createOpportunity).not.toHaveBeenCalled();
    expect(m.addOpportunityEvent).not.toHaveBeenCalled();
  });

  it("contato sem negócio aberto: cria normalmente", async () => {
    const r = await post();
    expect(r.statusCode).toBe(201);
    expect(m.createOpportunity).toHaveBeenCalledTimes(1);
  });

  it("negócio aberto com operação 'a confirmar' (card do encaminhamento): atualiza a operação, limpa a marca e devolve o existente, sem 409", async () => {
    m.tables.opportunities = { data: { id: "existing-opp", operation: "vehicle_sale", stage: "interest_received", operation_is_default: true } };
    const r = await post();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: "existing-opp", operation: "consortium", operation_is_default: false });
    expect(m.updates[0]).toMatchObject({ operation: "consortium", stage: "interest_received", operation_is_default: false });
    expect(m.createOpportunity).not.toHaveBeenCalled();
    expect(m.addOpportunityEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ opportunity_id: "existing-opp", event_type: "operation_changed", changed_by_type: "human" }));
  });

  it("negócio aberto com operação confirmada (sem a marca): continua 409", async () => {
    m.tables.opportunities = { data: { id: "existing-opp", operation: "vehicle_sale", stage: "qualification", operation_is_default: false } };
    expect((await post()).statusCode).toBe(409);
    expect(m.updates).toHaveLength(0);
  });
});
