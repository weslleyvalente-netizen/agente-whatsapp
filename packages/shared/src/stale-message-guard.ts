// Proteção contra mensagem ATRASADA de cliente. Depois de uma queda da conexão, o WhatsApp/Evolution pode entregar de uma vez
// mensagens de horas atrás; o webhook as grava com "agora" e a IA responderia como se fossem novas. A idade vem do timestamp
// ORIGINAL da mensagem (messageTimestamp, em segundos). Funções PURAS (sem I/O).

export type StaleGuardMode = "off" | "shadow" | "on";

export const STALE_GUARD_DEFAULT_MINUTES = 20;
export const STALE_GUARD_MIN_MINUTES = 5;
export const STALE_GUARD_MAX_MINUTES = 24 * 60;
/** Relógio do aparelho/servidor adiantado até esta folga é tolerado (idade 0). Além disso o timestamp é considerado inválido. */
export const STALE_GUARD_FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Modo por organização: off (padrão/ausente), shadow (só registra o que faria; a IA responde como hoje) e on (retém a mensagem da IA e chama humano). */
export function resolveStaleGuardMode(settings: { stale_message_guard_mode?: unknown } | null | undefined): StaleGuardMode {
  const m = settings?.stale_message_guard_mode;
  return m === "shadow" || m === "on" ? m : "off";
}

/** Limite de idade (min). Valor ausente, não numérico ou fora de 5–1440 volta ao padrão/limites (nunca desliga a proteção por engano). */
export function resolveStaleGuardMinutes(settings: { stale_message_guard_minutes?: unknown } | null | undefined): number {
  const v = settings?.stale_message_guard_minutes;
  if (typeof v !== "number" || !Number.isFinite(v)) return STALE_GUARD_DEFAULT_MINUTES;
  return Math.min(STALE_GUARD_MAX_MINUTES, Math.max(STALE_GUARD_MIN_MINUTES, Math.round(v)));
}

export type MessageAgeStatus = "fresh" | "stale" | "no_timestamp" | "future_clock_skew";

export interface MessageAgeEvaluation {
  status: MessageAgeStatus;
  /** Idade em minutos (>= 0); null quando não há timestamp utilizável. */
  ageMinutes: number | null;
  /** Horário original da mensagem (ISO); null quando não utilizável. */
  originalAtIso: string | null;
}

/**
 * Idade da mensagem pelo timestamp original do WhatsApp. `messageTimestamp` em SEGUNDOS (aceita milissegundos por segurança).
 * Sem timestamp utilizável ou com timestamp muito no futuro (relógio errado) NÃO se chama de atrasada: o fluxo segue como hoje.
 * Adiantamento pequeno (até a tolerância) conta como idade 0.
 */
export function evaluateMessageAge(input: { messageTimestamp: unknown; now: Date; thresholdMinutes: number }): MessageAgeEvaluation {
  const raw = input.messageTimestamp;
  const none: MessageAgeEvaluation = { status: "no_timestamp", ageMinutes: null, originalAtIso: null };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return none;
  const ms = raw > 1e11 ? raw : raw * 1000; // 1e11 s ≈ ano 5138; acima disso já está em ms
  const diffMs = input.now.getTime() - ms;
  const originalAtIso = new Date(ms).toISOString();
  if (diffMs < -STALE_GUARD_FUTURE_TOLERANCE_MS) return { status: "future_clock_skew", ageMinutes: null, originalAtIso: null };
  const ageMinutes = Math.max(0, diffMs / 60_000);
  return { status: ageMinutes > input.thresholdMinutes ? "stale" : "fresh", ageMinutes, originalAtIso };
}
