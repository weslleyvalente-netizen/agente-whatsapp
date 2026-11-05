import { addBusinessMinutes, isBusinessOpen, type BusinessCalendar } from "./business-calendar.js";
import { decideFollowupGate } from "./task-helpers.js";

// Regra "Cutucar cliente": o vendedor falou por último (proposta, simulação...) e o cliente sumiu.
// Tarefa para o vendedor dono, em minutos ÚTEIS do calendário da organização. Funções puras: nada de relógio global.

/** Um dia útil de 10 h (08:00-18:00) em minutos úteis; a escada abaixo é medida nele. */
export const DIA_UTIL = 600;
/** Silêncio mínimo (minutos úteis desde a última mensagem do vendedor) para o toque 1, 2 e 3. */
export const CUSTOMER_NUDGE_LADDER_MINUTES = [1 * DIA_UTIL, 3 * DIA_UTIL, 7 * DIA_UTIL] as const;
export const CUSTOMER_NUDGE_LADDER_DAYS = [1, 3, 7] as const;
/**
 * Intervalo mínimo (minutos úteis) desde o toque anterior, indexado por priorTouches (0 = sem toque anterior):
 * as diferenças da escada (3-1 e 7-3). Impede que concluir o toque N faça o N+1 nascer na hora num cliente já parado há muito tempo.
 */
export const CUSTOMER_NUDGE_INTERVAL_MINUTES = [0, 2 * DIA_UTIL, 4 * DIA_UTIL] as const;
export const CUSTOMER_NUDGE_MAX_TOUCHES = CUSTOMER_NUDGE_LADDER_MINUTES.length;
/** Anti-enxurrada: só olha conversas cuja última mensagem do vendedor tem até 14 dias. */
export const CUSTOMER_NUDGE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** Anti-enxurrada: no máximo 25 tarefas novas por organização por execução. */
export const CUSTOMER_NUDGE_MAX_NEW_PER_RUN = 25;

export type CustomerNudgeSkipReason =
  | "no_owner" | "too_old" | "outside_business_hours" | "max_touches" | "open_task" | "frozen"
  | "waiting_scheduled" | "waiting_on_us" | "customer_refused" | "not_due_yet" | "nudge_interval";

export interface CustomerNudgeInput {
  now: Date;
  calendar: BusinessCalendar;
  /** Criação da última mensagem do vendedor (role human_agent), que já é a última da conversa. */
  lastSellerMessageAt: Date;
  /** Tarefas customer_nudge já criadas na conversa depois da última mensagem do cliente (todas, se ele nunca falou). */
  priorTouches: number;
  /** Momento do toque anterior do ciclo atual: o maior entre createdAt e completedAt da tarefa customer_nudge mais recente (ISO); null sem toque anterior. */
  lastNudgeAt?: string | null;
  /** opportunities.owner_id (fallback conversations.assigned_to); sem dono não cria. */
  ownerId: string | null;
  /** Já existe tarefa aberta customer_nudge na conversa. */
  hasOpenTask: boolean;
  frozen: boolean;
  /** Negócio aberto escolhido para o contato (waiting_on / waiting_on_until). */
  opportunity: { waiting_on: string | null; waiting_on_until: string | null } | null;
  /** Data de hoje (YYYY-MM-DD) no fuso do calendário, para o gate de retorno combinado. */
  todayISODate: string;
  /** A última mensagem do cliente antes da do vendedor é uma recusa explícita (só recusa pula; "ok/obrigado" seguido de silêncio é cutucado). */
  customerRefused: boolean;
}

export type CustomerNudgeDecision =
  | { action: "create"; touch: number; ladderDays: number }
  | { action: "skip"; reason: CustomerNudgeSkipReason };

/**
 * Decide se hoje deve nascer a tarefa "Cutucar cliente" e em que toque (1 a 3).
 * Os fatos caros (congelado, recusa) podem vir `false` numa primeira passada barata; quem chama só os consulta
 * quando esta função já devolveria "create" e então decide de novo com os valores reais.
 */
export function decideCustomerNudge(i: CustomerNudgeInput): CustomerNudgeDecision {
  const skip = (reason: CustomerNudgeSkipReason): CustomerNudgeDecision => ({ action: "skip", reason });
  if (!i.ownerId) return skip("no_owner");
  if (i.now.getTime() - i.lastSellerMessageAt.getTime() > CUSTOMER_NUDGE_MAX_AGE_MS) return skip("too_old");
  // Só avisa dentro do expediente, para a tarefa aparecer de manhã para o vendedor.
  if (!isBusinessOpen(i.now, i.calendar)) return skip("outside_business_hours");
  if (i.priorTouches >= CUSTOMER_NUDGE_MAX_TOUCHES) return skip("max_touches");
  if (i.hasOpenTask) return skip("open_task");
  const dueAt = addBusinessMinutes(i.lastSellerMessageAt, CUSTOMER_NUDGE_LADDER_MINUTES[Math.max(0, i.priorTouches)], i.calendar);
  if (i.now.getTime() < dueAt.getTime()) return skip("not_due_yet");
  // Intervalo desde o toque anterior (além do silêncio desde a última mensagem do vendedor): ambos precisam valer.
  if (i.priorTouches > 0 && i.lastNudgeAt) {
    const intervalDueAt = addBusinessMinutes(new Date(i.lastNudgeAt), CUSTOMER_NUDGE_INTERVAL_MINUTES[Math.min(i.priorTouches, CUSTOMER_NUDGE_INTERVAL_MINUTES.length - 1)], i.calendar);
    if (i.now.getTime() < intervalDueAt.getTime()) return skip("nudge_interval");
  }
  if (i.frozen) return skip("frozen");
  // Retorno combinado ainda no futuro: não cutuca. team/bank_or_admin = pendência NOSSA, não do cliente.
  const gate = decideFollowupGate(i.opportunity, i.todayISODate);
  if (gate === "skip_scheduled_callback") return skip("waiting_scheduled");
  if (gate !== "send") return skip("waiting_on_us");
  if (i.customerRefused) return skip("customer_refused");
  return { action: "create", touch: i.priorTouches + 1, ladderDays: CUSTOMER_NUDGE_LADDER_DAYS[i.priorTouches] };
}

/** Texto, prioridade e motivo da tarefa de cada toque. */
export function buildCustomerNudgeTask(touch: number, ladderDays: number) {
  const dias = ladderDays === 1 ? "1 dia útil" : `${ladderDays} dias úteis`;
  const last = touch >= CUSTOMER_NUDGE_MAX_TOUCHES;
  return {
    description: `Cliente parou de responder há ${dias} depois da sua última mensagem. Retome a conversa (toque ${touch} de ${CUSTOMER_NUDGE_MAX_TOUCHES}).${last ? " Se não houver retorno, considere encerrar ou marcar o negócio como perdido." : ""}`,
    reason: `Sem resposta do cliente há ${dias} após a última mensagem do vendedor.`,
    priority: (last ? "high" : "normal") as "high" | "normal",
  };
}
