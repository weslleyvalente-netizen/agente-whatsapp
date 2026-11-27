import { contactDisplayName, formatElapsed, funnelConversationHref, overdueLabel, SLA_NUDGE_COOLDOWN_MINUTES, type SalesRep, type SlaAlert } from "@aula-agente/shared";

export interface SlaAlertRow { id: string; client: string; repName: string; overdue: string; href: string }

/** Texto de cada linha do painel "Atrasos de resposta": cliente, vendedor, "venceu há X" e o link da conversa. */
export function slaAlertRow(a: SlaAlert, reps: Pick<SalesRep, "id" | "display_name">[], now: Date = new Date()): SlaAlertRow {
  return {
    id: a.id,
    client: contactDisplayName(a.contact_name, a.contact_phone),
    repName: reps.find((r) => r.id === a.rep_id)?.display_name ?? "—",
    overdue: overdueLabel(a.sla_due_at ?? a.assigned_at, now),
    href: funnelConversationHref(a.conversation_id),
  };
}

/** "Cutucado às 14:05" (horário de Brasília, como o resto do painel). */
export function nudgedAtLabel(iso: string): string {
  return `Cutucado às ${new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })}`;
}

export interface NudgeAllResult { repId: string; repName: string; count: number; status: "sent" | "rate_limited" | "no_device" | "failed" | "no_user"; retryAfterMinutes?: number }

/** Resumo do "Cutucar todos" em uma frase. */
export function summarizeNudgeAll(results: NudgeAllResult[]): string {
  if (!results.length) return "Nenhum vendedor para avisar.";
  const sent = results.filter((r) => r.status === "sent").map((r) => r.repName);
  const parts: string[] = [];
  if (sent.length) parts.push(`Aviso enviado para ${sent.join(", ")}`);
  const limited = results.filter((r) => r.status === "rate_limited");
  if (limited.length) parts.push(`${limited.map((r) => r.repName).join(", ")}: já cutucado(s) há menos de ${SLA_NUDGE_COOLDOWN_MINUTES / 60} h`);
  const noDevice = results.filter((r) => r.status === "no_device");
  if (noDevice.length) parts.push(`${noDevice.map((r) => r.repName).join(", ")}: sem notificações ativadas`);
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length) parts.push(`${failed.map((r) => r.repName).join(", ")}: não foi possível entregar o aviso agora`);
  const noUser = results.filter((r) => r.status === "no_user");
  if (noUser.length) parts.push(`${noUser.map((r) => r.repName).join(", ")}: sem usuário vinculado`);
  return parts.join(". ") + ".";
}

/** Mensagem do painel quando o toque individual não foi enviado (resposta 200 com status diferente de "sent"). */
export function nudgeNotDeliveredMessage(status: string): string {
  return status === "failed" ? "Não foi possível entregar o aviso agora" : "O vendedor não tem notificações ativadas";
}

const EXCEPTION_REASONS: Record<string, string> = {
  no_available_rep: "Nenhum vendedor disponível", all_reps_sla_breached: "Nenhum vendedor respondeu no prazo", invalid_existing_owner: "Dono atual inválido",
  distribution_error: "Erro na distribuição", manual_review: "Conflito: revisão manual",
};

export interface ExceptionRow { id: string; client: string; reason: string; waiting: string; href: string; responsible?: string }

/** Linha de "Atraso no atendimento" para cliente que o rodízio não conseguiu entregar a ninguém: só aviso, sem escolher vendedor. */
export function exceptionRow(e: SlaAlert, now: Date = new Date(), reps: Array<{ id: string; display_name: string }> = []): ExceptionRow {
  // Fase C: vendedor que ficou responsável quando o rodízio se esgotou (lead_assignments.responsible_rep_id).
  const responsibleId = (e as unknown as { responsible_rep_id?: string | null }).responsible_rep_id;
  const responsible = responsibleId ? reps.find((r) => r.id === responsibleId)?.display_name : undefined;
  return {
    ...(responsible ? { responsible } : {}),
    id: e.id,
    client: contactDisplayName(e.contact_name, e.contact_phone),
    reason: EXCEPTION_REASONS[e.exception_reason ?? ""] ?? e.exception_reason ?? "Sem vendedor",
    waiting: `há ${formatElapsed(now.getTime() - Date.parse(e.assigned_at))}`,
    href: funnelConversationHref(e.conversation_id),
  };
}
