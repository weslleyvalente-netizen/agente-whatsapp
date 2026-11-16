// P0a: triagem de exceções de SLA (e de atribuições `alert` vencidas) e escada de alertas 0/15/30/60 min úteis.
// Funções PURAS (sem relógio global, sem banco): a classificação e o planejador são testáveis por inteiro.
// Nada aqui altera dono, rodízio ou histórico: só lê fatos e devolve estado/plano.
import { addBusinessMinutes, businessMinutesBetween, type BusinessCalendar } from "./business-calendar.js";

export const EXCEPTION_ALERT_STAGES = [0, 15, 30, 60] as const;
export type ExceptionAlertStage = (typeof EXCEPTION_ALERT_STAGES)[number];
export type ExceptionAlertsMode = "off" | "shadow" | "on";

export type TriageKind = "exception" | "alert";
export type TriageState = "aguardando_atendimento_comercial" | "respondida_sem_aceite" | "resolvida" | "obsoleta";
export type TriageGroup = "urgente" | "respondida" | "obsoleta";
export type ReplyClass = "saudacao" | "comercial" | "midia";

/** Tipos de evento auditável (tabela append-only exception_events). Só `resolved_*` encerra a cobrança. */
export const EXCEPTION_EVENT_KINDS = ["acknowledged", "resolved_confirmed", "resolved_no_action"] as const;
export type ExceptionEventKind = (typeof EXCEPTION_EVENT_KINDS)[number];
export const isResolutionEvent = (kind: string): boolean => kind === "resolved_confirmed" || kind === "resolved_no_action";

/** Idade (dias desde o vencimento) a partir da qual uma atribuição `alert` sem cliente esperando é considerada obsoleta. */
export const OBSOLETE_AFTER_DAYS = 14;

const GREETING_PHRASES = [
  "bom dia", "boa tarde", "boa noite", "bomdia", "boatarde", "boanoite", "tudo bem", "tudo bom", "td bem", "tudo certo", "como vai", "como esta",
  "e ai", "ola", "oi", "opa", "eae", "salve", "bem", "obrigado", "obrigada", "ok", "sim",
];
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Classifica uma resposta humana. CONSERVADORA de propósito (o erro seguro é manter a exceção urgente):
 * - mídia/áudio/figurinha/sem texto => "midia" (não dá para provar conteúdo comercial; NÃO conta como resposta comercial);
 * - saudação, cortesia e até 2 palavras restantes (o nome do cliente) => "saudacao";
 * - qualquer outra coisa => "comercial".
 */
export function classifyHumanReply(content: string | null | undefined): ReplyClass {
  const raw = (content ?? "").trim();
  if (!raw || /^\[(audio|áudio|image|imagem|video|vídeo|document|documento|sticker|figurinha|media|mídia)/i.test(raw)) return "midia";
  let text = ` ${norm(raw)} `;
  if (text.trim() === "") return "saudacao";
  for (const phrase of [...GREETING_PHRASES].sort((a, b) => b.length - a.length)) text = text.split(` ${phrase} `).join("  ");
  const rest = text.split(" ").filter(Boolean);
  return rest.length <= 2 ? "saudacao" : "comercial";
}

const CLOSING_STRONG = new Set(["ok", "okay", "blz", "beleza", "obrigado", "obrigada", "obg", "valeu", "vlw", "show", "certo", "fechado", "combinado", "perfeito", "otimo", "legal", "tmj", "entendi"]);
const CLOSING_SUPPORT = new Set(["muito", "ta", "esta", "bom", "demais", "mesmo"]);
/**
 * Cortesia de encerramento do cliente ("ok", "blz", "obrigada", "tá bom"): NÃO significa que ele espera uma resposta.
 * Conservadora: precisa de ao menos uma palavra de encerramento e NADA além de palavras de apoio (até 4 palavras).
 * "sim", "mais pra frente", "60mil" e "bom dia" continuam contando como cliente esperando.
 */
export function isClosingAcknowledgement(content: string | null | undefined): boolean {
  const text = norm(content ?? "");
  if (!text) return /\p{Extended_Pictographic}/u.test(content ?? "");
  const words = text.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  return words.some(w => CLOSING_STRONG.has(w)) && words.every(w => CLOSING_STRONG.has(w) || CLOSING_SUPPORT.has(w));
}

export interface TriageInput {
  kind: TriageKind;
  /** Primeiro handoff da cadeia (exceção) ou atribuição (alerta): quando o lead passou a precisar de vendedor. NUNCA é zerado. */
  anchorAt: string;
  /** Momento em que a pendência nasceu: criação da exceção, ou vencimento do SLA do alerta. */
  flaggedAt: string;
  /** Mensagens humanas (role human_agent) desde `anchorAt`. */
  humanReplies: Array<{ content: string | null; at: string }>;
  lastMessage: { role: string; at: string; content?: string | null } | null;
  /** Evento de resolução válido (resolved_*), se houver. */
  resolvedEvent: { kind: string; at: string } | null;
  conversationStatus: string | null;
  hasOpenOpportunity: boolean;
  now: Date;
  calendar: BusinessCalendar;
}

export interface TriageResult {
  state: TriageState;
  /** null quando resolvida (não aparece nas listas de pendência). */
  group: TriageGroup | null;
  hasCommercialReply: boolean;
  commercialReplyCount: number;
  lastReplyClass: ReplyClass | null;
  clientWaiting: boolean;
  waitingSince: string | null;
  /** Atraso desde o primeiro handoff/atribuição: corrido e em minutos úteis (nunca reiniciado pela exceção). */
  accumulatedWallMinutes: number;
  accumulatedBusinessMinutes: number;
  /** Atraso desde que a pendência nasceu. */
  sinceFlaggedWallMinutes: number;
  sinceFlaggedBusinessMinutes: number;
  /** Respondida pelo celular/painel, mas sem aceite formal de vendedor identificado (a resposta nunca vira aceite sozinha). */
  needsOwnerConfirmation: boolean;
}

const minutes = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 60_000));

