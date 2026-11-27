// Pulso do webhook do provedor (UAZAPI): horário do último evento AUTENTICADO recebido por instância (mensagem, confirmação de
// entrega/leitura ou conexão). Fica em memória do processo da API, que é o mesmo processo que roda o monitor de saúde do provedor
// (uma réplica). Reinício zera o pulso: o monitor trata o início como "desconhecido" por alguns minutos (warmup), sem falso alarme.

export interface WebhookPulse { lastEventAt: Date; lastEventType: string | null }

const pulses = new Map<string, WebhookPulse>();
const processStartedAt = new Date();

export function recordWebhookEvent(instanceId: string, eventType: unknown, at: Date = new Date()): void {
  pulses.set(instanceId, { lastEventAt: at, lastEventType: typeof eventType === "string" ? eventType : null });
}

export const getWebhookPulse = (instanceId: string): WebhookPulse | null => pulses.get(instanceId) ?? null;
export const getProcessStartedAt = (): Date => processStartedAt;
export const resetWebhookPulses = (): void => { pulses.clear(); };
