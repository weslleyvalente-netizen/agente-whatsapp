// Sincronização de "Aguardando" (waiting_on) e próxima ação SÓ quando a mudança de responsabilidade é comprovada.
// Funções puras. Regra de ouro: nunca tocar em valor que um humano editou — só nos valores automáticos conhecidos abaixo.
// Não vale: "toda mensagem do vendedor é proposta" nem "toda resposta transfere a pendência".
//
// Estados automáticos (waiting_on / próxima ação):
//   HANDOFF  team     "Atender cliente encaminhado pela IA"   (posto pelo repasse da IA)
//   AWAIT    customer "Aguardar resposta do cliente"          (posto por esta regra)
//   REPLIED  team     "Responder ao cliente"                  (cliente respondeu)
//   DECLINED team     "Cliente disse não: confirmar interesse"  (cliente respondeu "não": decisão é humana, nunca volta sozinho)
//   PROMISED team     "Retornar ao cliente"                   (o vendedor prometeu verificar/enviar algo)
// Transições (todas só sobre os textos automáticos; edição humana vence):
//   1) HANDOFF -> AWAIT   : humano concluiu o atendimento do repasse, respondeu, e a última mensagem NÃO é do cliente;
//   2) AWAIT   -> REPLIED/DECLINED : o cliente respondeu (agradecimento puro não conta; "não" conta, mas não presume interesse);
//   3) HANDOFF/REPLIED/PROMISED -> AWAIT : o vendedor fez proposta/pergunta ao cliente (e não há obrigação da equipe aberta);
//   4) HANDOFF/REPLIED/AWAIT -> PROMISED : o vendedor prometeu verificar/enviar algo (a bola é da equipe).
// Nunca age em: negócio fechado/congelado, data combinada futura, etapas da equipe (simulação/banco/condições/financiamento recusado),
// tarefas abertas da equipe (simulação, documentos, retorno agendado, financiamento...) e mais de um negócio aberto.

/** Próxima ação gravada pelo repasse da IA (sync_sales_pipeline). Se ainda é este texto, ninguém a editou. */
export const HANDOFF_AUTO_NEXT_ACTION = "Atender cliente encaminhado pela IA";
export const AWAITING_CUSTOMER_NEXT_ACTION = "Aguardar resposta do cliente";
export const CUSTOMER_REPLIED_NEXT_ACTION = "Responder ao cliente";
export const CUSTOMER_DECLINED_NEXT_ACTION = "Cliente disse não: confirmar interesse";
export const SELLER_PROMISED_NEXT_ACTION = "Retornar ao cliente";
/** Textos que só esta regra (ou o repasse da IA) grava; qualquer outro texto é edição humana e não é tocado. */
export const AUTO_NEXT_ACTIONS: readonly string[] = [HANDOFF_AUTO_NEXT_ACTION, AWAITING_CUSTOMER_NEXT_ACTION, CUSTOMER_REPLIED_NEXT_ACTION, CUSTOMER_DECLINED_NEXT_ACTION, SELLER_PROMISED_NEXT_ACTION];

export type WaitingOnSyncMode = "off" | "shadow" | "on";
/** `waiting_on_sync_mode` manda; sem ele, o antigo `waiting_on_sync_enabled === true` equivale a "on". Qualquer outra coisa = "off". */
export function resolveWaitingOnSyncMode(settings: { waiting_on_sync_mode?: unknown; waiting_on_sync_enabled?: unknown } | null | undefined): WaitingOnSyncMode {
  const m = settings?.waiting_on_sync_mode;
  if (m === "on" || m === "shadow" || m === "off") return m;
  return settings?.waiting_on_sync_enabled === true ? "on" : "off";
}

/** Tarefas abertas que NÃO são obrigação da equipe (alertas de silêncio): não impedem a sincronização. As demais impedem. */
export const NON_BLOCKING_TASK_TYPES: readonly string[] = ["customer_nudge", "customer_unresponsive", "stalled_negotiation"];

// ---------- classificação das mensagens (heurística pt-BR, conservadora) ----------
const norm = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const letters = (t: string) => norm(t).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

