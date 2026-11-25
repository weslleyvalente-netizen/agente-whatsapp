// Classificação da intenção de um cliente que volta depois de negócio fechado (card novo só com intenção comercial).
// Usa o CONTEXTO RECENTE da conversa, não só o motivo do encaminhamento ou o título da tarefa (casos Clemilson e Rosângela 25/11:
// o motivo vinha "fora_do_escopo" nos dois; um era pós-venda, o outro compra). Erro do modelo => 'unclear' (vai para revisão).
import { generateObject } from "ai";
import { z } from "zod";

export const OPERATIONS = ["vehicle_sale", "consortium", "financing", "libera_cred", "contemplated_letter"] as const;
export type Operation = (typeof OPERATIONS)[number];
export type Intent = "commercial" | "administrative" | "unclear";

export interface ContextMessage {
  id: string;
  role: string;
  content: string | null;
  created_at: string;
}

export interface IntentClassification {
  intent: Intent;
  operation: Operation | null;
  customer_gave_specifics: boolean;
  proposal_message_id: string | null;
  reason: string;
}

// Respostas automáticas de WhatsApp Business e robôs de outras empresas (caso Erica 13/11, financeira 24/11).
const AUTO_REPLY = [
  /fora do hor[aá]rio de atendimento/i,
  /mensagem autom[aá]tica/i,
  /n[aã]o consigo entender textos com mais de/i,
  /digite qualquer palavra/i,
  /responderemos (assim que|em breve)/i,
  /obrigad[oa] (pelo|por entrar em) contato.{0,40}(em breve|retornaremos)/i,
];
export function isAutoReply(text: string | null | undefined): boolean {
  return !!text && AUTO_REPLY.some((r) => r.test(text));
}

/** Mensagens do cliente depois do fechamento são todas resposta automática => administrativa, sem chamar o modelo. */
export function prefilter(customerMessages: ContextMessage[]): IntentClassification | null {
  const texts = customerMessages.map((m) => m.content ?? "").filter((t) => t.trim());
  if (texts.length > 0 && texts.every(isAutoReply)) {
    return { intent: "administrative", operation: null, customer_gave_specifics: false, proposal_message_id: null, reason: "Somente respostas automáticas do contato" };
  }
  return null;
}

const PROPOSAL_STAGE: Record<Operation, string | null> = {
  vehicle_sale: "proposal_sent",
  consortium: "simulation_sent",
  libera_cred: "plan_term_presented",
  contemplated_letter: "proposal_sent",
  financing: null, // resultado bancário/simulação exige registro humano (mesma regra do sync_sales_pipeline)
};

/**
 * Etapa do card novo: inicial por padrão; qualificação se o cliente já deu detalhes (modelo, valor, entrada);
 * etapa de proposta só se o modelo apontou uma mensagem NOSSA, enviada no contexto, que contém a proposta.
 */
export function decideStage(c: IntentClassification, context: ContextMessage[]): string {
  if (!c.operation) return "interest_received";
  const proposal = PROPOSAL_STAGE[c.operation];
  if (proposal && c.proposal_message_id) {
    const m = context.find((x) => x.id === c.proposal_message_id);
    if (m && (m.role === "agent" || m.role === "human_agent")) return proposal;
  }
  return c.customer_gave_specifics ? "qualification" : "interest_received";
}

const schema = z.object({
  intent: z.enum(["commercial", "administrative", "unclear"]),
  operation: z.enum(OPERATIONS).nullable(),
  customer_gave_specifics: z.boolean(),
  proposal_message_id: z.string().nullable(),
  reason: z.string().max(400),
});

export const SYSTEM_PROMPT = `Você classifica se um cliente que JÁ TEVE negócio encerrado (comprou ou desistiu) voltou com uma NOVA intenção de compra.
Leia o histórico recente da conversa (mais antigo primeiro). Responda em JSON.
- intent "commercial": o cliente quer comprar/contratar algo agora (moto, carro, bike, consórcio, carta contemplada, financiamento, Libera Cred), pede preço, fotos, simulação, condições, ou retoma uma negociação.
- intent "administrative": pós-venda e assuntos sem nova compra: boleto, parcela, comprovante, documento/Detran, entrega, retirada, assembleia, lance de consórcio já contratado, defeito, troca ou ajuste do que já comprou, suporte, agradecimento, "já comprei em outro lugar", resposta automática, mensagem de empresa/robô.
- intent "unclear": não dá para saber (só arquivos sem explicação, "quem é?", áudio não transcrito, saudação solta).
Pedido de troca do produto que o cliente JÁ comprou é administrativo, a menos que ele peça para comprar outro produto novo.
operation: a operação da NOVA intenção (vehicle_sale, consortium, financing, libera_cred, contemplated_letter) ou null.
customer_gave_specifics: true se o cliente informou modelo, valor, entrada, prazo ou dados para análise.
proposal_message_id: id de uma mensagem NOSSA (agent/human_agent) do histórico que apresenta proposta concreta com valores para essa intenção; senão null.
reason: uma frase em português citando o que o cliente pediu.`;

export function buildPrompt(params: { previous: { status: string; lost_reason: string | null; operation: string } | null; triggerSummary: string | null; context: ContextMessage[] }): string {
  const lines = params.context.map((m) => `[${m.id}] ${m.created_at.slice(0, 16)} ${m.role}: ${(m.content ?? "").replace(/\s+/g, " ").slice(0, 500)}`);
  return [
    params.previous ? `Negócio anterior: ${params.previous.status}${params.previous.lost_reason ? ` (${params.previous.lost_reason})` : ""}, operação ${params.previous.operation}.` : "",
    params.triggerSummary ? `Resumo do encaminhamento/tarefa: ${params.triggerSummary}` : "",
    "Histórico:",
    ...lines,
  ].filter(Boolean).join("\n");
}

export type Generate = (args: { system: string; prompt: string }) => Promise<IntentClassification>;

export function modelGenerate(model: Parameters<typeof generateObject>[0]["model"]): Generate {
  return async ({ system, prompt }) =>
    (await generateObject({ model, schema, system, prompt, abortSignal: AbortSignal.timeout(30_000) })).object as IntentClassification;
}

export async function classifyReturningIntent(
  params: { previous: { status: string; lost_reason: string | null; operation: string } | null; triggerSummary: string | null; context: ContextMessage[]; customerMessagesSinceClose: ContextMessage[] },
  generate: Generate
): Promise<IntentClassification> {
  const pre = prefilter(params.customerMessagesSinceClose);
  if (pre) return pre;
  if (params.customerMessagesSinceClose.length === 0) {
    return { intent: "unclear", operation: null, customer_gave_specifics: false, proposal_message_id: null, reason: "Nenhuma mensagem do cliente depois do fechamento" };
  }
  try {
    const out = await generate({ system: SYSTEM_PROMPT, prompt: buildPrompt(params) });
    const parsed = schema.safeParse(out);
    if (!parsed.success) throw new Error("classificação inválida");
    const c = parsed.data as IntentClassification;
    if (c.intent === "commercial" && !c.operation) return { ...c, intent: "unclear", reason: `${c.reason} (operação não identificada)` };
    return c;
  } catch (error) {
    return { intent: "unclear", operation: null, customer_gave_specifics: false, proposal_message_id: null, reason: `Falha na classificação: ${(error as Error).message}`.slice(0, 400) };
  }
}
