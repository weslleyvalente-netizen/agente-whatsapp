import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
const m = vi.hoisted(() => ({ getOpportunityById: vi.fn(), getContactById: vi.fn(), getQualificationByConversationId: vi.fn(), getOpportunityEvents: vi.fn(), getOpenTasksByContact: vi.fn(), decryptCpf: vi.fn(() => "12345678901"), maybeSingle: vi.fn(), eq: vi.fn(), update: vi.fn() }));
vi.mock("@aula-agente/database", () => ({ ...m, getAdminClient: () => ({ from: () => { const c: any = { select: () => c, update: (value: unknown) => { m.update(value); return c; }, eq: (...a: any[]) => { m.eq(...a); return c; }, order: () => c, limit: () => c, maybeSingle: m.maybeSingle }; return c; }}), createOpportunity: vi.fn(), getOpportunitiesByOrganization: vi.fn(), addOpportunityEvent: vi.fn(), updateOpportunity: vi.fn() }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "user-1", memberships: [{ organization_id: "org-1", role: "admin" }] }; }}));
import routes from "./index.js";
const opportunity = { id: "opp-1", organization_id: "org-1", contact_id: "contact-1", status: "open", stage: "qualified" };
beforeEach(() => {
 vi.clearAllMocks(); m.getOpportunityById.mockResolvedValue(opportunity);
 m.getContactById.mockResolvedValue({ id: "contact-1", organization_id: "org-1", name: "Ana", phone: "5561999999999" });
 m.maybeSingle.mockResolvedValue({ data: { id: "conv-1", organization_id: "org-1", contact_id: "contact-1", last_message_at: "2026-09-30T20:00:00Z" }, error: null });
 m.getQualificationByConversationId.mockResolvedValue({ organization_id: "org-1", cpf_encrypted: "cipher", cpf_hash: "hash", summary: "Quer uma Factor", target_installment_amount: 700 });
 m.getOpportunityEvents.mockResolvedValue([{ id: "event-1", evidence: "Cliente escolheu o modelo" }]);
 m.getOpenTasksByContact.mockResolvedValue([{ id: "task-1", opportunity_id: "opp-1" }, { id: "other", opportunity_id: "opp-2" }]);
});
async function request(url: string) { const app = Fastify(); await app.register(routes); const res = await app.inject({ method: "GET", url }); await app.close(); return res; }
describe("opportunity detail", () => {
 it("returns contact, qualification, history and only linked tasks", async () => {
  const r = await request("/opportunities/opp-1/details"); expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ customer: { name: "Ana" }, qualification: { summary: "Quer uma Factor", target_installment_amount: 700 }, events: [{ id: "event-1" }], tasks: [{ id: "task-1" }] });
  expect(r.json().tasks).toHaveLength(1); expect(m.eq).toHaveBeenCalledWith("organization_id", "org-1");
 });
 it("never exposes CPF storage secrets and reveals only after an explicit request", async () => {
  const r = await request("/opportunities/opp-1/details"); expect(r.statusCode).toBe(200);
  expect(r.json().qualification.cpf).toBeNull(); expect(r.json().qualification.has_cpf).toBe(true);
  expect(JSON.stringify(r.json())).not.toContain("cipher"); expect(JSON.stringify(r.json())).not.toContain('"cpf_hash"'); expect(m.decryptCpf).not.toHaveBeenCalled();
  const reveal = await request("/opportunities/opp-1/details?revealCpf=true"); expect(reveal.json().qualification.cpf).toBe("12345678901");
 });
 it("denies other organizations before reading personal data", async () => {
  m.getOpportunityById.mockResolvedValue({ ...opportunity, organization_id: "org-2" });
  const r = await request("/opportunities/opp-1/details?revealCpf=true"); expect(r.statusCode).toBe(403); expect(m.getContactById).not.toHaveBeenCalled(); expect(m.decryptCpf).not.toHaveBeenCalled();
 });
 it("works without a conversation", async () => {
  m.maybeSingle.mockResolvedValue({ data: null, error: null }); const r = await request("/opportunities/opp-1/details");
  expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ conversation: null, qualification: null });
 });
});

describe("manual origin", () => {
 it("rejects invalid origins", async () => { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "PATCH", url: "/opportunities/opp-1/origin", payload: { source: "inventada" } }); expect(r.statusCode).toBe(400); await app.close(); });
 it("denies edits for other organizations", async () => { m.getOpportunityById.mockResolvedValue({ ...opportunity, organization_id: "org-2" }); const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "PATCH", url: "/opportunities/opp-1/origin", payload: { source: "site_wix" } }); expect(r.statusCode).toBe(403); await app.close(); });
});

describe("origin persistence", () => {
 it("saves a manual origin preserving metadata", async () => {
  m.getContactById.mockResolvedValue({ id: "contact-1", organization_id: "org-1", metadata: { tag: "cliente" } }); m.maybeSingle.mockResolvedValue({ data: { id: "contact-1" }, error: null });
  const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "PATCH", url: "/opportunities/opp-1/origin", payload: { source: "instagram_organic" } });
  expect(r.statusCode).toBe(200); expect(m.update).toHaveBeenCalledWith({ metadata: { tag: "cliente", lead_origin: expect.objectContaining({ source: "instagram_organic", method: "manual", changed_by_id: "user-1" }) } }); await app.close();
 });
 it("reports concurrent edits instead of overwriting metadata", async () => {
  m.getContactById.mockResolvedValue({ id: "contact-1", organization_id: "org-1", metadata: {} }); m.maybeSingle.mockResolvedValue({ data: null, error: null });
  const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "PATCH", url: "/opportunities/opp-1/origin", payload: { source: "site_wix" } }); expect(r.statusCode).toBe(409); await app.close();
 });
});

it("shows unlinked contact tasks without pulling another business's tasks",async()=>{
 m.getOpenTasksByContact.mockResolvedValue([{id:"linked",opportunity_id:"opp-1"},{id:"contact-only",opportunity_id:null},{id:"other-business",opportunity_id:"opp-2"}]);
 const r=await request("/opportunities/opp-1/details");expect(r.json().tasks.map((t:any)=>t.id)).toEqual(["linked","contact-only"]);
});
