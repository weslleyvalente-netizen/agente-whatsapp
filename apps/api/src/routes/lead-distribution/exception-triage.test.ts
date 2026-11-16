import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})), getOrganizationById: vi.fn(), loadTriageItems: vi.fn(), recordExceptionEvent: vi.fn(),
  isPushConfigured: vi.fn(() => true), loadAlertReadinessRecipients: vi.fn(async () => [{ userId: "g", memberRole: "owner", pushDevices: 1 }]),
}));
vi.mock("@aula-agente/database", () => m);
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async () => {} }));
import Fastify from "fastify";
import routes from "./exception-triage.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const ASG = "55555555-5555-4555-8555-555555555555";
const REP = "33333333-3333-4333-8333-333333333333";

async function app(role: string, userId = "u1", orgId = ORG) {
  const f = Fastify();
  f.addHook("preHandler", async (req: any) => { req.user = { id: userId, email: "x", memberships: [{ organization_id: orgId, role }] }; });
  await f.register(routes);
  return f;
}
const item = (over: any = {}) => ({
  kind: "exception", contact: { name: "Edivan", phone: "5562999990000" }, chainReps: ["Márcio", "Marina"], events: [],
  assignment: { id: ASG, conversation_id: "c1", handoff_at: "2026-11-16T12:00:00Z", assigned_at: "2026-11-16T13:00:00Z", sla_due_at: null, exception_reason: "all_reps_sla_breached" },
  triage: { state: "aguardando_atendimento_comercial", group: "urgente", clientWaiting: true, waitingSince: "x", hasCommercialReply: false, needsOwnerConfirmation: false, accumulatedBusinessMinutes: 120, accumulatedWallMinutes: 150 },
  ...over,
});
beforeEach(() => { vi.clearAllMocks(); m.getOrganizationById.mockResolvedValue({ settings: { exception_triage_panel_enabled: true, exception_alerts_mode: "shadow" } }); m.loadTriageItems.mockResolvedValue([]); });

describe("GET /exception-triage", () => {
  const url = `/organizations/${ORG}/exception-triage`;
  it("vendedor (agent) recebe 403 e nada é consultado", async () => {
    const res = await (await app("agent")).inject({ method: "GET", url });
    expect(res.statusCode).toBe(403);
    expect(m.loadTriageItems).not.toHaveBeenCalled();
  });
  it("quem não é membro da organização recebe 403", async () => {
    const res = await (await app("owner", "u1", "99999999-9999-4999-8999-999999999999")).inject({ method: "GET", url });
    expect(res.statusCode).toBe(403);
  });
  it("flag desligada (padrão): { enabled:false } e nenhuma leitura de triagem", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: {} });
    const res = await (await app("owner")).inject({ method: "GET", url });
    expect(res.json()).toEqual({ enabled: false });
    expect(m.loadTriageItems).not.toHaveBeenCalled();
  });
  it("separa urgentes, respondidas e obsoletas; resolvidas ficam fora", async () => {
    m.loadTriageItems.mockResolvedValue([
      item(),
      item({ assignment: { ...item().assignment, id: "r1" }, triage: { ...item().triage, group: "respondida", state: "respondida_sem_aceite", clientWaiting: false, needsOwnerConfirmation: true } }),
      item({ kind: "alert", assignment: { ...item().assignment, id: "o1", exception_reason: null, sla_due_at: "2026-10-01T00:00:00Z" }, triage: { ...item().triage, group: "obsoleta", state: "obsoleta", clientWaiting: false } }),
      item({ assignment: { ...item().assignment, id: "x1" }, triage: { ...item().triage, group: null, state: "resolvida" } }),
    ]);
    const body = (await (await app("admin")).inject({ method: "GET", url })).json();
    expect(body.enabled).toBe(true);
    expect(body.alertsMode).toBe("shadow");
    expect(body.urgent.map((r: any) => r.id)).toEqual([ASG]);
    expect(body.answered.map((r: any) => r.id)).toEqual(["r1"]);
    expect(body.obsolete.map((r: any) => r.id)).toEqual(["o1"]);
    expect(body.urgent[0]).toMatchObject({ client: "Edivan", accumulatedBusinessMinutes: 120, handoffAt: "2026-11-16T12:00:00Z", chainReps: ["Márcio", "Marina"] });
  });
});

describe("POST /exception-events/:assignmentId", () => {
  const url = `/organizations/${ORG}/exception-events/${ASG}`;
  const post = async (role: string, payload: unknown) => (await app(role)).inject({ method: "POST", url, payload: payload as object });
  it("vendedor não reconhece nem resolve (403) e nada é gravado", async () => {
    expect((await post("agent", { kind: "acknowledged" })).statusCode).toBe(403);
    expect(m.recordExceptionEvent).not.toHaveBeenCalled();
  });
  it("flag desligada => 404, nada gravado", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: {} });
    expect((await post("owner", { kind: "acknowledged" })).statusCode).toBe(404);
    expect(m.recordExceptionEvent).not.toHaveBeenCalled();
  });
  it("registra com o ator da sessão (nunca do corpo)", async () => {
    m.recordExceptionEvent.mockResolvedValue("evt-1");
    const res = await post("owner", { kind: "resolved_confirmed", repId: REP, note: "  Marina assumiu  ", actorUserId: "forjado" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "evt-1" });
    expect(m.recordExceptionEvent).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, assignmentId: ASG, kind: "resolved_confirmed", actorUserId: "u1", note: "Marina assumiu", repId: REP });
  });
  it.each([[{ kind: "excluir" }], [{ kind: "acknowledged", repId: "nao-uuid" }], [{}]])("corpo inválido %j => 400", async payload => {
    expect((await post("owner", payload)).statusCode).toBe(400);
    expect(m.recordExceptionEvent).not.toHaveBeenCalled();
  });
  it("identificadores que não são UUID => 400 sem tocar no banco", async () => {
    const res = await (await app("owner")).inject({ method: "POST", url: `/organizations/${ORG}/exception-events/abc`, payload: { kind: "acknowledged" } });
    expect(res.statusCode).toBe(400);
    expect(m.getOrganizationById).not.toHaveBeenCalled();
  });
  it("conflito de resolução => 409; regra do banco => 400", async () => {
    m.recordExceptionEvent.mockRejectedValueOnce(new Error("A exceção já foi resolvida"));
    expect((await post("owner", { kind: "resolved_no_action", note: "x" })).statusCode).toBe(409);
    m.recordExceptionEvent.mockRejectedValueOnce(new Error("Informe o vendedor que assumiu"));
    expect((await post("owner", { kind: "resolved_confirmed" })).statusCode).toBe(400);
  });
});

