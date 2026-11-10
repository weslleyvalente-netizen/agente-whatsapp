import { contactDisplayName, funnelConversationHref, overdueLabel, type SalesRep, type SlaAlert } from "@aula-agente/shared";

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

export interface NudgeAllResult { repId: string; repName: string; count: number; status: "sent" | "rate_limited" | "no_device" | "no_user"; retryAfterMinutes?: number }

/** Resumo do "Cutucar todos" em uma frase. */
export function summarizeNudgeAll(results: NudgeAllResult[]): string {
  if (!results.length) return "Nenhum vendedor para avisar.";
  const sent = results.filter((r) => r.status === "sent").map((r) => r.repName);
  const parts: string[] = [];
  if (sent.length) parts.push(`Aviso enviado para ${sent.join(", ")}`);
  const limited = results.filter((r) => r.status === "rate_limited");
  if (limited.length) parts.push(`${limited.map((r) => r.repName).join(", ")}: já cutucado(s) há menos de 2 h`);
  const noDevice = results.filter((r) => r.status === "no_device");
  if (noDevice.length) parts.push(`${noDevice.map((r) => r.repName).join(", ")}: sem notificações ativadas`);
  const noUser = results.filter((r) => r.status === "no_user");
  if (noUser.length) parts.push(`${noUser.map((r) => r.repName).join(", ")}: sem usuário vinculado`);
  return parts.join(". ") + ".";
}
