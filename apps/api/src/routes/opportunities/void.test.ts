// Anular / desfazer anulação: só gestor, motivo obrigatório; a regra de papel é conferida de novo no banco (void_opportunity).
import { it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
const rpc = vi.hoisted(() => vi.fn());
const m = vi.hoisted(() => ({ getOpportunityById: vi.fn() }));
const role = vi.hoisted(() => ({ value: "admin" }));
vi.mock("@aula-agente/database", () => ({ ...m, getAdminClient: () => ({ rpc }), createOpportunity: vi.fn(), updateOpportunity: vi.fn(), addOpportunityEvent: vi.fn(),
  getUnidentifiedSalesContacts: vi.fn(), getOrganizationById: vi.fn(), getOpportunitiesByOrganization: vi.fn(), getContactById: vi.fn(), getQualificationByConversationId: vi.fn(),
  getOpportunityEvents: vi.fn(), getOpenTasksByContact: vi.fn(), decryptCpf: vi.fn(), freezeOpportunity: vi.fn() }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "gestor", memberships: [{ organization_id: "org", role: role.value }] }; } }));
import routes from "./index.js";

beforeEach(() => {
  vi.clearAllMocks(); role.value = "admin";
  m.getOpportunityById.mockResolvedValue({ id: "opp", organization_id: "org", status: "won" });
  rpc.mockResolvedValue({ data: { opportunity_id: "opp", previous: { status: "won" }, open_tasks: 0 }, error: null });
});
async function post(url: string, payload: unknown) {
  const app = Fastify(); await app.register(routes);
  const r = await app.inject({ method: "POST", url, payload: payload as any }); await app.close(); return r;
}
const REASON = "Card de pós-venda criado por cadastro @lid duplicado";

it("gestor anula com motivo: chama void_opportunity com o próprio usuário como autor", async () => {
  const r = await post("/opportunities/opp/void", { reason: REASON });
  expect(r.statusCode).toBe(200);
  expect(rpc).toHaveBeenCalledWith("void_opportunity", { p_opportunity: "opp", p_actor: "gestor", p_reason: REASON });
});

it("desfazer também é só do gestor e exige motivo", async () => {
  expect((await post("/opportunities/opp/unvoid", { reason: "Anulei o card errado, restaurando" })).statusCode).toBe(200);
  expect(rpc).toHaveBeenCalledWith("unvoid_opportunity", expect.objectContaining({ p_actor: "gestor" }));
  expect((await post("/opportunities/opp/unvoid", { reason: "" })).statusCode).toBe(400);
});

it("vendedor recebe 403, motivo curto 400, outra organização 403; nada chega ao banco", async () => {
  role.value = "member";
  expect((await post("/opportunities/opp/void", { reason: REASON })).statusCode).toBe(403);
  role.value = "admin";
  expect((await post("/opportunities/opp/void", { reason: "curto" })).statusCode).toBe(400);
  m.getOpportunityById.mockResolvedValue({ id: "opp", organization_id: "outra" });
  expect((await post("/opportunities/opp/void", { reason: REASON })).statusCode).toBe(403);
  expect(rpc).not.toHaveBeenCalled();
});

it("recusa do banco (papel conferido de novo) vira 403 com a mensagem", async () => {
  rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Somente gestores" } });
  const r = await post("/opportunities/opp/void", { reason: REASON });
  expect(r.statusCode).toBe(403);
  expect(r.json().error).toBe("Somente gestores");
});

it("negócio anulado: marcar ganho/perdido ou editar devolve 409 com orientação (sem chegar ao banco)", async () => {
  m.getOpportunityById.mockResolvedValue({ id: "opp", organization_id: "org", status: "void" });
  const app = Fastify(); await app.register(routes);
  for (const [method, url, payload] of [["POST", "/opportunities/opp/won", { evidence: "fechou" }], ["POST", "/opportunities/opp/lost", { evidence: "x", lost_reason: "sem_interesse" }],
    ["PATCH", "/opportunities/opp", { stage: "qualification" }]] as const) {
    const r = await app.inject({ method, url, payload: payload as any });
    expect(r.statusCode, url).toBe(409);
    expect(r.json().error).toMatch(/anulado/i);
  }
  await app.close();
});
