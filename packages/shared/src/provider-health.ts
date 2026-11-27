// Saúde do provedor de WhatsApp (UAZAPI) além do "está conectado". Funções PURAS (sem I/O).
// O alerta de silêncio (silent-connection.ts) é estatístico: não distingue pouco movimento de falha e, como usa o horário mais
// recente entre o CRM e o provedor, não vê o caso "o provedor recebeu e o webhook não entregou". Estas condições são diretas:
//   provider_disconnected  a UAZAPI diz que a instância não está conectada;
//   provider_ahead         a UAZAPI tem mensagem de cliente mais nova que a última gravada no CRM (webhook não entregou);
//   webhook_stalled        o CRM enviou mensagens e nenhum evento do webhook (confirmação, mensagem, conexão) voltou desde então;
//   queue_backlog          a fila de processamento de mensagens está parada (job esperando há muito tempo).
// "unknown" = não foi possível medir (consulta falhou, API acabou de reiniciar): nunca abre nem fecha alerta.

export type ProviderHealthKind = "provider_disconnected" | "provider_ahead" | "webhook_stalled" | "queue_backlog";
export type ProviderHealthStatus = "ok" | "problem" | "unknown";

export interface ProviderHealthInput {
  now: Date;
  /** Início do processo da API: o pulso do webhook fica em memória e começa vazio a cada reinício. */
  processStartedAt: Date;
  /** Consulta à UAZAPI: estado da instância e a mensagem de cliente mais recente que ela guardou. */
  provider: { ok: boolean; state: string | null; lastInboundAt: Date | null };
  /** Última mensagem de cliente gravada no CRM para a instância. */
  crmLastInboundAt: Date | null;
  /** Envio mais antigo da janela recente (enviado pelo CRM com id do WhatsApp) — se nenhum evento voltou depois dele, o webhook parou. */
  oldestUnconfirmedOutboundAt: Date | null;
  /** Último evento autenticado recebido no webhook da UAZAPI para a instância (memória do processo). */
  lastWebhookEventAt: Date | null;
  /** Fila de processamento de mensagens recebidas. */
  queue: { ok: boolean; waiting: number | null; oldestWaitingAt: Date | null };
}

export interface ProviderHealthCondition { kind: ProviderHealthKind; status: ProviderHealthStatus; reason: string; evidence: Record<string, unknown> }

export interface ProviderHealthThresholds {
  /** Tempo para o webhook entregar uma mensagem que já está na UAZAPI. */
  deliveryGraceMinutes: number;
  /** Diferença tolerada entre a última mensagem na UAZAPI e no CRM. */
  aheadToleranceMinutes: number;
  /** Tempo sem nenhum evento do webhook depois de um envio nosso. */
  webhookSilenceMinutes: number;
  /** Tempo mínimo de processo no ar para confiar no pulso em memória. */
  warmupMinutes: number;
  /** Idade máxima de um job esperando na fila. */
  queueMaxWaitMinutes: number;
}

export const DEFAULT_PROVIDER_HEALTH_THRESHOLDS: ProviderHealthThresholds = {
  deliveryGraceMinutes: 3,
  aheadToleranceMinutes: 3,
  webhookSilenceMinutes: 5,
  warmupMinutes: 10,
  queueMaxWaitMinutes: 5,
};

const minutes = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 60_000);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function evaluateProviderHealth(i: ProviderHealthInput, t: ProviderHealthThresholds = DEFAULT_PROVIDER_HEALTH_THRESHOLDS): ProviderHealthCondition[] {
  const out: ProviderHealthCondition[] = [];

  // 1. Conexão
  if (!i.provider.ok) out.push({ kind: "provider_disconnected", status: "unknown", reason: "Consulta à UAZAPI falhou.", evidence: {} });
  else if (i.provider.state === "connected") out.push({ kind: "provider_disconnected", status: "ok", reason: "Conectada.", evidence: { state: i.provider.state } });
  else out.push({ kind: "provider_disconnected", status: "problem", reason: "A UAZAPI informa que a instância não está conectada.", evidence: { state: i.provider.state } });

  // 2. Provedor à frente do CRM
  const pLast = i.provider.lastInboundAt;
  if (!i.provider.ok) out.push({ kind: "provider_ahead", status: "unknown", reason: "Sem dado da UAZAPI.", evidence: {} });
  else if (!pLast) out.push({ kind: "provider_ahead", status: "ok", reason: "A UAZAPI não tem mensagem recente de cliente.", evidence: {} });
  else {
    const pending = minutes(i.now, pLast) >= t.deliveryGraceMinutes;
    const lag = i.crmLastInboundAt ? minutes(pLast, i.crmLastInboundAt) : null;
    const ahead = pending && (lag === null || lag > t.aheadToleranceMinutes);
    out.push({
      kind: "provider_ahead", status: ahead ? "problem" : "ok",
      reason: ahead ? "A UAZAPI recebeu mensagem de cliente que não chegou ao CRM (webhook não entregou)." : "CRM em dia com a UAZAPI.",
      evidence: { provider_last_inbound_at: iso(pLast), crm_last_inbound_at: iso(i.crmLastInboundAt), lag_minutes: lag },
    });
  }

  // 3. Webhook parado
  const sent = i.oldestUnconfirmedOutboundAt;
  if (!sent || minutes(i.now, sent) < t.webhookSilenceMinutes) {
    out.push({ kind: "webhook_stalled", status: "ok", reason: "Sem envio aguardando confirmação.", evidence: {} });
  } else if (i.lastWebhookEventAt && i.lastWebhookEventAt.getTime() >= sent.getTime()) {
    out.push({ kind: "webhook_stalled", status: "ok", reason: "Evento do webhook depois do envio.", evidence: { last_webhook_event_at: iso(i.lastWebhookEventAt) } });
  } else if (!i.lastWebhookEventAt && minutes(i.now, i.processStartedAt) < t.warmupMinutes) {
    out.push({ kind: "webhook_stalled", status: "unknown", reason: "API reiniciada há pouco; pulso do webhook ainda vazio.", evidence: {} });
  } else {
    out.push({
      kind: "webhook_stalled", status: "problem",
      reason: "Enviamos mensagens e nenhum evento do webhook voltou desde então.",
      evidence: { oldest_outbound_at: iso(sent), last_webhook_event_at: iso(i.lastWebhookEventAt), minutes_since_last_event: i.lastWebhookEventAt ? minutes(i.now, i.lastWebhookEventAt) : null },
    });
  }

  // 4. Fila
  if (!i.queue.ok) out.push({ kind: "queue_backlog", status: "unknown", reason: "Fila inacessível.", evidence: {} });
  else {
    const age = i.queue.oldestWaitingAt ? minutes(i.now, i.queue.oldestWaitingAt) : 0;
    const stuck = age > t.queueMaxWaitMinutes;
    out.push({
      kind: "queue_backlog", status: stuck ? "problem" : "ok",
      reason: stuck ? "Mensagens esperando processamento há tempo demais." : "Fila andando.",
      evidence: { waiting: i.queue.waiting, oldest_waiting_minutes: i.queue.oldestWaitingAt ? age : null },
    });
  }
  return out;
}

/** Modo do monitor do provedor por organização: off (padrão), shadow (só registra) e on (registra e notifica). */
export type ProviderMonitorMode = "off" | "shadow" | "on";
export function resolveProviderMonitorMode(settings: { provider_health_monitor_mode?: unknown } | null | undefined): ProviderMonitorMode {
  const m = settings?.provider_health_monitor_mode;
  return m === "shadow" || m === "on" ? m : "off";
}
