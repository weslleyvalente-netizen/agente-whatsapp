import type { SupabaseClient } from "@supabase/supabase-js";

export interface PushCandidate {
  kind: "assign" | "message" | "sla";
  organizationId: string;
  userId: string;
  /** Chaves de idempotência (push_notification_log). Mais de uma quando várias mensagens viram uma notificação. */
  dedupeKeys: string[];
  title: string;
  body: string;
  url: string;
  tag: string;
}

/**
 * Assina/atualiza por endpoint. Se o endpoint já pertence a OUTRO usuário, só é reatribuído quando as chaves enviadas
 * são as mesmas (prova de que o chamador tem aquela assinatura do navegador); senão devolve "conflict".
 */
export async function upsertPushSubscription(
  db: SupabaseClient,
  p: { organizationId: string; userId: string; endpoint: string; p256dh: string; auth: string; userAgent?: string | null },
): Promise<"ok" | "conflict"> {
  const { data: existing, error: findError } = await db.from("push_subscriptions").select("user_id, p256dh, auth").eq("endpoint", p.endpoint).maybeSingle();
  if (findError) throw findError;
  const row = existing as { user_id: string; p256dh: string; auth: string } | null;
  if (row && row.user_id !== p.userId && (row.p256dh !== p.p256dh || row.auth !== p.auth)) return "conflict";
  const { error } = await db.from("push_subscriptions").upsert({
    organization_id: p.organizationId, user_id: p.userId, endpoint: p.endpoint, p256dh: p.p256dh, auth: p.auth,
    user_agent: p.userAgent ?? null, last_seen_at: new Date().toISOString(),
  }, { onConflict: "endpoint" });
  if (error) throw error;
  return "ok";
}

export async function deletePushSubscription(db: SupabaseClient, userId: string, endpoint: string) {
  const { error } = await db.from("push_subscriptions").delete().eq("user_id", userId).eq("endpoint", endpoint);
  if (error) throw error;
}

