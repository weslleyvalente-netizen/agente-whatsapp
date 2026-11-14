import { funnelConversationHref } from "@aula-agente/shared";

// Alerta de FALHA DEFINITIVA de envio comercial: a mensagem esgotou as tentativas e nunca chegou ao cliente.
// Quem recebe: o vendedor responsável pela conversa e, se não houver, os gestores; os gestores também recebem um aviso agregado quando
// várias mensagens falham em poucos minutos (sinal de instância caída). Dois canais, ambos opt-in:
//   - push (send_failure_alerts_enabled + push_notifications_enabled);
//   - tarefa persistente no CRM (send_failure_tasks_enabled), que NÃO depende de o usuário ter assinatura push.
// Sem texto da mensagem, telefone ou chaves no aviso. Nunca lança: o alerta jamais pode afetar o envio.

export const BURST_WINDOW_MIN = 15;
export const BURST_THRESHOLD = 3;
/** Aviso da conversa: no máximo 1 a cada 10 min por conversa e usuário (falha posterior depois da janela avisa de novo; a tarefa persistente cobre o resto). */
export const CONVERSATION_BUCKET_MIN = 10;
/** Aviso agregado: 1 por 30 min e instância; piora da rajada (a cada 5 falhas a mais) avisa de novo dentro da janela. */
export const BURST_BUCKET_MIN = 30;
/** Falha de mensagem mais antiga que isto nunca alerta (reprocessamento de fila, backlog depois de uma queda). */
export const MAX_ALERT_AGE_MIN = 120;

export type AlertKind = "seller" | "manager_conversation" | "manager_burst";
export interface PlannedAlert { userId: string; kind: AlertKind }

/** Decisão pura de quem avisar. Gestor que também é o responsável não recebe duas vezes. */
export function planSendFailureAlerts(i: { assigneeId: string | null; managerIds: string[]; burstCount: number }): PlannedAlert[] {
  const out: PlannedAlert[] = [];
  const seen = new Set<string>();
  const add = (userId: string, kind: AlertKind) => { if (!seen.has(`${userId}:${kind}`)) { seen.add(`${userId}:${kind}`); out.push({ userId, kind }); } };
  if (i.assigneeId) add(i.assigneeId, "seller");
  else for (const m of i.managerIds) add(m, "manager_conversation"); // sem responsável: alguém precisa ver
  if (i.burstCount >= BURST_THRESHOLD) for (const m of i.managerIds) if (!(i.assigneeId === m)) add(m, "manager_burst");
  return out;
}

export interface SendFailureContext {
  organizationId: string; conversationId: string; contactId: string; messageId: string; messageCreatedAt: string | null;
  senderRole: string; contactName: string | null; instanceName: string | null; assigneeId: string | null;
}
export interface PushPayloadLite { title: string; body: string; url: string; tag?: string }
export interface SendFailureDeps {
  settings(organizationId: string): Promise<{ send_failure_alerts_enabled?: unknown; push_notifications_enabled?: unknown; send_failure_tasks_enabled?: unknown }>;
  managerIds(organizationId: string): Promise<string[]>;
  countRecentFailures(organizationId: string, sinceIso: string): Promise<number>;
  canReceivePush(organizationId: string, userId: string): Promise<boolean>;
  claim(key: string, userId: string): Promise<boolean>;
  release(keys: string[]): Promise<void>;
  sendPush(organizationId: string, userId: string, payload: PushPayloadLite): Promise<number>;
  /** Tarefa persistente "Mensagem não enviada" (com dedupe por contato). */
  createTask(ctx: SendFailureContext, text: { description: string; reason: string }): Promise<void>;
  log: { error(msg: string): void };
}
export interface SendFailureResult { sent: number; tasks: number; skipped: string[] }

const bucket = (now: Date, minutes: number) => Math.floor(now.getTime() / (minutes * 60_000));
const safeName = (n: string | null) => (n && !/^\d{6,}(@lid)?$/.test(n.trim()) ? n.trim().slice(0, 40) : "um cliente");