export function classifyTriage(i: TriageInput): TriageResult {
  const anchor = new Date(i.anchorAt);
  const flagged = new Date(i.flaggedAt);
  const replies = i.humanReplies.map(r => ({ ...r, cls: classifyHumanReply(r.content) }));
  const commercial = replies.filter(r => r.cls === "comercial");
  // Cliente "esperando" = a última mensagem é dele e NÃO é só uma cortesia de encerramento depois de uma resposta humana.
  const clientWaiting = i.lastMessage?.role === "contact" && !(replies.length > 0 && isClosingAcknowledgement(i.lastMessage.content));
  const base = {
    hasCommercialReply: commercial.length > 0,
    commercialReplyCount: commercial.length,
    lastReplyClass: replies.length ? replies[replies.length - 1].cls : null,
    clientWaiting,
    waitingSince: clientWaiting ? i.lastMessage!.at : null,
    accumulatedWallMinutes: minutes(anchor, i.now),
    accumulatedBusinessMinutes: Math.floor(businessMinutesBetween(anchor, i.now, i.calendar)),
    sinceFlaggedWallMinutes: minutes(flagged, i.now),
    sinceFlaggedBusinessMinutes: Math.floor(businessMinutesBetween(flagged, i.now, i.calendar)),
  };
  if (i.resolvedEvent) return { ...base, state: "resolvida", group: null, needsOwnerConfirmation: false };
  // Cliente esperando é sempre urgente: a última palavra é dele.
  if (clientWaiting) return { ...base, state: "aguardando_atendimento_comercial", group: "urgente", needsOwnerConfirmation: false };
  if (base.hasCommercialReply) return { ...base, state: "respondida_sem_aceite", group: "respondida", needsOwnerConfirmation: true };
  if (i.kind === "alert") {
    const ageDays = base.sinceFlaggedWallMinutes / 1440;
    const closedConversation = i.conversationStatus === "resolved" || i.conversationStatus === "closed";
    if (closedConversation || !i.hasOpenOpportunity || ageDays >= OBSOLETE_AFTER_DAYS) {
      return { ...base, state: "obsoleta", group: "obsoleta", needsOwnerConfirmation: false };
    }
  }
  return { ...base, state: "aguardando_atendimento_comercial", group: "urgente", needsOwnerConfirmation: false };
}

// ---------- Escada de alertas ----------

export interface AlertPlanInput {
  mode: ExceptionAlertsMode;
  /** Criação da exceção (lead_assignments.assigned_at da linha `exception`). */
  exceptionAt: Date;
  now: Date;
  calendar: BusinessCalendar;
  /** Estágios já registrados no livro (qualquer canal, inclusive "pulado"). */
  recordedStages: number[];
  /** Resolução válida (evento resolved_* OU a exceção deixou de estar aberta). */
  resolved: boolean;
  /** Ativação da funcionalidade: exceções criadas antes NUNCA geram aviso (sem retroativo). Ausente = nada é enviado. */
  activatedAt: Date | null;
}