describe("4) 'Sem ação necessária' com cliente aguardando", () => {
  const url = `/organizations/${ORG}/exception-events/${ASG}`;
  const post = async (payload: unknown) => (await app("owner")).inject({ method: "POST", url, payload: payload as object });
  const waiting = () => m.loadTriageItems.mockResolvedValue([item()]);
  const notWaiting = () => m.loadTriageItems.mockResolvedValue([item({ triage: { ...item().triage, clientWaiting: false, group: "respondida", state: "respondida_sem_aceite" } })]);
  const LONG = "Falei com o cliente por telefone e ele já fechou com a loja";

  it("cliente aguardando e sem justificativa: 409 e NADA é gravado", async () => {
    waiting();
    const res = await post({ kind: "resolved_no_action", note: LONG });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("client_waiting");
    expect(m.recordExceptionEvent).not.toHaveBeenCalled();
  });
  it("justificativa fora da lista fechada: 400 pelo schema, nada gravado", async () => {
    waiting();
    const res = await post({ kind: "resolved_no_action", note: LONG, waitingJustification: "qualquer_coisa" });
    expect(res.statusCode).toBe(400);
    expect(m.recordExceptionEvent).not.toHaveBeenCalled();
  });
  it("justificativa válida mas nota curta: 409", async () => {
    waiting();
    const res = await post({ kind: "resolved_no_action", note: "ok", waitingJustification: "cliente_desistiu" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("note_too_short");
    expect(m.recordExceptionEvent).not.toHaveBeenCalled();
  });
  it("justificativa válida + nota de 20+ caracteres: grava, com a justificativa dentro da nota auditável", async () => {
    waiting();
    const res = await post({ kind: "resolved_no_action", note: LONG, waitingJustification: "cliente_atendido_fora_do_crm" });
    expect(res.statusCode).toBe(200);
    expect(m.recordExceptionEvent.mock.calls[0][1].note).toBe(`[cliente aguardando: cliente_atendido_fora_do_crm] ${LONG}`);
  });
  it("sem cliente aguardando: a regra antiga (só nota) continua valendo", async () => {
    notWaiting();
    const res = await post({ kind: "resolved_no_action", note: "contato duplicado" });
    expect(res.statusCode).toBe(200);
    expect(m.recordExceptionEvent.mock.calls[0][1].note).toBe("contato duplicado");
  });
  it("o estado é relido no servidor: tela dizia 'não aguardando', mas o cliente escreveu depois => bloqueia", async () => {
    waiting(); // estado atual no servidor
    const res = await post({ kind: "resolved_no_action", note: LONG });
    expect(res.statusCode).toBe(409);
  });
  it("reconhecer e confirmar quem assumiu NÃO são bloqueados pelo cliente aguardando", async () => {
    waiting();
    expect((await post({ kind: "acknowledged" })).statusCode).toBe(200);
    expect((await post({ kind: "resolved_confirmed", repId: REP })).statusCode).toBe(200);
    expect(m.loadTriageItems).not.toHaveBeenCalled();
  });
});

describe("5) prontidão exposta no painel", () => {
  const url = `/organizations/${ORG}/exception-triage`;
  it("modo shadow/on: devolve a prontidão calculada (ok)", async () => {
    const body = (await (await app("owner")).inject({ method: "GET", url })).json();
    expect(body.readiness).toMatchObject({ ready: true, validManagerCount: 1, problems: [] });
  });
  it("sem destinatário administrativo ou sem aparelho: ready=false com os motivos", async () => {
    m.loadAlertReadinessRecipients.mockResolvedValueOnce([{ userId: "g", memberRole: "owner", pushDevices: 0 }]);
    const body = (await (await app("owner")).inject({ method: "GET", url })).json();
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.problems).toContain("recipient_without_device");
  });
  it("falha ao verificar vira null (a tela mostra 'não foi possível verificar'), sem derrubar o painel", async () => {
    m.loadAlertReadinessRecipients.mockRejectedValueOnce(new Error("db"));
    const res = await (await app("owner")).inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.json().readiness).toBeNull();
  });
  it("modo off: não consulta a prontidão", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: { exception_triage_panel_enabled: true } });
    await (await app("owner")).inject({ method: "GET", url });
    expect(m.loadAlertReadinessRecipients).not.toHaveBeenCalled();
  });
});
