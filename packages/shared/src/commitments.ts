// Compromissos do vendedor: identificação de proposta enviada e de promessa de retorno. Funções puras (sem relógio global, banco ou log).
// Regra do dono (22/11/2026): só evidência forte vira proposta; na dúvida, não dispara o lembrete de 30 min. Imagem sozinha nunca
// conta (pode ser foto de moto) e a etapa "Negociação" não é prova de proposta.
import { addBusinessMinutes, isBusinessDate, localInstant, nextBusinessOpening, type BusinessCalendar } from "./business-calendar.js";
import { toISODateInTimeZone } from "./date.js";

/** Etapas do funil que indicam proposta/simulação apresentada (evento explícito). "negotiation" fica de fora de propósito. */
export const PROPOSAL_STAGES = ["proposal_sent", "simulation_sent", "plan_term_presented"] as const;
/** Mensagens mais antigas que isto (pelo horário original do WhatsApp) são histórico: não geram proposta nem promessa. */
export const COMMITMENT_HISTORY_WINDOW_MS = 24 * 60 * 60_000;
export const PROPOSAL_FOLLOWUP_MINUTES = 30;
export const PROMISE_QUICK_MINUTES = 30;
export const PROMISE_DEFAULT_MINUTES = 120;

const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// Valor em dinheiro. CPF (123.456.789-00) e telefone (99999-1234) não casam: milhar não pode ser seguido de ".", "-" ou dígito.
const MONEY = [
  /r\$ ?\d/,
  /\b\d+(?:[.,]\d+)? ?mil\b/,
  /\b\d{1,3}(?:\.\d{3})+,\d{2}\b(?![.\-\d])/,
  /\b\d{1,3}(?:\.\d{3})+\b(?![.\-\d,])/,
  /\b\d{2,6},\d{2}\b(?![.\-\d])/,
];
const COMMERCIAL_TERMS = ["parcela", "parcelas", "entrada", "credito", "proposta", "simulacao", "financiamento", "consorcio", "lance", "a vista", "valor", "prestacao", "prestacoes"];
const DOCUMENT_TERMS = /\b(proposta|simulacao|orcamento)\b/;

export interface ProposalEvidence { strong: boolean; evidence: string | null; excluded?: "reengagement" | "qualification_question" | "pending_check" }

// Simulação de 22/11/2026 (7 dias reais): mensagens que citam valor + termo comercial mas NÃO apresentam proposta nova.
// Retomada de conversa: a abertura remete ao que já foi falado ("vi que…", "conforme combinado", "fiquei pensando…").
const REENGAGEMENT = /\b(vi que|soube que|sei que|(fiquei|ficou|estive|tava|to|estou) pensando|(fiquei|ficou) naquela|passando (aqui )?(pra|para|so)|conforme combinado|como (a gente )?combin|combinou|ficamos sem resposta|ainda tem interesse|ficou alguma duvida|pensou (mais|melhor|sobre)|conseguiu (vender|juntar|separar|resolver|ver|falar)|retomando|lembra (da|do|que))\b/;
const REENGAGEMENT_OPENING_CHARS = 140;
// Pergunta de qualificação: quer saber quanto o cliente pode pagar/tem; no máximo UM valor citado (oferta com opções tem vários).
const QUALIFICATION = /\b(quanto|qual( o| e)? valor|pretende|consegue|possui|tem (de|pra|para|disponivel)|teria|dispoe)\b/;
// Pergunta mesmo sem "?": a mensagem já começa perguntando.
const QUESTION_OPENING = /^(qual|quais|quanto|quanta|quantos|quantas)\b/;
// O vendedor diz que VAI verificar/consultar: é promessa (vira tarefa de retorno), não apresentação de proposta.
const PENDING_CHECK = /\bvou (verificar|consultar|ver|confirmar|checar|conferir|analisar|levantar|olhar)\b/;

/** Quantos valores em dinheiro distintos o texto cita (trechos sobrepostos de padrões diferentes contam uma vez). */
function moneyMentions(text: string): number {
  const spans: Array<[number, number]> = [];
  for (const r of MONEY) for (const m of text.matchAll(new RegExp(r.source, "g"))) spans.push([m.index!, m.index! + m[0].length]);
  spans.sort((a, b) => a[0] - b[0]);
  let count = 0, end = -1;
  for (const [s, e] of spans) { if (s > end) count++; end = Math.max(end, e); }
  return count;
}

export function detectProposalEvidence(input: { content?: string | null; mediaType?: string | null; fileName?: string | null }): ProposalEvidence {
  const text = normalize(input.content ?? "");
  const media = input.mediaType ?? "text";
  if (media === "document") {
    const where = normalize(`${input.fileName ?? ""} ${text}`);
    const m = where.match(DOCUMENT_TERMS);
    if (m) return { strong: true, evidence: `documento com "${m[1]}"` };
  }
  if (!text) return { strong: false, evidence: null };
  const money = MONEY.some((r) => r.test(text));
  const term = COMMERCIAL_TERMS.find((t) => new RegExp(`\\b${t}\\b`).test(text));
  if (!(money && term)) return { strong: false, evidence: null };
  if (REENGAGEMENT.test(text.slice(0, REENGAGEMENT_OPENING_CHARS))) return { strong: false, evidence: null, excluded: "reengagement" };
  if ((text.includes("?") || QUESTION_OPENING.test(text)) && QUALIFICATION.test(text) && moneyMentions(text) <= 1) return { strong: false, evidence: null, excluded: "qualification_question" };
  if (PENDING_CHECK.test(text)) return { strong: false, evidence: null, excluded: "pending_check" };
  return { strong: true, evidence: `valor + termo "${term}"` };
}

