import type { SupabaseClient } from "@supabase/supabase-js";
import { notifySendFailure, MAX_TASK_AGE_HOURS, type SendFailureContext, type SendFailureDeps, type SendFailureResult } from "@aula-agente/shared";
import { getOrganizationById } from "./organizations.js";
import { listManagerUserIds, hasPushSubscription, claimPushDedupe, releasePushDedupe } from "./push.js";
import { sendPushToUser, isPushConfigured } from "../push/send.js";
import { countRecentSendFailures } from "./messages.js";
import { createTaskWithDedup } from "./tasks.js";
import { getInstanceById } from "./evolution-instances.js";

// Ponto ÚNICO de registro de uma falha DEFINITIVA de envio (worker, API do inbox e varredura de reconciliação).
// Garante: (1) a mensagem fica marcada (send_failed_at) e o aviso/tarefa sai UMA vez por mensagem (send_failure_reported_at);
// (2) a tarefa persistente guarda a referência da mensagem (e é deduplicada por contato); (3) nunca lança.

/** Resultado de reivindicar o relatório da falha de uma mensagem. */
export type SendFailureClaim = "claimed" | "already_reported" | "delivered" | "missing";

const OUTBOUND_ROLES = ["agent", "human_agent"];

/** Mascara números longos (telefones) e corta: o motivo vai para metadata.send_error e para logs. */
export function sanitizeSendError(e: unknown): string {
  return String((e as Error)?.message ?? e ?? "erro desconhecido").replace(/\d{8,}/g, "***").slice(0, 300);
}

export function realSendFailureDeps(db: SupabaseClient): SendFailureDeps {
  return {
    settings: async (orgId) => (await getOrganizationById(db, orgId)).settings ?? {},
    managerIds: (orgId) => listManagerUserIds(db, orgId),
    countRecentFailures: (orgId, since) => countRecentSendFailures(db, orgId, since),
    canReceivePush: async (orgId, userId) => isPushConfigured() && hasPushSubscription(db, orgId, userId),
    claim: (key, userId) => claimPushDedupe(db, key, userId),
    release: (keys) => releasePushDedupe(db, keys),
    sendPush: async (orgId, userId, payload) => (await sendPushToUser(db, userId, payload, { organizationId: orgId })).sent,
    createTask: async (ctx, text) => {
      await createTaskWithDedup(db, {
        organization_id: ctx.organizationId, contact_id: ctx.contactId, conversation_id: ctx.conversationId, opportunity_id: null,
        type: "message_send_failed", description: text.description, reason: text.reason, priority: "high",
        due_date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }),
        created_by_type: "ai", created_by_id: null,
        // Sem responsável: fica SEM responsável (fila dos gestores), nunca "da IA" (o card mostraria "Helena").
        ...(ctx.assigneeId ? { assignee_type: "human" as const, assignee_id: ctx.assigneeId, assign_on_merge: true } : { assignee_type: null, assignee_id: null }),
        failed_message: { message_id: ctx.messageId, conversation_id: ctx.conversationId, failed_at: new Date().toISOString() },
      });
    },
    log: console,
  };
}

/**
 * Reivindica o relatório da falha da mensagem (atômico: o update só vale enquanto `send_failure_reported_at` está vazio).
 * Marca `send_failed_at`/`send_error` se ainda não estiverem (mensagem do vendedor pode já vir marcada). Mensagem que já tem id da
 * Evolution FOI entregue: nunca é reivindicada.
 */
export async function claimSendFailureReport(client: SupabaseClient, messageId: string, reason: string): Promise<SendFailureClaim> {
  const { data, error } = await client.from("messages").select("id, evolution_message_id, metadata").eq("id", messageId).maybeSingle();
  if (error) throw error;
  const row = data as { evolution_message_id: string | null; metadata: Record<string, unknown> | null } | null;
  if (!row) return "missing";
  if (row.evolution_message_id) return "delivered";
  const meta = row.metadata ?? {};
  if (meta.send_failure_reported_at) return "already_reported";
  const now = new Date().toISOString();
  const next = { ...meta, send_failed_at: meta.send_failed_at ?? now, send_error: meta.send_error ?? reason.slice(0, 300), send_failure_reported_at: now };
  const { data: updated, error: upErr } = await client.from("messages").update({ metadata: next })
    .eq("id", messageId).is("evolution_message_id", null).is("metadata->>send_failure_reported_at", null).select("id");
  if (upErr) throw upErr;
  return (updated as unknown[] | null)?.length ? "claimed" : "already_reported";
}

/** Devolve a reivindicação (aviso/tarefa não saiu): a falha continua marcada e pode ser refeita depois (reprocesso ou varredura). */
export async function releaseSendFailureReport(client: SupabaseClient, messageId: string): Promise<void> {
  const { data } = await client.from("messages").select("metadata").eq("id", messageId).maybeSingle();
  const meta = (data as { metadata: Record<string, unknown> | null } | null)?.metadata;
  if (!meta?.send_failure_reported_at) return;
  const { send_failure_reported_at: _r, ...rest } = meta;
  await client.from("messages").update({ metadata: rest }).eq("id", messageId);
}

