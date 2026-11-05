import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const m = vi.hoisted(() => ({
  getOpportunityById: vi.fn(), getOrganizationById: vi.fn(), getContactById: vi.fn(), getAgentById: vi.fn(), getRecentMessages: vi.fn(),
  getQualificationByConversationId: vi.fn(), listNudgeTasksByConversation: vi.fn(), eq: vi.fn(), conversation: vi.fn(), handoff: vi.fn(),
  canViewLead: vi.fn(), resolveApiKey: vi.fn(), generate: vi.fn(), prepare: vi.fn(), role: { value: "seller" }, memberOrg: { value: "org-1" },
}));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({ from: (table: string) => {
    const c: any = { select: () => c, eq: (...a: any[]) => { m.eq(table, ...a); return c; }, order: () => c, limit: () => c, maybeSingle: () => (table === "handoff_events" ? m.handoff() : m.conversation()) };
    return c;
  } }),
  getOpportunityById: m.getOpportunityById, getOrganizationById: m.getOrganizationById, getContactById: m.getContactById, getAgentById: m.getAgentById,
  getRecentMessages: m.getRecentMessages, getQualificationByConversationId: m.getQualificationByConversationId, listNudgeTasksByConversation: m.listNudgeTasksByConversation,
}));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey: m.resolveApiKey, generateSellerMessageSuggestion: m.generate }));
vi.mock("../../lib/lead-access.js", () => ({ canViewLead: m.canViewLead }));
vi.mock("../../services/followup-audio-context.service.js", () => ({ prepareFollowupAudioContext: m.prepare }));
vi.mock("../../middleware/auth.js", () => ({ authMiddleware: async (req: any) => { req.user = { id: "user-1", memberships: [{ organization_id: m.memberOrg.value, role: m.role.value }] }; } }));
import routes, { resetSuggestionLimitForTests, SUGGESTION_LIMIT_PER_HOUR, firstNameOf, countCurrentCycleNudges } from "./message-suggestion.js";

const opportunity = { id: "opp-1", organization_id: "org-1", contact_id: "contact-1", owner_id: "user-1", status: "open", stage: "qualified", operation: "consorcio_moto", product_model: "Factor 150", credit_amount: 15000, target_installment_amount: 700 };
const URL = "/opportunities/opp-1/message-suggestion";
async function post(payload?: unknown) { const app = Fastify(); await app.register(routes); const r = await app.inject({ method: "POST", url: URL, payload: payload as any }); await app.close(); return r; }

beforeEach(() => {
  vi.clearAllMocks(); resetSuggestionLimitForTests(); m.role.value = "seller"; m.memberOrg.value = "org-1";
  m.getOpportunityById.mockResolvedValue(opportunity);
  m.getOrganizationById.mockResolvedValue({ id: "org-1", settings: { seller_message_suggestion_enabled: true } });
  m.canViewLead.mockResolvedValue(true);
  m.getContactById.mockResolvedValue({ id: "contact-1", organization_id: "org-1", name: "Ana Souza", metadata: { lead_origin: { source: "instagram_ads" } } });
  m.conversation.mockResolvedValue({ data: { id: "conv-1", agent_id: "agent-1", organization_id: "org-1" }, error: null });
  m.handoff.mockResolvedValue({ data: { resumo: "Quer uma Factor", handed_at: "2026-10-01T10:00:00Z" }, error: null });
  m.getRecentMessages.mockResolvedValue([{ role: "contact", content: "Oi", created_at: "2026-10-01T09:00:00Z" }]);
  m.prepare.mockImplementation(async (_db: unknown, _c: unknown, messages: unknown[]) => ({ messages, changed: false }));
  m.getQualificationByConversationId.mockResolvedValue({ organization_id: "org-1", summary: "Primeira moto" });
  m.listNudgeTasksByConversation.mockResolvedValue([{}, {}]);
  m.getAgentById.mockResolvedValue({ id: "agent-1", provider: "anthropic", model: "claude-sonnet-5" });
  m.resolveApiKey.mockResolvedValue("key");
  m.generate.mockResolvedValue({ ok: true, message: "Oi Ana! Qual parcela cabe por mês?" });
});