export type CustomerReplyKind = "ad_context" | "ack" | "negative" | "answer" | "media";
const ACK = /^(?:ok+|okay|blz|beleza|valeu|vlw|obrigad[oa]s?|brigad[oa]|certo|combinado|show|top|entendi|tudo bem|tudo certo|tudo|bom dia|boa tarde|boa noite|oi|ola|opa|k+|ha(?:ha)+|rs+|kk+)$/;
const NEGATIVE = /^(?:nao|n|nao obrigad[oa]|nao quero|nao quero mais|nao tenho interesse|nao tenho mais interesse|sem interesse|nao vou|nao vou mais|nao vou comprar|desisti|ja comprei|ja fechei|nao preciso|nao precisa|pode encerrar|pode cancelar)(?: obrigad[oa])?$/;
/**
 * Como o CRM deve tratar a mensagem do CLIENTE. "ack" (agradecimento/emoji/risada) não devolve a bola à equipe; "negative" ("Não") devolve,
 * mas sem presumir interesse (a decisão é humana); "media" (áudio, imagem, documento, vídeo) conta como resposta; o contexto do anúncio não é resposta.
 */
export function classifyCustomerReply(content: string | null | undefined, mediaType?: string | null): CustomerReplyKind {
  const raw = (content ?? "").trim();
  if (raw.startsWith("[Cliente veio de um anúncio:")) return "ad_context";
  if (mediaType === "sticker" || /^\[sticker/i.test(raw)) return "ack";
  if ((mediaType && mediaType !== "text") || /^\[(?:audio|image|document|video)/i.test(raw) || raw.startsWith("🎤")) return "media";
  if (!raw) return "ack";
  const l = letters(raw);
  if (!l) return "ack"; // só emoji/pontuação
  if (NEGATIVE.test(l)) return "negative";
  if (ACK.test(l)) return "ack";
  // "não" no começo de uma frase maior ("não tenho o RG aqui") é resposta comum, não recusa
  return "answer";
}

export type SellerMessageKind = "proposal" | "asks" | "promise" | "media_audio" | "ack" | "info";
const PROMISE = /\b(?:vou (?:te )?(?:verificar|ver|consultar|conferir|simular|checar|confirmar|analisar|pedir|encaminhar|enviar|mandar|passar|ligar)|ja (?:te )?(?:retorno|aviso|respondo|passo|volto|mando|envio)|(?:um|so um|so) (?:momento|minuto|minutinho|instante)|aguarde|daqui a pouco|estou (?:verificando|vendo|consultando|simulando)|deixa eu (?:ver|verificar|consultar|conferir|simular)|te (?:retorno|aviso|chamo|dou retorno))\b/;
const PROPOSAL_TERMS = /\b(?:parcelas?|entrada|credito|carta|plano|proposta|valor|simulacao|consorcio|financiamento|a vista|prazo|lance|r\$|x)\b|r\$/;
const ASK_PATTERNS = /\b(?:me (?:manda|envia|envie|mande|passa|passe|informa|informe|diz|diga|fala|fale)|preciso que|consegue|pode (?:me )?(?:enviar|mandar|passar))\b/;
/**
 * O que o VENDEDOR fez: proposta (valores/condições ou documento/imagem), pergunta ao cliente, promessa de verificar/enviar,
 * áudio sem texto (não dá para saber: não muda nada), ou simples cortesia/informação (não muda nada).
 */
export function classifySellerMessage(content: string | null | undefined, mediaType?: string | null): SellerMessageKind {
  const raw = (content ?? "").trim();
  if (mediaType === "audio" || /^\[audio/i.test(raw) || raw.startsWith("🎤")) return "media_audio";
  if (mediaType === "document" || mediaType === "image" || /^\[(?:document|image|imagem)/i.test(raw)) return "proposal";
  const t = norm(raw);
  const l = letters(raw);
  if (!l || ACK.test(l)) return "ack";
  const digits = (t.match(/\d/g) ?? []).length;
  if (digits >= 2 && PROPOSAL_TERMS.test(t)) return "proposal";
  if (PROMISE.test(t)) return "promise";
  if (t.includes("?") || ASK_PATTERNS.test(t)) return "asks";
  return "info";
}


/** Etapas em que a pendência é genuinamente da equipe/banco (simulação, análise, condições): nunca viram "cliente" sozinhas. */
export const TEAM_OWNED_STAGES = ["awaiting_simulation", "financing_rejected", "conditions_approved_negotiation", "bank_analysis"] as const;

export interface OppFacts {
  status: string; stage: string; waiting_on: string | null; next_action: string | null;
  /** Congelado até esta data (YYYY-MM-DD) ou null. Congelado = ninguém mexe. */
  frozen_until?: string | null;
  /** Data combinada (YYYY-MM-DD): enquanto futura, é uma promessa de retorno e não se mexe. */
  waiting_on_until?: string | null;
}
const isFutureDate = (d: string | null | undefined, today?: string) => !!d && d >= (today ?? new Date().toISOString().slice(0, 10));

type KeepReason =
  | "not_open" | "not_waiting_team" | "next_action_edited" | "team_owned_stage" | "not_attendance_task" | "no_human_reply" | "other_open_tasks"
  | "frozen" | "scheduled_date_pending" | "customer_waiting" | "no_change";

/** Decisão que grava: o que mudar, qual regra e o motivo (vão para o evento waiting_on_changed e para o modo sombra). */
export interface SetDecision<W extends "customer" | "team"> { action: W extends "customer" ? "set_customer" : "set_team"; waiting_on: W; next_action: string; rule: string; reason: string }

export type AttendanceSyncDecision = SetDecision<"customer"> | { action: "keep"; reason: KeepReason };

export function decideAttendanceCompleted(i: {
  opportunity: OppFacts;
  /** Tipos da tarefa concluída (o tipo dela + as pendências consolidadas). */
  completedTypes: string[];
  /** Há mensagem humana (human_agent) na conversa da tarefa DEPOIS de a tarefa ter sido criada. */
  humanRepliedAfterTaskCreated: boolean;
  /** Outras tarefas abertas do negócio (qualquer tipo): se existem, há obrigação em aberto e não se adivinha. */
  otherOpenTasks: number;
  /** Papel da ÚLTIMA mensagem da conversa: se é do cliente, ele está esperando a equipe e nada muda. */
  lastMessageRole?: string | null;
  today?: string;
}): AttendanceSyncDecision {
  const keep = (reason: KeepReason): AttendanceSyncDecision => ({ action: "keep", reason });
  const o = i.opportunity;
  if (o.status !== "open") return keep("not_open");
  if (o.waiting_on !== "team") return keep("not_waiting_team");
  if (o.next_action !== HANDOFF_AUTO_NEXT_ACTION) return keep("next_action_edited");
  if (isFutureDate(o.frozen_until, i.today)) return keep("frozen");
  if (isFutureDate(o.waiting_on_until, i.today)) return keep("scheduled_date_pending");
  if ((TEAM_OWNED_STAGES as readonly string[]).includes(o.stage)) return keep("team_owned_stage");
  if (!i.completedTypes.includes("return_customer")) return keep("not_attendance_task");
  if (!i.humanRepliedAfterTaskCreated) return keep("no_human_reply");
  if (i.otherOpenTasks > 0) return keep("other_open_tasks");
  if (i.lastMessageRole === "contact") return keep("customer_waiting");
  return { action: "set_customer", waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION, rule: "attendance_completed", reason: "O vendedor concluiu o atendimento do repasse e respondeu o cliente; a próxima ação depende do cliente." };
}

export type CustomerReplySyncDecision = SetDecision<"team"> | { action: "keep"; reason: "not_open" | "not_waiting_customer" | "not_auto_waiting" | "not_substantive" | "frozen" | "scheduled_date_pending" };

/**
 * O cliente respondeu. Aceita `reply` (classificação) ou, por compatibilidade, `substantive`.
 * "ack" (agradecimento) não muda nada; "negative" ("não") devolve a bola à equipe SEM presumir interesse (texto próprio, nunca volta sozinho).
 */
export function decideCustomerReplied(i: { opportunity: OppFacts; substantive?: boolean; reply?: CustomerReplyKind; today?: string }): CustomerReplySyncDecision {
  const o = i.opportunity;
  if (o.status !== "open") return { action: "keep", reason: "not_open" };
  if (o.waiting_on !== "customer") return { action: "keep", reason: "not_waiting_customer" };
  if (o.next_action !== AWAITING_CUSTOMER_NEXT_ACTION) return { action: "keep", reason: "not_auto_waiting" };
  if (isFutureDate(o.frozen_until, i.today)) return { action: "keep", reason: "frozen" };
  if (isFutureDate(o.waiting_on_until, i.today)) return { action: "keep", reason: "scheduled_date_pending" };
  const reply: CustomerReplyKind = i.reply ?? (i.substantive === false ? "ack" : "answer");
  if (reply === "ack" || reply === "ad_context") return { action: "keep", reason: "not_substantive" };
  if (reply === "negative") return { action: "set_team", waiting_on: "team", next_action: CUSTOMER_DECLINED_NEXT_ACTION, rule: "customer_declined", reason: "O cliente respondeu que não. Quem decide o próximo passo é o vendedor (não se presume continuidade da negociação)." };
  return { action: "set_team", waiting_on: "team", next_action: CUSTOMER_REPLIED_NEXT_ACTION, rule: "customer_replied", reason: reply === "media" ? "O cliente enviou áudio/mídia: a equipe precisa responder." : "O cliente respondeu: a equipe precisa responder." };
}

export type SellerMessageSyncDecision = SetDecision<"customer"> | SetDecision<"team"> | { action: "keep"; reason: KeepReason };

/**
 * O vendedor (humano) escreveu. Só age sobre os textos automáticos e respeitando o contexto:
 *  - proposta/pergunta ao cliente => "aguardando cliente", MAS só se não há obrigação da equipe aberta (simulação, documentos,
 *    retorno agendado, financiamento...), a etapa não é da equipe e o negócio não está congelado nem com data combinada;
 *  - promessa de verificar/enviar => a bola é da equipe;
 *  - áudio sem texto, cortesia ou informação => não muda nada. "Não trivial" sozinho NÃO basta.
 * Depois de um "não" do cliente (DECLINED) nunca volta sozinho.
 */
export function decideSellerMessage(i: {
  opportunity: OppFacts; kind: SellerMessageKind;
  /** Tarefas abertas do negócio que são obrigação da equipe (já sem os alertas de silêncio). */
  blockingOpenTasks: number; today?: string;
}): SellerMessageSyncDecision {
  const keep = (reason: KeepReason): SellerMessageSyncDecision => ({ action: "keep", reason });
  const o = i.opportunity;
  if (o.status !== "open") return keep("not_open");
  if (!o.next_action || !AUTO_NEXT_ACTIONS.includes(o.next_action) || o.next_action === CUSTOMER_DECLINED_NEXT_ACTION) return keep("next_action_edited");
  if (isFutureDate(o.frozen_until, i.today)) return keep("frozen");
  if (isFutureDate(o.waiting_on_until, i.today)) return keep("scheduled_date_pending");
  if ((TEAM_OWNED_STAGES as readonly string[]).includes(o.stage)) return keep("team_owned_stage");
  const autoState = (w: string, n: string) => o.waiting_on === w && o.next_action === n;
  if (i.kind === "promise") {
    if (autoState("customer", AWAITING_CUSTOMER_NEXT_ACTION) || autoState("team", CUSTOMER_REPLIED_NEXT_ACTION) || autoState("team", HANDOFF_AUTO_NEXT_ACTION)) {
      if (autoState("team", SELLER_PROMISED_NEXT_ACTION)) return keep("no_change");
      return { action: "set_team", waiting_on: "team", next_action: SELLER_PROMISED_NEXT_ACTION, rule: "seller_promise", reason: "O vendedor prometeu verificar ou enviar algo ao cliente: a bola é da equipe." };
    }
    return keep(o.waiting_on === "team" ? "no_change" : "not_waiting_team");
  }
  if (i.kind === "proposal" || i.kind === "asks") {
    const fromTeamAuto = o.waiting_on === "team" && [HANDOFF_AUTO_NEXT_ACTION, CUSTOMER_REPLIED_NEXT_ACTION, SELLER_PROMISED_NEXT_ACTION].includes(o.next_action);
    if (!fromTeamAuto) return keep(o.waiting_on === "customer" ? "no_change" : "not_waiting_team");
    if (i.blockingOpenTasks > 0) return keep("other_open_tasks");
    return { action: "set_customer", waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION, rule: i.kind === "proposal" ? "seller_proposal" : "seller_question", reason: i.kind === "proposal" ? "O vendedor apresentou proposta/condições ao cliente: a próxima ação depende do cliente." : "O vendedor fez uma pergunta ao cliente: a próxima ação depende do cliente." };
  }
  return keep("no_change"); // ack, info, media_audio: nada muda
}
