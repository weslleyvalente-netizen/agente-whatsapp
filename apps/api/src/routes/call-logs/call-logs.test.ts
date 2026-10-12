import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({
  role: { value: "agent" }, userId: { value: "marcio-user" },
  getOpportunityById: vi.fn(), listSalesReps: vi.fn(), getOrganizationById: vi.fn(),
  insertedRow: { value: null as any }, logs: { value: [] as any[] }, tables: {} as Record<string, any[]>, inserted: [] as any[],
}));
vi.mock("@aula-agente/database", () => ({
  getOpportunityById: m.getOpportunityById, listSalesReps: m.listSalesReps, getOrganizationById: m.getOrganizationById,
  getAdminClient: () => ({
    from: (table: string) => {
      const c: any = {
        insert: (row: any) => { m.inserted.push(row); c._ins = row; return c; },
        select: () => c, eq: () => c, gte: () => c, lt: () => c, in: () => c, order: () => c,
        single: async () => ({ data: { id: "log-1", ...c._ins }, error: null }),
        then: (res: any) => res({ data: m.tables[table] ?? [], error: null }),
      };
      return c;
    },
  }),
}));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: m.userId.value, memberships: [{ organization_id: "org-1", role: m.role.value }] }; } }));
import routes from "./index.js";

const OPP = "aaaaaaaa-0000-0000-0000-000000000001"; // último dígito ímpar → call_only
async function call(method: "GET" | "POST", url: string, payload?: unknown) {
  const app = Fastify(); await app.register(routes);
  const r = await app.inject({ method, url, payload: payload as any }); await app.close(); return r;
}
beforeEach(() => {
  vi.clearAllMocks(); m.role.value = "agent"; m.userId.value = "marcio-user"; m.inserted.length = 0; m.tables = {};
  m.getOpportunityById.mockResolvedValue({ id: OPP, organization_id: "org-1", contact_id: "c", owner_id: "marcio-user" });
  m.getOrganizationById.mockResolvedValue({ settings: { seller_isolation_enabled: true } });
  m.listSalesReps.mockResolvedValue([{ user_id: "marcio-user", display_name: "Márcio" }, { user_id: "marina-user", display_name: "Marina" }]);
});

describe("POST /opportunities/:id/call-logs", () => {
  const body = { strategy: "message_first", outcome: "answered", note: " falou do prazo " };
  it("grava com rep_user_id do usuário logado e sugestão calculada no servidor", async () => {
    const r = await call("POST", `/opportunities/${OPP}/call-logs`, body);
    expect(r.statusCode).toBe(201);
    expect(m.inserted[0]).toMatchObject({ organization_id: "org-1", opportunity_id: OPP, contact_id: "c", rep_user_id: "marcio-user", strategy: "message_first", suggested_strategy: "call_only", outcome: "answered", note: "falou do prazo" });
    expect(r.json().id).toBe("log-1");
  });
  it("ignora rep_user_id/suggested_strategy vindos do cliente", async () => {
    await call("POST", `/opportunities/${OPP}/call-logs`, { ...body, rep_user_id: "outro", suggested_strategy: "message_first" });
    expect(m.inserted[0].rep_user_id).toBe("marcio-user"); expect(m.inserted[0].suggested_strategy).toBe("call_only");
  });
  it("vendedor não registra em lead de outro vendedor", async () => {
    m.getOpportunityById.mockResolvedValue({ id: OPP, organization_id: "org-1", contact_id: "c", owner_id: "marina-user" });
    const r = await call("POST", `/opportunities/${OPP}/call-logs`, body);
    expect(r.statusCode).toBe(403); expect(m.inserted).toHaveLength(0);
  });
  it("gestor registra em lead de qualquer vendedor", async () => {
    m.role.value = "admin"; m.getOpportunityById.mockResolvedValue({ id: OPP, organization_id: "org-1", contact_id: "c", owner_id: "marina-user" });
    expect((await call("POST", `/opportunities/${OPP}/call-logs`, body)).statusCode).toBe(201);
  });
  it("recusa quem não é membro da organização do lead", async () => {
    m.getOpportunityById.mockResolvedValue({ id: OPP, organization_id: "outra", contact_id: "c", owner_id: null });
    expect((await call("POST", `/opportunities/${OPP}/call-logs`, body)).statusCode).toBe(403);
  });
  it("400 para estratégia ou resultado inválidos", async () => {
    expect((await call("POST", `/opportunities/${OPP}/call-logs`, { ...body, strategy: "x" })).statusCode).toBe(400);
    expect((await call("POST", `/opportunities/${OPP}/call-logs`, { ...body, outcome: "x" })).statusCode).toBe(400);
  });
});

describe("GET /opportunities/:id/call-logs", () => {
  it("lista as ligações do lead e a sugestão", async () => {
    m.tables.sales_call_logs = [{ id: "l1" }];
    const r = await call("GET", `/opportunities/${OPP}/call-logs`);
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ logs: [{ id: "l1" }], suggestedStrategy: "call_only" });
  });
  it("403 para lead de outro vendedor", async () => {
    m.getOpportunityById.mockResolvedValue({ id: OPP, organization_id: "org-1", contact_id: "c", owner_id: "marina-user" });
    expect((await call("GET", `/opportunities/${OPP}/call-logs`)).statusCode).toBe(403);
  });
});

describe("GET /organizations/:id/call-report", () => {
  const url = "/organizations/org-1/call-report?from=2026-10-01&to=2026-10-12";
  beforeEach(() => {
    m.role.value = "owner";
    m.tables.sales_call_logs = [
      { opportunity_id: "a", rep_user_id: "marcio-user", strategy: "message_first", outcome: "answered" },
      { opportunity_id: "a", rep_user_id: "marcio-user", strategy: "message_first", outcome: "no_answer" },
      { opportunity_id: "b", rep_user_id: "marina-user", strategy: "call_only", outcome: "answered" },
      { opportunity_id: "c", rep_user_id: "marina-user", strategy: "call_only", outcome: "no_interest" },
    ];
    m.tables.opportunities = [
      { id: "a", status: "open", stage: "qualification" },
      { id: "b", status: "won", stage: "formalization" },
      { id: "c", status: "open", stage: "qualification" },
    ];
    m.tables.opportunity_events = [{ opportunity_id: "a", new_value: { stage: "proposal_sent" } }, { opportunity_id: "c", new_value: { stage: "qualification" } }];
  });
  it("não-gestor recebe 403", async () => {
    m.role.value = "agent"; expect((await call("GET", url)).statusCode).toBe(403);
  });
  it("400 sem período válido", async () => {
    expect((await call("GET", "/organizations/org-1/call-report")).statusCode).toBe(400);
    expect((await call("GET", "/organizations/org-1/call-report?from=2026-10-12&to=2026-10-01")).statusCode).toBe(400);
  });
  it("agrega por estratégia (proposta alcançada via evento) e por vendedor", async () => {
    const r = await call("GET", url); expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.byStrategy.message_first).toMatchObject({ calls: 2, answered: 1, leads: 1, leadsWithProposalOrVisit: 1, won: 0 });
    expect(j.byStrategy.call_only).toMatchObject({ calls: 2, answered: 1, leads: 2, leadsWithProposalOrVisit: 1, won: 1, noInterest: 1 });
    expect(j.byStrategy.call_only.wonRate).toBeCloseTo(0.5);
    expect(j.byRep.map((x: any) => [x.repName, x.total.calls]).sort()).toEqual([["Márcio", 2], ["Marina", 2]]);
  });
});
