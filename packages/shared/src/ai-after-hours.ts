// "Modo noite": depois de um requestHuman fora do horário comercial, a IA
// continua atendendo o cliente enquanto nenhum humano respondeu. Função pura.
export const AFTER_HOURS_MAX_REPLIES_PER_CONVERSATION = 20;

export interface AiAfterHoursInput {
  isHumanTakeover: boolean;
  /** Existe handoff_events request_human com first_human_reply_at nulo. */
  hasOpenRequestHumanHandoff: boolean;
  /** Esse handoff aberto foi o que iniciou o takeover atual (ver handoffStartedTakeover). */
  takeoverOriginatedFromHandoff: boolean;
  businessOpen: boolean;
  aiDisabled: boolean;
  /** settings.ai_after_hours_pending_enabled */
  flagEnabled: boolean;
}

export function shouldRunAiAfterHours(i: AiAfterHoursInput): boolean {
  return (
    i.flagEnabled === true &&
    i.isHumanTakeover === true &&
    i.hasOpenRequestHumanHandoff === true &&
    i.takeoverOriginatedFromHandoff === true &&
    i.businessOpen === false &&
    i.aiDisabled !== true
  );
}

const TAKEOVER_SKEW_MS = 60_000;

/**
 * Um handoff request_human antigo e ainda aberto não pode liberar a IA durante
 * um takeover MANUAL posterior: o handoff precisa ter sido criado junto do
 * takeover atual (tolerância de 60 s para diferença de relógio).
 */
export function handoffStartedTakeover(handoffHandedAt: string | null | undefined, humanTakeoverAt: string | null | undefined): boolean {
  if (!handoffHandedAt || !humanTakeoverAt) return false;
  const h = Date.parse(handoffHandedAt), t = Date.parse(humanTakeoverAt);
  if (!Number.isFinite(h) || !Number.isFinite(t)) return false;
  return h >= t - TAKEOVER_SKEW_MS;
}