/** Motivo (texto exibido) das tarefas criadas pela rotina de compromissos. Só informativo: a marca é tasks.commitment_kind. */
export const COMMITMENT_TASK_REASON = {
  return_customer: "Promessa de retorno do vendedor ao cliente.",
  proposal_followup: "Proposta enviada sem resposta do cliente.",
} as const;
export type CommitmentTaskType = keyof typeof COMMITMENT_TASK_REASON;

/**
 * A tarefa é da rotina de compromissos? Essas tarefas nunca recebem pendência de outro fluxo nem entram numa tarefa de outro
 * fluxo: cada promessa mantém o próprio prazo e só é encerrada pela conclusão dela mesma, entrega comprovada ou negócio fechado.
 * A marca é a coluna commitment_kind, gravada só na criação pela rotina: a edição da tarefa (motivo, tipo, descrição) não a altera.
 */
export function isCommitmentTask(task: { commitment_kind?: string | null; type?: string | null; reason?: string | null }): boolean {
  return !!task.commitment_kind;
}

export type PromiseKind = "quick" | "standard" | "explicit_time" | "tomorrow";
export interface SellerPromise { kind: PromiseKind; dueAt: Date; phrase: string }

const NEG = "(?<!nao )(?<!nao eu )";
const QUICK = new RegExp(`${NEG}\\b(ja te (falo|respondo|retorno|passo|mando|envio|digo)|so um (instante|momento|minuto|minutinho|pouquinho)|um (instante|momento|minutinho)|ja volto|aguarda (um|so um) (pouco|pouquinho|instante|minutinho))\\b`);
const STANDARD = new RegExp(`${NEG}\\b(vou (verificar|consultar|ver|confirmar|checar|conferir|analisar|levantar|olhar)|te retorno|retorno (em breve|ja|logo)|vou te retornar|te dou um retorno|ja ja te (falo|retorno)|vou te passar)\\b`);
const PROMISE_VERB = /\b(retorno|retornar|respondo|responder|chamo|ligo|falo|mando|envio|passo|aviso|confirmo|verifico)\b/;
// Horário: "às 15", "às 15h", "por volta das 9:30"; "até" só com unidade ou minutos ("até 16h", "até 16:30") — "até 10 vezes" não.
const TIME = /\b(?:as|ate as|por volta das)\s*(\d{1,2})(?:[:h](\d{2}))?\s*(?:h|hs|horas)?\b|\bate\s*(\d{1,2})(?:[:h](\d{2})|\s*(?:h|hs|horas)\b)/;

function nextBusinessDateAfter(isoDate: string, calendar: BusinessCalendar): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  for (let i = 1; i <= 30; i++) {
    const t = new Date(Date.UTC(y, mo - 1, d + i));
    const iso = t.toISOString().slice(0, 10);
    if (isBusinessDate(iso, calendar)) return iso;
  }
  return isoDate;
}

/**
 * Promessa de retorno do vendedor e o prazo dela. null = não é promessa (mensagem genérica, negada, vazia).
 * Prioridade: horário explícito > "amanhã" > rápida ("já te falo") > padrão ("vou verificar").
 */
export function detectSellerPromise(content: string | null | undefined, sentAt: Date, calendar: BusinessCalendar, defaultMinutes = PROMISE_DEFAULT_MINUTES): SellerPromise | null {
  const text = normalize(content ?? "");
  if (!text) return null;
  const quick = text.match(QUICK);
  const standard = text.match(STANDARD);
  const verb = PROMISE_VERB.test(text);
  const isPromise = !!quick || !!standard || verb;
  if (!isPromise) return null;
  if (/\bnao (vou|consigo|posso|tenho como|da pra|vai dar)\b/.test(text) && !quick) return null;
  const today = toISODateInTimeZone(sentAt, calendar.timeZone);
  const tomorrow = /\bamanha\b/.test(text);
  const time = text.match(TIME);
  if (time && (verb || standard || quick)) {
    const h = Number(time[1] ?? time[3]);
    const mi = time[2] ?? time[4] ? Number(time[2] ?? time[4]) : 0;
    if (h <= 23 && mi <= 59) {
      let day = tomorrow ? nextBusinessDateAfter(today, calendar) : today;
      let due = localInstant(day, h, mi, calendar.timeZone);
      if (!tomorrow && (due.getTime() <= sentAt.getTime() || !isBusinessDate(day, calendar))) {
        day = nextBusinessDateAfter(today, calendar);
        due = localInstant(day, h, mi, calendar.timeZone);
      }
      return { kind: "explicit_time", dueAt: due, phrase: time[0] };
    }
  }
  if (tomorrow && (verb || standard)) {
    const opening = nextBusinessOpening(localInstant(today, 23, 59, calendar.timeZone), calendar) ?? sentAt;
    return { kind: "tomorrow", dueAt: addBusinessMinutes(opening, defaultMinutes, calendar), phrase: "amanhã" };
  }
  if (quick) return { kind: "quick", dueAt: addBusinessMinutes(sentAt, PROMISE_QUICK_MINUTES, calendar), phrase: quick[0] };
  if (standard) return { kind: "standard", dueAt: addBusinessMinutes(sentAt, defaultMinutes, calendar), phrase: standard[0] };
  return null;
}

export function isWithinHistoryWindow(sentAt: Date, now: Date): boolean {
  return now.getTime() - sentAt.getTime() <= COMMITMENT_HISTORY_WINDOW_MS;
}