describe("POST /opportunities/:id/message-suggestion", () => {
  it("devolve { message, mode } e monta o contexto filtrado pela organização", async () => {
    const r = await post({});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ message: "Oi Ana! Qual parcela cabe por mês?", mode: "first_contact" });
    const args = m.generate.mock.calls[0][0];
    expect(args).toMatchObject({ organizationId: "org-1", mode: "first_contact", context: { customerFirstName: "Ana", originLabel: "Instagram — anúncio", handoffSummary: "Quer uma Factor", nudgeCount: 2 } });
    expect(args.previousMessage).toBeUndefined();
    expect(m.eq).toHaveBeenCalledWith("conversations", "organization_id", "org-1");
    expect(m.eq).toHaveBeenCalledWith("handoff_events", "organization_id", "org-1");
    expect(m.listNudgeTasksByConversation).toHaveBeenCalledWith(expect.anything(), "org-1", "conv-1");
  });
  it("modo padrão é follow-up quando há mensagem de humano depois do encaminhamento; o corpo pode trocar", async () => {
    m.getRecentMessages.mockResolvedValue([{ role: "human_agent", content: "Oi Ana", created_at: "2026-10-01T11:00:00Z" }]);
    expect((await post({})).json().mode).toBe("followup");
    expect((await post({ mode: "first_contact" })).json().mode).toBe("first_contact");
  });
  it("só repassa previousMessage ao regenerar", async () => {
    await post({ regenerate: true, previousMessage: "Anterior" });
    expect(m.generate.mock.calls[0][0].previousMessage).toBe("Anterior");
    await post({ previousMessage: "Anterior" });
    expect(m.generate.mock.calls[1][0].previousMessage).toBeUndefined();
  });
  it("400 para modo inválido, sem gerar", async () => {
    expect((await post({ mode: "outro" })).statusCode).toBe(400);
    expect(m.generate).not.toHaveBeenCalled();
  });
  it("403 sem membership na organização do negócio, sem ler dados pessoais", async () => {
    m.memberOrg.value = "org-2";
    expect((await post({})).statusCode).toBe(403);
    expect(m.getContactById).not.toHaveBeenCalled(); expect(m.generate).not.toHaveBeenCalled();
  });
  it.each([false, undefined, "true", 1])("404 com a chave desligada (%s)", async value => {
    m.getOrganizationById.mockResolvedValue({ id: "org-1", settings: { seller_message_suggestion_enabled: value } });
    expect((await post({})).statusCode).toBe(404);
    expect(m.generate).not.toHaveBeenCalled();
  });
  it("403 quando o vendedor não pode ver o lead (isolamento por vendedor)", async () => {
    m.canViewLead.mockResolvedValue(false);
    expect((await post({})).statusCode).toBe(403);
    expect(m.canViewLead).toHaveBeenCalledWith(expect.anything(), "org-1", "seller", "user-1", "user-1");
    expect(m.getContactById).not.toHaveBeenCalled(); expect(m.generate).not.toHaveBeenCalled();
  });
  it("403 se o contato é de outra organização", async () => {
    m.getContactById.mockResolvedValue({ id: "contact-1", organization_id: "org-2", name: "Ana" });
    expect((await post({})).statusCode).toBe(403);
    expect(m.generate).not.toHaveBeenCalled();
  });
  it("400 para negócio fechado e 409 sem conversa", async () => {
    m.getOpportunityById.mockResolvedValue({ ...opportunity, status: "won" });
    expect((await post({})).statusCode).toBe(400);
    m.getOpportunityById.mockResolvedValue(opportunity);
    m.conversation.mockResolvedValue({ data: null, error: null });
    const r = await post({});
    expect(r.statusCode).toBe(409); expect(r.json().reason).toBe("no_conversation");
  });
  it("422 quando há áudio sem transcrição", async () => {
    m.prepare.mockRejectedValue(new Error("Há áudio sem transcrição"));
    const r = await post({});
    expect(r.statusCode).toBe(422); expect(r.json().reason).toBe("incomplete_audio_context");
    expect(m.generate).not.toHaveBeenCalled();
  });
  it("429 depois do limite por usuário", async () => {
    for (let i = 0; i < SUGGESTION_LIMIT_PER_HOUR; i++) expect((await post({})).statusCode).toBe(200);
    const r = await post({});
    expect(r.statusCode).toBe(429); expect(r.json().reason).toBe("rate_limited");
    expect(m.generate).toHaveBeenCalledTimes(SUGGESTION_LIMIT_PER_HOUR);
  });
  it("503 quando o gerador falha ou a chave não resolve", async () => {
    m.generate.mockResolvedValue({ ok: false });
    const r = await post({});
    expect(r.statusCode).toBe(503); expect(r.json()).toMatchObject({ reason: "generation_failed", error: "Não foi possível gerar. Tente de novo." });
    m.resolveApiKey.mockRejectedValue(new Error("sem chave")); vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post({})).statusCode).toBe(503);
  });
});

describe("limite e ciclo", () => {
  it("422 e 503 devolvem a vaga", async () => {
    m.prepare.mockRejectedValue(new Error("x"));
    for (let i = 0; i < SUGGESTION_LIMIT_PER_HOUR + 2; i++) expect((await post({})).statusCode).toBe(422);
    m.prepare.mockImplementation(async (_d: unknown, _c: unknown, messages: unknown[]) => ({ messages, changed: false }));
    m.generate.mockResolvedValue({ ok: false });
    for (let i = 0; i < SUGGESTION_LIMIT_PER_HOUR + 2; i++) expect((await post({})).statusCode).toBe(503);
  });
  it("conta só cutucadas depois da última mensagem do cliente", async () => {
    m.listNudgeTasksByConversation.mockResolvedValue([{ createdAt: "2026-09-01T00:00:00Z" }, { createdAt: "2026-10-02T00:00:00Z" }]);
    await post({});
    expect(m.generate.mock.calls[0][0].context.nudgeCount).toBe(1);
    expect(countCurrentCycleNudges([{ createdAt: "2026-09-01T00:00:00Z" }], null)).toBe(1);
  });
});

describe("firstNameOf", () => {
  it("pega o primeiro nome e ignora telefone/vazio", () => {
    expect(firstNameOf("Ana Souza")).toBe("Ana"); expect(firstNameOf("5561999999999")).toBeNull(); expect(firstNameOf("")).toBeNull(); expect(firstNameOf(null)).toBeNull();
  });
});