export interface AlertPlan {
  /** Estágio a enviar agora (o mais alto vencido e ainda não registrado), ou null. */
  send: { stage: ExceptionAlertStage; dueAt: Date } | null;
  /** Estágios vencidos mais baixos que ficaram para trás (worker parado): registrados como pulados, sem enxurrada. */
  skip: ExceptionAlertStage[];
  /** Por que nada será enviado (diagnóstico para o log). */
  reason: "mode_off" | "resolved" | "not_activated" | "before_activation" | "nothing_due" | null;
}

/** Vencimento do estágio: o 0 é imediato (criação da exceção); os demais contam MINUTOS ÚTEIS desde a criação. */
export function exceptionAlertDueAt(exceptionAt: Date, stage: ExceptionAlertStage, calendar: BusinessCalendar): Date {
  return stage === 0 ? new Date(exceptionAt.getTime()) : addBusinessMinutes(exceptionAt, stage, calendar);
}

export function planExceptionAlerts(i: AlertPlanInput): AlertPlan {
  const none = (reason: AlertPlan["reason"]): AlertPlan => ({ send: null, skip: [], reason });
  if (i.mode === "off") return none("mode_off");
  if (i.resolved) return none("resolved");
  if (!i.activatedAt) return none("not_activated");
  if (i.exceptionAt.getTime() < i.activatedAt.getTime()) return none("before_activation");
  const recorded = new Set(i.recordedStages);
  const due = EXCEPTION_ALERT_STAGES
    .filter(stage => !recorded.has(stage))
    .map(stage => ({ stage, dueAt: exceptionAlertDueAt(i.exceptionAt, stage, i.calendar) }))
    .filter(x => x.dueAt.getTime() <= i.now.getTime());
  if (!due.length) return none("nothing_due");
  const top = due[due.length - 1];
  return { send: top, skip: due.slice(0, -1).map(x => x.stage), reason: null };
}

/** Quem recebe cada estágio. 0/15/30: gestores + vendedores; 60 (crítico): só gestores. Sem destinatário configurado = lista vazia (nunca cai em "todos os owners"). */
export function exceptionAlertRecipients(stage: ExceptionAlertStage, managerIds: string[], repUserIds: string[]): string[] {
  const set = new Set<string>(managerIds);
  if (stage !== 60) for (const id of repUserIds) set.add(id);
  return [...set];
}

export interface ExceptionAlertMessage { title: string; body: string; severity: "info" | "warning" | "critical"; url: string }

const fmtDuration = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`);
const fmtLocal = (iso: string, timeZone: string) => {
  try { return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); }
  catch { return iso; }
};

/**
 * Texto do aviso. NUNCA inclui nome, telefone ou conteúdo de mensagem do cliente (e-mail/push saem de sistemas externos);
 * o link abre o painel, que exige login. Mostra o horário do primeiro handoff e o atraso acumulado (não o da exceção).
 */
export function buildExceptionAlertMessage(stage: ExceptionAlertStage, ctx: { anchorAt: string; accumulatedBusinessMinutes: number; accumulatedWallMinutes: number; timeZone: string }): ExceptionAlertMessage {
  const since = `Handoff original: ${fmtLocal(ctx.anchorAt, ctx.timeZone)}. Atraso acumulado: ${fmtDuration(ctx.accumulatedBusinessMinutes)} úteis (${fmtDuration(ctx.accumulatedWallMinutes)} corridos).`;
  const url = "/opportunities";
  switch (stage) {
    case 0: return { title: "Lead sem vendedor: exceção de SLA", body: `Os dois vendedores estouraram o prazo. ${since} Abra o painel de exceções.`, severity: "warning", url };
    case 15: return { title: "Cobrança: exceção de SLA sem aceite", body: `Ainda sem atendimento comercial confirmado (15 min úteis). ${since}`, severity: "warning", url };
    case 30: return { title: "Escalonamento: exceção de SLA sem aceite", body: `30 min úteis sem resolução. ${since}`, severity: "warning", url };
    case 60: return { title: "CRÍTICO: exceção de SLA sem aceite", body: `60 min úteis sem resolução. ${since}`, severity: "critical", url };
  }
}