export function buildAlertPayload(kind: AlertKind, ctx: SendFailureContext, burstCount: number): PushPayloadLite {
  const who = safeName(ctx.contactName);
  if (kind === "manager_burst") {
    return { title: "Mensagens não enviadas", body: `${burstCount} mensagens não foram enviadas nos últimos ${BURST_WINDOW_MIN} min${ctx.instanceName ? ` (instância ${ctx.instanceName})` : ""}. Verifique a conexão do WhatsApp.`, url: "/settings", tag: `send-failed-burst-${ctx.instanceName ?? "org"}` };
  }
  const mine = ctx.senderRole === "human_agent";
  return {
    title: "Mensagem não enviada",
    body: `${mine ? "Sua mensagem para" : "A resposta automática para"} ${who} não foi enviada${ctx.instanceName ? ` (instância ${ctx.instanceName})` : ""}. Abra a conversa e verifique a conexão.`,
    url: funnelConversationHref(ctx.conversationId), tag: `send-failed-${ctx.conversationId}`,
  };
}

export function buildTaskText(ctx: SendFailureContext): { description: string; reason: string } {
  const who = safeName(ctx.contactName);
  return {
    description: `${ctx.senderRole === "human_agent" ? "A mensagem enviada" : "A resposta automática"} para ${who} NÃO foi entregue${ctx.instanceName ? ` (instância ${ctx.instanceName})` : ""}. Abra a conversa, verifique a conexão do WhatsApp e reenvie.`,
    reason: "Falha definitiva de envio: o cliente não recebeu a mensagem.",
  };
}

export async function notifySendFailure(deps: SendFailureDeps, ctx: SendFailureContext, now: Date = new Date()): Promise<SendFailureResult> {
  const result: SendFailureResult = { sent: 0, tasks: 0, skipped: [] };
  const err = (what: string, e: unknown) => deps.log.error(`send-failure-alert: ${what} (${String((e as Error)?.message ?? e).replace(/\d{8,}/g, "***").slice(0, 160)})`);
  try {
    const created = ctx.messageCreatedAt ? Date.parse(ctx.messageCreatedAt) : NaN;
    if (Number.isFinite(created) && now.getTime() - created > MAX_ALERT_AGE_MIN * 60_000) { result.skipped.push("too_old"); return result; }
    const s = await deps.settings(ctx.organizationId);
    const pushOn = s.send_failure_alerts_enabled === true && s.push_notifications_enabled === true;
    const tasksOn = s.send_failure_tasks_enabled === true;
    if (!pushOn && !tasksOn) { result.skipped.push("disabled"); return result; }
    // Tarefa persistente primeiro: é o canal que não depende de assinatura push.
    if (tasksOn) {
      try { await deps.createTask(ctx, buildTaskText(ctx)); result.tasks += 1; } catch (e) { result.skipped.push("error:task"); err("task failed", e); }
    }
    if (!pushOn) return result;
    const managerIds = await deps.managerIds(ctx.organizationId);
    const burstCount = await deps.countRecentFailures(ctx.organizationId, new Date(now.getTime() - BURST_WINDOW_MIN * 60_000).toISOString());
    const plan = planSendFailureAlerts({ assigneeId: ctx.assigneeId, managerIds, burstCount });
    for (const a of plan) {
      const key = a.kind === "manager_burst"
        ? `send-failed-burst:${ctx.organizationId}:${ctx.instanceName ?? "org"}:${bucket(now, BURST_BUCKET_MIN)}:${Math.floor(burstCount / 5)}:${a.userId}`
        : `send-failed:${ctx.conversationId}:${bucket(now, CONVERSATION_BUCKET_MIN)}:${a.userId}`;
      try {
        if (!(await deps.canReceivePush(ctx.organizationId, a.userId))) { result.skipped.push(`no_push:${a.kind}`); continue; }
        if (!(await deps.claim(key, a.userId))) { result.skipped.push(`duplicate:${a.kind}`); continue; }
        const sent = await deps.sendPush(ctx.organizationId, a.userId, buildAlertPayload(a.kind, ctx, burstCount));
        if (sent <= 0) { await deps.release([key]).catch(() => {}); result.skipped.push(`not_delivered:${a.kind}`); continue; }
        result.sent += 1;
      } catch (e) {
        await deps.release([key]).catch(() => {});
        result.skipped.push(`error:${a.kind}`);
        err(`${a.kind} failed`, e);
      }
    }
  } catch (e) {
    result.skipped.push("error");
    err("failed", e);
  }
  return result;
}