/** A claim deve ser devolvida quando nada durável saiu: canais desligados ou erro ao criar a tarefa/montar o contexto. */
export function shouldReleaseClaim(result: SendFailureResult): boolean {
  return result.skipped.includes("disabled") || result.skipped.some((s) => s === "error" || s === "error:task");
}

export interface ReportSendFailureResult { claim: SendFailureClaim; result: SendFailureResult | null }

/**
 * Registra a falha definitiva de UMA mensagem nossa (agent/human_agent): marca, avisa e cria a tarefa persistente, uma vez só.
 * Idempotente e concorrente-seguro (reprocesso, retry e falhas simultâneas não duplicam aviso nem tarefa). Nunca lança.
 */
export async function reportSendFailure(client: SupabaseClient, input: { messageId: string; reason: string }, now: Date = new Date()): Promise<ReportSendFailureResult> {
  let claimed: SendFailureClaim = "missing";
  try {
    const { data: msg, error } = await client.from("messages").select("id, organization_id, conversation_id, role, created_at").eq("id", input.messageId).maybeSingle();
    if (error) throw error;
    const m = msg as { organization_id: string; conversation_id: string; role: string; created_at: string } | null;
    if (!m || !OUTBOUND_ROLES.includes(m.role)) return { claim: "missing", result: null };
    claimed = await claimSendFailureReport(client, input.messageId, input.reason);
    if (claimed !== "claimed") return { claim: claimed, result: null };
    const { data: convRow, error: convErr } = await client.from("conversations").select("contact_id, evolution_instance_id, assigned_to").eq("id", m.conversation_id).single();
    if (convErr) throw convErr;
    const conversation = convRow as { contact_id: string; evolution_instance_id?: string | null; assigned_to?: string | null };
    const { data: contactRow } = await client.from("wa_contacts").select("name").eq("id", conversation.contact_id).maybeSingle();
    const contactName = (contactRow as { name?: string | null } | null)?.name ?? null;
    let instanceName: string | null = null;
    try { if (conversation.evolution_instance_id) instanceName = (await getInstanceById(client, conversation.evolution_instance_id)).instance_name ?? null; } catch { /* nome é só informativo */ }
    const ctx: SendFailureContext = {
      organizationId: m.organization_id, conversationId: m.conversation_id, contactId: conversation.contact_id, messageId: input.messageId,
      messageCreatedAt: m.created_at, senderRole: m.role, contactName, instanceName, assigneeId: conversation.assigned_to ?? null,
    };
    const result = await notifySendFailure(realSendFailureDeps(client), ctx, now);
    if (shouldReleaseClaim(result)) await releaseSendFailureReport(client, input.messageId);
    return { claim: "claimed", result };
  } catch (err) {
    console.error("send-failure-report: could not report:", sanitizeSendError(err));
    if (claimed === "claimed") { try { await releaseSendFailureReport(client, input.messageId); } catch { /* a varredura refaz */ } }
    return { claim: claimed, result: null };
  }
}

/**
 * Rede de segurança: falhas definitivas das últimas 72 h (marcadas, sem id da Evolution) que NUNCA chegaram a gerar aviso/tarefa
 * (processo caiu entre marcar e avisar, tarefa falhou, flags ligadas depois da falha). Só atua em organizações com
 * `send_failure_tasks_enabled` E `send_failure_reconcile_enabled`. Mais antigas que 72 h ficam de fora (regra de idade).
 */
export async function reconcileUnreportedSendFailures(client: SupabaseClient, opts: { now?: Date; perOrgLimit?: number } = {}): Promise<{ organizations: number; reported: number }> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - MAX_TASK_AGE_HOURS * 3_600_000).toISOString();
  const { data: orgs, error } = await client.from("organizations").select("id")
    .eq("settings->>send_failure_tasks_enabled", "true").eq("settings->>send_failure_reconcile_enabled", "true");
  if (error) throw error;
  let reported = 0;
  for (const org of (orgs ?? []) as Array<{ id: string }>) {
    const { data: rows, error: e2 } = await client.from("messages").select("id, metadata")
      .eq("organization_id", org.id).in("role", OUTBOUND_ROLES).gte("created_at", since)
      .is("evolution_message_id", null).not("metadata->>send_failed_at", "is", null).is("metadata->>send_failure_reported_at", null)
      .order("created_at", { ascending: true }).limit(opts.perOrgLimit ?? 50);
    if (e2) throw e2;
    for (const r of (rows ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
      const out = await reportSendFailure(client, { messageId: r.id, reason: String(r.metadata?.send_error ?? "falha de envio") }, now);
      if (out.claim === "claimed" && out.result && !shouldReleaseClaim(out.result)) reported += 1;
    }
  }
  return { organizations: (orgs ?? []).length, reported };
}
