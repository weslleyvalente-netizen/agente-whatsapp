import { describe, expect, it, vi } from "vitest";
import { classifyReturningIntent, decideStage, isAutoReply, prefilter, type ContextMessage, type IntentClassification } from "./returning-customer-intent.js";

const msg = (id: string, role: string, content: string, at = "2026-11-24T15:00:00Z"): ContextMessage => ({ id, role, content, created_at: at });
const cls = (over: Partial<IntentClassification> = {}): IntentClassification =>
  ({ intent: "commercial", operation: "vehicle_sale", customer_gave_specifics: false, proposal_message_id: null, reason: "Pediu fotos e valores", ...over });

describe("pré-filtro de resposta automática", () => {
  it("caso Erica e robô de financeira: só respostas automáticas => administrativa, sem chamar o modelo", async () => {
    expect(isAutoReply("Olá! No momento estou *fora do horário de atendimento*, mas assim que possível")).toBe(true);
    expect(isAutoReply("Desculpe! Eu ainda não consigo entender textos com mais de 100 caracteres")).toBe(true);
    expect(isAutoReply("Manda as fotos e os valores por favor")).toBe(false);
    const generate = vi.fn();
    const r = await classifyReturningIntent({ previous: null, triggerSummary: null, context: [], customerMessagesSinceClose: [msg("1", "contact", "Estou fora do horário de atendimento")] }, generate);
    expect(r.intent).toBe("administrative");
    expect(generate).not.toHaveBeenCalled();
    expect(prefilter([msg("1", "contact", "fora do horário de atendimento"), msg("2", "contact", "quero a fan")])).toBeNull();
  });
});

describe("classificação", () => {
  const base = { previous: { status: "lost", lost_reason: "sem_resposta", operation: "vehicle_sale" }, triggerSummary: "fora_do_escopo", context: [msg("1", "contact", "Mande fotos e valores")], customerMessagesSinceClose: [msg("1", "contact", "Mande fotos e valores")] };
  it("o modelo recebe o histórico recente (não só o resumo do encaminhamento)", async () => {
    const generate = vi.fn().mockResolvedValue(cls());
    await classifyReturningIntent(base, generate);
    expect(generate.mock.calls[0][0].prompt).toContain("[1] 2026-11-24T15:00 contact: Mande fotos e valores");
    expect(generate.mock.calls[0][0].prompt).toContain("Negócio anterior: lost (sem_resposta)");
  });
  it("erro ou resposta inválida do modelo => incerta (revisão), nunca cria", async () => {
    expect((await classifyReturningIntent(base, vi.fn().mockRejectedValue(new Error("timeout")))).intent).toBe("unclear");
    expect((await classifyReturningIntent(base, vi.fn().mockResolvedValue({ intent: "talvez" }))).intent).toBe("unclear");
  });
  it("comercial sem operação identificada vira incerta", async () => {
    expect((await classifyReturningIntent(base, vi.fn().mockResolvedValue(cls({ operation: null })))).intent).toBe("unclear");
  });
  it("sem mensagem do cliente depois do fechamento => incerta", async () => {
    const generate = vi.fn();
    expect((await classifyReturningIntent({ ...base, customerMessagesSinceClose: [] }, generate)).intent).toBe("unclear");
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("etapa do card novo", () => {
  const ctx = [msg("c1", "contact", "quero carro de 40 a 50 mil"), msg("h1", "human_agent", "Carta contemplada R$ 42.529 entrada R$ 17.252"), msg("c2", "contact", "a fan")];
  it("inicial por padrão; qualificação com detalhes do cliente", () => {
    expect(decideStage(cls(), ctx)).toBe("interest_received");
    expect(decideStage(cls({ customer_gave_specifics: true }), ctx)).toBe("qualification");
  });
  it("caso Pedro: proposta enviada só com mensagem NOSSA citada que existe no contexto", () => {
    expect(decideStage(cls({ operation: "contemplated_letter", proposal_message_id: "h1" }), ctx)).toBe("proposal_sent");
    expect(decideStage(cls({ operation: "consortium", proposal_message_id: "h1" }), ctx)).toBe("simulation_sent");
    expect(decideStage(cls({ operation: "contemplated_letter", proposal_message_id: "c1", customer_gave_specifics: true }), ctx)).toBe("qualification");
    expect(decideStage(cls({ operation: "contemplated_letter", proposal_message_id: "inventada" }), ctx)).toBe("interest_received");
  });
  it("financiamento nunca avança para etapa de resultado pela IA", () => {
    expect(decideStage(cls({ operation: "financing", proposal_message_id: "h1", customer_gave_specifics: true }), ctx)).toBe("qualification");
  });
});
