// Detecção de "conexão muda": a Evolution informa estado "open", mas nenhuma mensagem de cliente chega.
// Funções PURAS (sem I/O). A decisão compara o silêncio observado com o volume habitual daquela hora da semana,
// para não alertar em madrugada/domingo e não deixar passar uma tarde de segunda sem nenhuma mensagem.

export interface SilenceThresholds {
  /** Silêncio mínimo (min) antes de qualquer avaliação. */
  minSilentMinutes: number;
  /** Volume habitual mínimo (msgs/h) para a hora ser considerada "horário de movimento". Abaixo disso não alerta. */
  minExpectedPerHour: number;
  /** Probabilidade (Poisson) de ver zero mensagens por esse tempo, abaixo da qual é "suspeito". */
  suspectProbability: number;
  /** Idem, abaixo da qual é "mudo" (alerta). */
  silentProbability: number;
}

export const DEFAULT_SILENCE_THRESHOLDS: SilenceThresholds = {
  minSilentMinutes: 20,
  minExpectedPerHour: 6,
  suspectProbability: 0.02,
  silentProbability: 0.001,
};

export type SilenceStatus = "ok" | "suspect" | "silent" | "not_applicable";

export interface SilenceInput {
  now: Date;
  /** Estado de conexão informado pela Evolution ("open", "connecting", "close"...). null = não consultado. */
  evolutionState: string | null;
  /** Última mensagem RECEBIDA de cliente (a mais recente entre o CRM e a Evolution). null = nenhuma conhecida. */
  lastInboundAt: Date | null;
  /** Volume habitual de mensagens recebidas por hora nesta hora da semana (mediana/média das últimas semanas). */
  baselinePerHour: number | null;
}

export interface SilenceEvaluation {
  status: SilenceStatus;
  silentMinutes: number | null;
  /** Mensagens esperadas no intervalo de silêncio (volume habitual × tempo). */
  expectedInSilence: number | null;
  /** Probabilidade de zero mensagens nesse intervalo se a conexão estivesse saudável. */
  probabilityOfSilence: number | null;
  reason: string;
}

/**
 * Só avalia quando a Evolution diz "open": outros estados têm alerta próprio (monitor de conexão). Sem histórico de volume
 * (baseline) ou com volume baixo para a hora, não alerta (silêncio é normal). A probabilidade usa Poisson:
 * P(0 mensagens em T) = exp(-λT), com λ = baseline/60 por minuto.
 */
export function evaluateSilentConnection(input: SilenceInput, t: SilenceThresholds = DEFAULT_SILENCE_THRESHOLDS): SilenceEvaluation {
  const na = (reason: string, silentMinutes: number | null = null): SilenceEvaluation => ({ status: "not_applicable", silentMinutes, expectedInSilence: null, probabilityOfSilence: null, reason });
  if (input.evolutionState !== "open") return na("A Evolution não está 'open' (outro alerta cobre este caso).");
  if (!input.lastInboundAt) return na("Sem mensagem recebida conhecida para comparar.");
  const silentMinutes = Math.max(0, (input.now.getTime() - input.lastInboundAt.getTime()) / 60_000);
  // Mensagem recente é prova de que a conexão recebe, em qualquer hora: vem antes do filtro de volume habitual. Senão, um alerta
  // aberto à tarde nunca fechava à noite (hora de pouco movimento = "não aplicável", que não resolve). Caso de 26/11 17:53.
  if (silentMinutes < t.minSilentMinutes) return { status: "ok", silentMinutes, expectedInSilence: null, probabilityOfSilence: null, reason: "Silêncio abaixo do mínimo." };
  if (input.baselinePerHour === null || !Number.isFinite(input.baselinePerHour)) return na("Sem volume habitual para esta hora.", silentMinutes);
  if (input.baselinePerHour < t.minExpectedPerHour) return na("Volume habitual baixo para esta hora (silêncio é normal).", silentMinutes);
  const expected = (input.baselinePerHour / 60) * silentMinutes;
  const p = Math.exp(-expected);
  if (p < t.silentProbability) return { status: "silent", silentMinutes, expectedInSilence: expected, probabilityOfSilence: p, reason: "Nenhuma mensagem recebida por tempo muito acima do habitual para esta hora." };
  if (p < t.suspectProbability) return { status: "suspect", silentMinutes, expectedInSilence: expected, probabilityOfSilence: p, reason: "Silêncio acima do habitual para esta hora." };
  return { status: "ok", silentMinutes, expectedInSilence: expected, probabilityOfSilence: p, reason: "Dentro do habitual." };
}

export interface AlertState { openedAt: Date; lastNotifiedAt: Date }
export type AlertAction = "open" | "repeat" | "resolve" | "none";

/**
 * Evita alertas repetidos: abre uma vez, repete no máximo a cada `repeatMinutes` enquanto continuar mudo, e resolve
 * quando voltar a "ok". "suspect" nunca notifica (só vira evidência). "not_applicable" não encerra um alerta aberto
 * (ex.: a Evolution caiu para 'close': o alerta continua aberto até chegar mensagem de verdade).
 */
export function decideAlertAction(prev: AlertState | null, ev: SilenceEvaluation, now: Date, repeatMinutes = 60): AlertAction {
  if (ev.status === "silent") {
    if (!prev) return "open";
    return (now.getTime() - prev.lastNotifiedAt.getTime()) / 60_000 >= repeatMinutes ? "repeat" : "none";
  }
  if (ev.status === "ok" && prev) return "resolve";
  return "none";
}

/** Hora da semana (0-167, domingo 00h = 0) em horário de Brasília (UTC-3, sem horário de verão desde 2019). */
export function hourOfWeekBrt(d: Date): number {
  const brt = new Date(d.getTime() - 3 * 3600_000);
  return brt.getUTCDay() * 24 + brt.getUTCHours();
}

/** Modo do alerta por organização: off (padrão), shadow (só registra o que enviaria) e on (registra e notifica). */
export type SilentAlertMode = "off" | "shadow" | "on";
export function resolveSilentAlertMode(settings: { silent_connection_alert_mode?: unknown } | null | undefined): SilentAlertMode {
  const m = settings?.silent_connection_alert_mode;
  return m === "shadow" || m === "on" ? m : "off";
}

export interface MonitorHealthInput {
  now: Date;
  /** Última observação do monitor de conexão (evolution_connection_observations). null = nunca houve. */
  observation: { observedAt: Date; queryOk: boolean } | null;
  /** Idade máxima aceitável da última observação (o monitor roda a cada 5 min). */
  maxAgeMs: number;
}
export type MonitorHealth = { status: "ok" } | { status: "blind"; reason: "no_observation" | "stale_observation" | "evolution_query_failed"; ageMinutes: number | null };

/**
 * Saúde do PRÓPRIO monitoramento (condição distinta de "conexão muda"): sem observação, observação velha ou consulta à Evolution
 * falhando = estamos cegos; não dá para afirmar que está tudo bem nem que está mudo.
 */
export function evaluateMonitorHealth(i: MonitorHealthInput): MonitorHealth {
  if (!i.observation) return { status: "blind", reason: "no_observation", ageMinutes: null };
  const age = i.now.getTime() - i.observation.observedAt.getTime();
  const ageMinutes = Math.round(age / 60_000);
  if (age > i.maxAgeMs) return { status: "blind", reason: "stale_observation", ageMinutes };
  if (!i.observation.queryOk) return { status: "blind", reason: "evolution_query_failed", ageMinutes };
  return { status: "ok" };
}
