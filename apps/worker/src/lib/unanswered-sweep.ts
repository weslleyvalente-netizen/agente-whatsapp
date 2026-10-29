// Decisão pura da varredura de cliente sem resposta. Nenhum acesso a banco, Redis ou relógio global.
export const MIN_AGE_MS = 10 * 60_000;
export const MAX_AGE_MS = 24 * 60 * 60_000;
// A IA só reenvia mensagens de até 2 h (ligar a flag depois nunca faz a IA responder um backlog velho); mais antigas só avisam o humano.
export const RETRY_MAX_AGE_MS = 2 * 60 * 60_000;
export const ESCALATE_AFTER_RETRY_MS = 15 * 60_000;
// Conversa com humano (takeover/handoff aberto): não há retry da IA, o aviso sai após 10 + 15 min.
export const ESCALATE_HUMAN_PENDING_MS = MIN_AGE_MS + ESCALATE_AFTER_RETRY_MS;
// Segundo estágio do aviso: o vendedor foi avisado por push e a mensagem segue sem resposta; aos 60 min o resumo vai ao dono da loja.
export const ESCALATE_OWNER_AFTER_MS = 60 * 60_000;

export type SkipReason =
  | "too_recent" | "too_old" | "answered" | "ai_processed" | "not_ai_routed" | "ignored" | "ai_disabled" | "frozen" | "no_content"
  | "human_pending" | "retry_pending" | "already_alerted" | "outside_business_hours" | "acknowledgement";
export type SweepDecision = { action: "retry" } | { action: "alert" } | { action: "skip"; reason: SkipReason };

export interface SweepFacts {
  now: Date;
  createdAt: Date;
  content: string;
  mediaType: string | null;
  hasOutboundAfter: boolean;
  /** metadata.ai_routed_at presente: o webhook encaminhou a mensagem à IA. Sem a marca, nunca há retry da IA. */
  aiRouted: boolean;
  /** metadata.ai_processed_at presente: o pipeline da IA já tratou a mensagem (mesmo sem responder). */
  aiProcessed: boolean;
  ignored: boolean;
  aiDisabled: boolean;
  frozen: boolean;
  isHumanTakeover: boolean;
  openHandoff: boolean;
  /** Quando o retry foi feito (valor da chave unanswered-sweep:retried:<id>), se houve. */
  retriedAt: Date | null;
  alerted: boolean;
  businessOpen: boolean;
  /**
   * A mensagem é só um encerramento ("ok", "obrigado", "amanhã eu pego") E o contexto confirma (sem outra mensagem do cliente
   * pendente antes, última nossa mensagem sem "?"). Só suprime o AVISO; nunca cancela o retry da IA.
   */
  closingAck?: boolean;
}

const skip = (reason: SkipReason): SweepDecision => ({ action: "skip", reason });
const alertUnlessAck = (f: SweepFacts): SweepDecision => (f.closingAck ? skip("acknowledgement") : { action: "alert" });

export function decideSweepAction(f: SweepFacts): SweepDecision {
  const age = f.now.getTime() - f.createdAt.getTime();
  if (age > MAX_AGE_MS) return skip("too_old");
  if (age < MIN_AGE_MS) return skip("too_recent");
  if (f.hasOutboundAfter) return skip("answered");
  if (f.ignored) return skip("ignored");
  if (f.aiDisabled) return skip("ai_disabled");
  if (f.frozen) return skip("frozen");
  // O webhook nunca grava reação/protocolo; aqui só se descarta mensagem sem texto e sem mídia.
  if (!f.content.trim() && (!f.mediaType || f.mediaType === "text")) return skip("no_content");

  if (f.isHumanTakeover || f.openHandoff) {
    if (f.alerted) return skip("already_alerted");
    if (age < ESCALATE_HUMAN_PENDING_MS) return skip("human_pending");
    return f.businessOpen ? alertUnlessAck(f) : skip("outside_business_hours");
  }

  if (!f.aiRouted) return skip("not_ai_routed");
  if (f.aiProcessed) return skip("ai_processed");
  if (!f.retriedAt && age > RETRY_MAX_AGE_MS) {
    // Velha demais para a IA responder: vai direto para o aviso ao humano.
    if (f.alerted) return skip("already_alerted");
    return f.businessOpen ? alertUnlessAck(f) : skip("outside_business_hours");
  }
  if (!f.retriedAt) return { action: "retry" };
  if (f.alerted) return skip("already_alerted");
  if (f.now.getTime() - f.retriedAt.getTime() < ESCALATE_AFTER_RETRY_MS) return skip("retry_pending");
  return f.businessOpen ? alertUnlessAck(f) : skip("outside_business_hours");
}

// ---- Encerramento / adiamento do próprio cliente (não pede resposta) ----
const ACK_MAX_CHARS = 60;
const ACK_MAX_WORDS = 8;
// Joinha, mãos, coração: sozinhos (ou junto de "ok") são só agradecimento.
const ACK_EMOJI = /^[\s\u{1F44D}\u{1F44C}\u{1F64F}\u{1F91D}\u{1F44F}\u{1F64C}\u{1F4AA}\u{2764}\u{2665}\u{1F499}\u{1F49A}\u{1F49B}\u{1F9E1}\u{1F49C}\u{1F5A4}\u{1F90D}\u{2705}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]+$/u;
// Palavras de encerramento. "ta bom" vira um token só (antes de dividir) para "bom" sozinho não contar ("bom dia" é saudação).
const ACK_CORE = new Set(["ok", "okay", "blz", "beleza", "certo", "combinado", "entendi", "perfeito", "show", "valeu", "obrigado", "obrigada", "obg", "brigado", "brigada", "tmj", "tranquilo", "tabom"]);
const ACK_FILLER = new Set(["muito", "mto", "demais", "mesmo", "viu", "ai", "pela", "atencao"]);
// Adiamento: frase INTEIRA de lista fechada ("amanhã na parte da manhã eu pego", "depois eu passo aí"); qualquer coisa a mais é conversa.
const POSTPONE = /^(amanha|depois|mais tarde|semana que vem|hoje a noite)( na parte da (manha|tarde))?( eu)?( vou)?( (pego|passo|ligo|retorno|vejo|volto|falo))( ai| la)?$/;

function normalizeClosing(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[^a-z0-9$\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * A mensagem é só um encerramento ("ok", "obrigado", joinha) ou um adiamento do próprio cliente ("amanhã eu pego")?
 * Conservador de propósito: saudação, pergunta, telefone, valor em dinheiro e texto longo nunca contam.
 */
export function isClosingAcknowledgement(content: string): boolean {
  const raw = content.trim();
  if (!raw || raw.includes("?")) return false;
  if (ACK_EMOJI.test(raw) && /\S/.test(raw)) return true;
  const text = normalizeClosing(raw);
  if (!text || text.length > ACK_MAX_CHARS) return false;
  if (/\$|\breais?\b|\bmil\b/.test(text) || raw.replace(/\D/g, "").length >= 8) return false;
  const words = text.replace(/\b(esta|ta) bom\b/g, "tabom").split(" ");
  if (words.length > ACK_MAX_WORDS) return false;
  // "okkk", "valeuuu": letras repetidas colapsadas só para comparar com a lista.
  const squashed = words.map((w) => w.replace(/(.)\1{2,}/g, "$1"));
  if (squashed.some((w) => ACK_CORE.has(w) || w === "ok") && squashed.every((w) => ACK_CORE.has(w) || ACK_FILLER.has(w) || w === "ok")) return true;
  return POSTPONE.test(words.join(" "));
}