/** Reserva a chave de idempotência. true = esta chamada ganhou (deve notificar); false = já notificado. */
export async function claimPushDedupe(db: SupabaseClient, dedupeKey: string, userId: string): Promise<boolean> {
  const { data, error } = await db.from("push_notification_log")
    .upsert({ dedupe_key: dedupeKey, user_id: userId }, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("dedupe_key");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Libera chaves reservadas quando o envio falhou, para a próxima varredura tentar de novo. */
export async function releasePushDedupe(db: SupabaseClient, dedupeKeys: string[]) {
  if (!dedupeKeys.length) return;
  const { error } = await db.from("push_notification_log").delete().in("dedupe_key", dedupeKeys);
  if (error) throw error;
}

/** Retenção do log de idempotência (as chaves só importam por alguns minutos). */
export async function purgePushNotificationLog(db: SupabaseClient, olderThan: Date) {
  const { error } = await db.from("push_notification_log").delete().lt("created_at", olderThan.toISOString());
  if (error) throw error;
}

/** Organizações com push_notifications_enabled === true. */
export async function listPushEnabledOrganizationIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from("organizations").select("id").eq("settings->>push_notifications_enabled", "true");
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map(o => o.id);
}

/** Dos usuários informados, quem ainda é membro da organização. */
export async function listCurrentMemberIds(db: SupabaseClient, organizationId: string, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const { data, error } = await db.from("organization_members").select("user_id").eq("organization_id", organizationId).in("user_id", userIds);
  if (error) throw error;
  return new Set(((data ?? []) as Array<{ user_id: string }>).map(m => m.user_id));
}

/** Remove as assinaturas do usuário numa organização (saiu da organização). */
export async function deletePushSubscriptionsForUser(db: SupabaseClient, organizationId: string, userId: string) {
  const { error } = await db.from("push_subscriptions").delete().eq("organization_id", organizationId).eq("user_id", userId);
  if (error) throw error;
}

export interface PushListResult {
  candidates: PushCandidate[];
  /** Quando o limite de linhas foi atingido: só é seguro avançar o cursor até aqui. */
  truncatedAt: Date | null;
}
const ASSIGNMENT_LIMIT = 200;
const MESSAGE_LIMIT = 500;
/** Atribuição precisa ter esta idade antes do alerta de SLA, para não chegar junto com "Novo lead". */
export const SLA_ALERT_MIN_AGE_MINUTES = 5;

type One<T> = T | T[] | null | undefined;
const first = <T>(v: One<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
type ContactRef = { name?: string | null; phone?: string | null };
const contactLabel = (c: ContactRef | null) => c?.name?.trim() || "Cliente";
const inboxUrl = (conversationId: string) => `/inbox?id=${conversationId}`;

type AssignmentRow = {
  id: string; organization_id: string; conversation_id: string; created_at?: string; sla_due_at?: string | null;
  sales_reps: One<{ user_id?: string | null }>; wa_contacts: One<ContactRef>;
};
const ASSIGNMENT_SELECT = "id, organization_id, conversation_id, created_at, sla_due_at, sales_reps(user_id), wa_contacts(name, phone)";
const truncation = (rows: Array<{ created_at?: string }>, limit: number): Date | null =>
  rows.length >= limit && rows[rows.length - 1]?.created_at ? new Date(rows[rows.length - 1].created_at!) : null;

/** Atribuições pendentes criadas desde `since`: "Novo lead" para o vendedor dono da atribuição. */
export async function listNewAssignmentCandidates(db: SupabaseClient, since: Date, orgIds: string[]): Promise<PushListResult> {
  if (!orgIds.length) return { candidates: [], truncatedAt: null };
  const { data, error } = await db.from("lead_assignments").select(ASSIGNMENT_SELECT).in("organization_id", orgIds)
    .eq("status", "pending").not("rep_id", "is", null).gte("created_at", since.toISOString()).order("created_at").limit(ASSIGNMENT_LIMIT);
  if (error) throw error;
  const rows = (data ?? []) as unknown as AssignmentRow[];
  const candidates: PushCandidate[] = [];
  for (const row of rows) {
    const userId = first(row.sales_reps)?.user_id;
    if (!userId) continue;
    candidates.push({
      kind: "assign", organizationId: row.organization_id, userId, dedupeKeys: [`assign:${row.id}`],
      title: `Novo lead: ${contactLabel(first(row.wa_contacts))}`, body: "Toque para atender.", url: inboxUrl(row.conversation_id), tag: row.conversation_id,
    });
  }
  return { candidates, truncatedAt: truncation(rows, ASSIGNMENT_LIMIT) };
}

/**
 * Atribuições pendentes que vencem em até `windowMinutes` e já têm pelo menos SLA_ALERT_MIN_AGE_MINUTES de idade
 * (assim o alerta nunca chega junto com "Novo lead"): "Responda {nome} — faltam N min".
 */
export async function listSlaRiskCandidates(db: SupabaseClient, now: Date, orgIds: string[], windowMinutes = 15): Promise<PushCandidate[]> {
  if (!orgIds.length) return [];
  const limit = new Date(now.getTime() + windowMinutes * 60_000);
  const oldEnough = new Date(now.getTime() - SLA_ALERT_MIN_AGE_MINUTES * 60_000);
  const { data, error } = await db.from("lead_assignments").select(ASSIGNMENT_SELECT).in("organization_id", orgIds)
    .eq("status", "pending").not("rep_id", "is", null).lte("created_at", oldEnough.toISOString())
    .gt("sla_due_at", now.toISOString()).lte("sla_due_at", limit.toISOString()).order("sla_due_at").limit(ASSIGNMENT_LIMIT);
  if (error) throw error;
  const out: PushCandidate[] = [];
  for (const row of (data ?? []) as unknown as AssignmentRow[]) {
    const userId = first(row.sales_reps)?.user_id;
    if (!userId || !row.sla_due_at) continue;
    const minutes = Math.max(1, Math.ceil((new Date(row.sla_due_at).getTime() - now.getTime()) / 60_000));
    out.push({
      kind: "sla", organizationId: row.organization_id, userId, dedupeKeys: [`sla:${row.id}`],
      title: `Responda ${contactLabel(first(row.wa_contacts))} — faltam ${minutes} min`, body: "O prazo para assumir o lead está acabando.",
      url: inboxUrl(row.conversation_id), tag: row.conversation_id,
    });
  }
  return out;
}

type MessageRow = {
  id: string; content: string | null; created_at: string; conversation_id: string; organization_id: string;
  conversations: One<{ assigned_to?: string | null; is_human_takeover?: boolean; wa_contacts?: One<ContactRef> }>;
};
const SNIPPET_LENGTH = 80;

/**
 * Mensagens de cliente desde `since` em conversas que têm dono (assigned_to) e estão em atendimento humano
 * ou ainda sem nenhuma resposta humana. Uma candidata por conversa (a mais recente), tag = conversa.
 */
export async function listCustomerMessageCandidates(db: SupabaseClient, since: Date, orgIds: string[]): Promise<PushListResult> {
  if (!orgIds.length) return { candidates: [], truncatedAt: null };
  const { data, error } = await db.from("messages")
    .select("id, content, created_at, conversation_id, organization_id, conversations!inner(assigned_to, is_human_takeover, wa_contacts(name, phone))")
    .in("organization_id", orgIds).eq("role", "contact").not("conversations.assigned_to", "is", null)
    .gte("created_at", since.toISOString()).order("created_at").limit(MESSAGE_LIMIT);
  if (error) throw error;
  const all = (data ?? []) as unknown as MessageRow[];
  const byConversation = new Map<string, MessageRow[]>();
  for (const row of all) {
    if (!first(row.conversations)?.assigned_to) continue;
    byConversation.set(row.conversation_id, [...(byConversation.get(row.conversation_id) ?? []), row]);
  }
  // Sem takeover: só vale se a conversa nunca teve resposta humana. Uma consulta limit(1) por conversa:
  // não depende do teto de linhas do PostgREST.
  const needCheck = [...byConversation].filter(([, rows]) => !first(rows[0].conversations)?.is_human_takeover).map(([id]) => id);
  const answered = new Set<string>();
  const checks = await Promise.all(needCheck.map(async (id) => {
    const { data: human, error: humanError } = await db.from("messages").select("id").eq("conversation_id", id).eq("role", "human_agent").limit(1);
    if (humanError) throw humanError;
    return (human ?? []).length > 0 ? id : null;
  }));
  for (const id of checks) if (id) answered.add(id);
  const candidates: PushCandidate[] = [];
  for (const [conversationId, rows] of byConversation) {
    const conv = first(rows[0].conversations)!;
    if (!conv.is_human_takeover && answered.has(conversationId)) continue;
    const last = rows[rows.length - 1];
    candidates.push({
      kind: "message", organizationId: last.organization_id, userId: conv.assigned_to!, dedupeKeys: rows.map(r => `msg:${r.id}`),
      title: contactLabel(first(conv.wa_contacts ?? null)), body: (last.content ?? "").trim().slice(0, SNIPPET_LENGTH) || "Nova mensagem",
      url: inboxUrl(conversationId), tag: conversationId,
    });
  }
  return { candidates, truncatedAt: truncation(all, MESSAGE_LIMIT) };
}
