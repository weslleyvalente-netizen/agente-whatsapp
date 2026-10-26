// Decisão pura da varredura de cliente sem resposta. Nenhum acesso a banco, Redis ou relógio global.
export const MIN_AGE_MS = 10 * 60_000;
export const MAX_AGE_MS = 24 * 60 * 60_000;
export const ESCALATE_AFTER_RETRY_MS = 15 * 60_000;
// Conversa com humano (takeover/handoff aberto): não há retry da IA, o aviso sai após 10 + 15 min.
export const ESCALATE_HUMAN_PENDING_MS = MIN_AGE_MS + ESCALATE_AFTER_RETRY_MS;

export type SkipReason =
  | "too_recent" | "too_old" | "answered" | "ai_processed" | "not_ai_routed" | "ignored" | "ai_disabled" | "frozen" | "no_content"
  | "human_pending" | "retry_pending" | "already_alerted" | "outside_business_hours";
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
}

const skip = (reason: SkipReason): SweepDecision => ({ action: "skip", reason });

export function decideSweepAction(f: SweepFacts): SweepDecision {
  const age = f.now.getTime() - f.createdAt.getTime();
  if (age > MAX_AGE_MS) return skip("too_old");
  if (age < MIN_AGE_MS) return skip("too_recent");
  if (f.hasOutboundAfter) return skip("answered");
  if (f.aiProcessed) return skip("ai_processed");
  if (f.ignored) return skip("ignored");
  if (f.aiDisabled) return skip("ai_disabled");
  if (f.frozen) return skip("frozen");
  // O webhook nunca grava reação/protocolo; aqui só se descarta mensagem sem texto e sem mídia.
  if (!f.content.trim() && (!f.mediaType || f.mediaType === "text")) return skip("no_content");

  if (f.isHumanTakeover || f.openHandoff) {
    if (f.alerted) return skip("already_alerted");
    if (age < ESCALATE_HUMAN_PENDING_MS) return skip("human_pending");
    return f.businessOpen ? { action: "alert" } : skip("outside_business_hours");
  }

  if (!f.aiRouted) return skip("not_ai_routed");
  if (!f.retriedAt) return { action: "retry" };
  if (f.alerted) return skip("already_alerted");
  if (f.now.getTime() - f.retriedAt.getTime() < ESCALATE_AFTER_RETRY_MS) return skip("retry_pending");
  return f.businessOpen ? { action: "alert" } : skip("outside_business_hours");
}
