import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({ createOpportunity: vi.fn(), addOpportunityEvent: vi.fn(), updates: [] as unknown[], role: "admin", org: { settings: {} } as any, reps: [] as any[], emptyUpdate: false, tables: {} as Record<string, { data: unknown }> }));
vi.mock("@aula-agente/database", () => ({
  createOpportunity: m.createOpportunity, addOpportunityEvent: m.addOpportunityEvent,
  getAdminClient: () => ({
    from: (table: string) => {
      const chain: any = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, update: (v: unknown) => { m.updates.push(v); return chain; }, single: async () => ({ data: { id: "existing-opp", ...(m.updates.at(-1) as object) }, error: null }), maybeSingle: async () => (m.updates.length && table === "opportunities" ? { data: m.emptyUpdate ? null : { id: "existing-opp", ...(m.updates.at(-1) as object) }, error: null } : { data: m.tables[table]?.data ?? null, error: null }) };
      return chain;
    },
  }),
  freezeOpportunity: vi.fn(), getUnidentifiedSalesContacts: vi.fn(), getOrganizationById: async () => m.org, getOpportunitiesByOrganization: vi.fn(), getOpportunityById: vi.fn(),
  getContactById: vi.fn(), getQualificationByConversationId: vi.fn(), getOpportunityEvents: vi.fn(), getOpenTasksByContact: vi.fn(), decryptCpf: vi.fn(), listSalesReps: async () => m.reps,
}));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "user-1", memberships: [{ organization_id: "org-1", role: m.role }] }; } }));
import routes from "./index.js";

const payload = { contact_id: "6f1b8c5e-1c1b-4b0e-9d2a-3a5b6c7d8e9f", operation: "consortium", stage: "interest_received", owner_id: "6f1b8c5e-1c1b-4b0e-9d2a-3a5b6c7d8e90", next_action: "Ligar", next_action_due_date: "2026-10-25" };
let payload2: any = null;
async function post(body: any = payload) { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "POST", url: "/organizations/org-1/opportunities", payload: body }); await app.close(); return r; }

beforeEach(() => {
  vi.clearAllMocks(); m.updates = []; m.role = "admin"; m.org = { settings: {} }; m.reps = []; m.emptyUpdate = false;
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

  it("negócio aberto com operação 'a confirmar' (card do encaminhamento): grava TUDO que o vendedor enviou, limpa a marca e devolve o existente, sem 409", async () => {
    m.tables.opportunities = { data: { id: "existing-opp", operation: "vehicle_sale", stage: "interest_received", operation_is_default: true, owner_id: payload.owner_id } };
    payload2 = { ...payload, sale_amount: 25000, credit_amount: 26500, term_months: 80, product_model: "CG160", commercial_notes: "quer carta", usage_purpose: "trabalho", urgency: "alta", bid_amount: 3000 };
    const r = await post(payload2);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: "existing-opp", operation: "consortium", operation_is_default: false });
    expect(m.updates[0]).toMatchObject({ operation: "consortium", initial_operation: "consortium", stage: "interest_received", operation_is_default: false,
      next_action: "Ligar", next_action_due_date: "2026-10-25", sale_amount: 25000, credit_amount: 26500, term_months: 80, product_model: "CG160",
      commercial_notes: "quer carta", usage_purpose: "trabalho", urgency: "alta", bid_amount: 3000 });
    expect(m.createOpportunity).not.toHaveBeenCalled();
    expect(m.addOpportunityEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ opportunity_id: "existing-opp", event_type: "operation_changed", changed_by_type: "human" }));
  });

  it("campos não enviados não apagam o que o card já tem; dono do card só muda se a regra de atribuição permitir", async () => {
    m.tables.opportunities = { data: { id: "existing-opp", operation: "vehicle_sale", stage: "interest_received", operation_is_default: true, owner_id: "rep-original" } };
    await post(payload);
    expect(m.updates[0]).not.toHaveProperty("sale_amount");
    expect(m.updates[0]).not.toHaveProperty("commercial_notes");
    expect(m.updates[0]).toMatchObject({ owner_id: payload.owner_id }); // gestor pode reatribuir
    m.updates = []; m.role = "agent"; m.org = { settings: { lead_distribution_enabled: true } }; m.reps = [{ user_id: "rep-original" }, { user_id: payload.owner_id }];
    m.tables.opportunities = { data: { id: "existing-opp", operation: "vehicle_sale", stage: "interest_received", operation_is_default: true, owner_id: "user-1" } };
    await post(payload);
    expect(m.updates[0]).not.toHaveProperty("owner_id"); // vendedor não passa o lead a outro vendedor
  });

  it("vendedor que não é o dono do card não pode alterá-lo (canViewLead): 403", async () => {
    m.role = "agent"; m.org = { settings: { lead_distribution_enabled: true } }; m.reps = [{ user_id: "outro-vendedor" }];
    m.tables.opportunities = { data: { id: "existing-opp", operation: "vehicle_sale", stage: "interest_received", operation_is_default: true, owner_id: "outro-vendedor" } };
    const r = await post();
    expect(r.statusCode).toBe(403);
    expect(m.updates).toHaveLength(0);
  });

  it("a marca caiu entre a leitura e a gravação (automação confirmou o card): 409, nada sobrescrito", async () => {
    m.tables.opportunities = { data: { id: "existing-opp", operation: "vehicle_sale", stage: "interest_received", operation_is_default: true, owner_id: payload.owner_id } };
    m.emptyUpdate = true;
    const r = await post();
    expect(r.statusCode).toBe(409);
    expect(m.addOpportunityEvent).not.toHaveBeenCalled();
  });

  it("negócio aberto com operação confirmada (sem a marca): continua 409", async () => {
    m.tables.opportunities = { data: { id: "existing-opp", operation: "vehicle_sale", stage: "qualification", operation_is_default: false } };
    expect((await post()).statusCode).toBe(409);
    expect(m.updates).toHaveLength(0);
  });
});
