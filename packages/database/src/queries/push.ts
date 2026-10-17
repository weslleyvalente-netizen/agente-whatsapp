import type { SupabaseClient } from "@supabase/supabase-js";

export interface PushCandidate {
  organizationId: string;
  userId: string;
  /** Chaves de idempotência (push_notification_log). Mais de uma quando várias mensagens viram uma notificação. */
  dedupeKeys: string[];
  title: string;
  body: string;
  url: string;
  tag: string;
}

export async function upsertPushSubscription(
  db: SupabaseClient,
  p: { organizationId: string; userId: string; endpoint: string; p256dh: string; auth: string; userAgent?: string | null },
) {
  const { error } = await db.from("push_subscriptions").upsert({
    organization_id: p.organizationId, user_id: p.userId, endpoint: p.endpoint, p256dh: p.p256dh, auth: p.auth,
    user_agent: p.userAgent ?? null, last_seen_at: new Date().toISOString(),
  }, { onConflict: "endpoint" });
  if (error) throw error;
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

type One<T> = T | T[] | null | undefined;
const first = <T>(v: One<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
type ContactRef = { name?: string | null; phone?: string | null };
const contactLabel = (c: ContactRef | null) => c?.name?.trim() || c?.phone || "cliente";
const inboxUrl = (conversationId: string) => `/inbox?id=${conversationId}`;

type AssignmentRow = {
  id: string; organization_id: string; conversation_id: string; sla_due_at?: string | null;
  sales_reps: One<{ user_id?: string | null }>; wa_contacts: One<ContactRef>;
};
const ASSIGNMENT_SELECT = "id, organization_id, conversation_id, sla_due_at, sales_reps(user_id), wa_contacts(name, phone)";

/** Atribuições pendentes criadas desde `since`: "Novo lead" para o vendedor dono da atribuição. */
export async function listNewAssignmentCandidates(db: SupabaseClient, since: Date): Promise<PushCandidate[]> {
  const { data, error } = await db.from("lead_assignments").select(ASSIGNMENT_SELECT)
    .eq("status", "pending").not("rep_id", "is", null).gte("created_at", since.toISOString()).order("created_at").limit(200);
  if (error) throw error;
  const out: PushCandidate[] = [];
  for (const row of (data ?? []) as unknown as AssignmentRow[]) {
    const userId = first(row.sales_reps)?.user_id;
    if (!userId) continue;
    out.push({
      organizationId: row.organization_id, userId, dedupeKeys: [`assign:${row.id}`],
      title: `Novo lead: ${contactLabel(first(row.wa_contacts))}`, body: "Toque para atender.", url: inboxUrl(row.conversation_id), tag: `assign-${row.id}`,
    });
  }
  return out;
}

/** Atribuições pendentes que vencem em até `windowMinutes`: "Responda {nome} — faltam N min". */
export async function listSlaRiskCandidates(db: SupabaseClient, now: Date, windowMinutes = 15): Promise<PushCandidate[]> {
  const limit = new Date(now.getTime() + windowMinutes * 60_000);
  const { data, error } = await db.from("lead_assignments").select(ASSIGNMENT_SELECT)
    .eq("status", "pending").not("rep_id", "is", null)
    .gt("sla_due_at", now.toISOString()).lte("sla_due_at", limit.toISOString()).order("sla_due_at").limit(200);
  if (error) throw error;
  const out: PushCandidate[] = [];
  for (const row of (data ?? []) as unknown as AssignmentRow[]) {
    const userId = first(row.sales_reps)?.user_id;
    if (!userId || !row.sla_due_at) continue;
    const minutes = Math.max(1, Math.ceil((new Date(row.sla_due_at).getTime() - now.getTime()) / 60_000));
    out.push({
      organizationId: row.organization_id, userId, dedupeKeys: [`sla:${row.id}`],
      title: `Responda ${contactLabel(first(row.wa_contacts))} — faltam ${minutes} min`, body: "O prazo para assumir o lead está acabando.",
      url: inboxUrl(row.conversation_id), tag: `sla-${row.id}`,
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
export async function listCustomerMessageCandidates(db: SupabaseClient, since: Date): Promise<PushCandidate[]> {
  const { data, error } = await db.from("messages")
    .select("id, content, created_at, conversation_id, organization_id, conversations!inner(assigned_to, is_human_takeover, wa_contacts(name, phone))")
    .eq("role", "contact").not("conversations.assigned_to", "is", null).gte("created_at", since.toISOString()).order("created_at").limit(500);
  if (error) throw error;
  const byConversation = new Map<string, MessageRow[]>();
  for (const row of (data ?? []) as unknown as MessageRow[]) {
    if (!first(row.conversations)?.assigned_to) continue;
    byConversation.set(row.conversation_id, [...(byConversation.get(row.conversation_id) ?? []), row]);
  }
  // Sem takeover: só vale se a conversa nunca teve resposta humana.
  const needCheck = [...byConversation].filter(([, rows]) => !first(rows[0].conversations)?.is_human_takeover).map(([id]) => id);
  const answered = new Set<string>();
  if (needCheck.length) {
    const { data: human, error: humanError } = await db.from("messages").select("conversation_id").eq("role", "human_agent").in("conversation_id", needCheck);
    if (humanError) throw humanError;
    for (const h of (human ?? []) as Array<{ conversation_id: string }>) answered.add(h.conversation_id);
  }
  const out: PushCandidate[] = [];
  for (const [conversationId, rows] of byConversation) {
    const conv = first(rows[0].conversations)!;
    if (!conv.is_human_takeover && answered.has(conversationId)) continue;
    const last = rows[rows.length - 1];
    out.push({
      organizationId: last.organization_id, userId: conv.assigned_to!, dedupeKeys: rows.map(r => `msg:${r.id}`),
      title: contactLabel(first(conv.wa_contacts ?? null)), body: (last.content ?? "").trim().slice(0, SNIPPET_LENGTH) || "Nova mensagem",
      url: inboxUrl(conversationId), tag: conversationId,
    });
  }
  return out;
}
