// "Modo noite": depois de um requestHuman fora do horário comercial, a IA
// continua atendendo o cliente enquanto nenhum humano respondeu. Função pura.
export const AFTER_HOURS_MAX_REPLIES_PER_CONVERSATION = 20;

export interface AiAfterHoursInput {
  isHumanTakeover: boolean;
  /** Existe handoff_events request_human com first_human_reply_at nulo. */
  hasOpenRequestHumanHandoff: boolean;
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
    i.businessOpen === false &&
    i.aiDisabled !== true
  );
}
