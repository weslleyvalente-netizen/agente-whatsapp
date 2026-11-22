import type { SupabaseClient } from "@supabase/supabase-js";
import { PROPOSAL_STAGES } from "@aula-agente/shared";
import { fetchAllPages } from "../pagination.js";
import { createTaskWithDedup, getTaskById, OPEN_TASK_STATUSES, resolveAwaitingCustomerPendency } from "./tasks.js";

// Consultas da rotina "commitments" (apps/worker/src/workers/commitments.ts). Leitura limitada: só mensagens de vendedor da janela
// e, por conversa acompanhada, as mensagens depois da proposta/promessa (com limite).

const BATCH = 100;
const chunk = <T>(list: T[], size = BATCH): T[][] => { const out: T[][] = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };
const first = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

export async function listCommitmentsOrganizations(db: SupabaseClient): Promise<Array<{ id: string; settings: Record<string, unknown> }>> {
  const { data, error } = await db.from("organizations").select("id, settings").eq("settings->>commitments_enabled", "true");
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; settings: Record<string, unknown> }>;
}

type RawMessage = { id: string; role: string; content: string | null; media_type: string | null; metadata: Record<string, any> | null; created_at: string; conversation_id: string };
const fileNameOf = (m: RawMessage) => (typeof m.metadata?.media?.file_name === "string" ? m.metadata.media.file_name : null);

export async function listRecentSellerMessages(db: SupabaseClient, organizationId: string, sinceIso: string) {
  const rows = await fetchAllPages<RawMessage & { conversations: { contact_id: string; assigned_to: string | null } | Array<{ contact_id: string; assigned_to: string | null }> }>(async (from, to) => {
    const { data, error } = await db.from("messages")
      .select("id, role, content, media_type, metadata, created_at, conversation_id, conversations!inner(contact_id, assigned_to)")
      .eq("organization_id", organizationId).eq("role", "human_agent").gte("created_at", sinceIso)
      .order("created_at", { ascending: true }).order("id").range(from, to);
    if (error) throw error;
    return (data ?? []) as any[];
  });
  return rows.map((m) => {
    const conv = first(m.conversations);
    return {
      id: m.id, conversationId: m.conversation_id, contactId: conv?.contact_id ?? "", assignedTo: conv?.assigned_to ?? null, createdAt: m.created_at,
      waOriginalAt: typeof m.metadata?.wa_original_at === "string" ? m.metadata.wa_original_at : null, content: m.content ?? "", mediaType: m.media_type,
      fileName: fileNameOf(m), sendFailed: !!m.metadata?.send_failed_at && !m.metadata?.send_recovered_at,
    };
  }).filter((m) => m.contactId);
}

export async function listMessagesAfter(db: SupabaseClient, organizationId: string, conversationId: string, afterIso: string) {
  const { data, error } = await db.from("messages").select("id, role, content, media_type, metadata, created_at, conversation_id")
    .eq("organization_id", organizationId).eq("conversation_id", conversationId).in("role", ["contact", "human_agent"]).gt("created_at", afterIso)
    .order("created_at", { ascending: true }).limit(50);
  if (error) throw error;
  return ((data ?? []) as RawMessage[])
    .filter((m) => m.role !== "human_agent" || !m.metadata?.send_failed_at || !!m.metadata?.send_recovered_at)
    .map((m) => ({ id: m.id, role: m.role, createdAt: m.created_at, content: m.content ?? "", mediaType: m.media_type, fileName: fileNameOf(m) }));
}

/** Negócio aberto do contato: prefere o que tem dono e, entre eles, o de interação mais recente. */
export async function getOpenOpportunityForContact(db: SupabaseClient, organizationId: string, contactId: string): Promise<{ id: string; ownerId: string | null } | null> {
  const { data, error } = await db.from("opportunities").select("id, owner_id, last_interaction_at, created_at")
    .eq("organization_id", organizationId).eq("contact_id", contactId).eq("status", "open");
  if (error) throw error;
  const list = ((data ?? []) as Array<{ id: string; owner_id: string | null; last_interaction_at: string | null; created_at: string }>)
    .sort((a, b) => Number(!!b.owner_id) - Number(!!a.owner_id) || (b.last_interaction_at ?? b.created_at).localeCompare(a.last_interaction_at ?? a.created_at) || a.id.localeCompare(b.id));
  return list[0] ? { id: list[0].id, ownerId: list[0].owner_id } : null;
}

export async function getOpportunityStatuses(db: SupabaseClient, organizationId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const batch of chunk(ids)) {
    const { data, error } = await db.from("opportunities").select("id, status").eq("organization_id", organizationId).in("id", batch);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string; status: string }>) out.set(r.id, r.status);
  }
  return out;
}

export async function getProposalStageEventSince(db: SupabaseClient, organizationId: string, opportunityId: string, sinceIso: string): Promise<{ at: string; stage: string } | null> {
  const { data, error } = await db.from("opportunity_events").select("new_value, created_at")
    .eq("organization_id", organizationId).eq("opportunity_id", opportunityId).eq("event_type", "stage_changed").gte("created_at", sinceIso)
    .order("created_at", { ascending: false }).limit(10);
  if (error) throw error;
  const hit = ((data ?? []) as Array<{ new_value: { stage?: string } | null; created_at: string }>)
    .find((e) => (PROPOSAL_STAGES as readonly string[]).includes(e.new_value?.stage ?? ""));
  return hit ? { at: hit.created_at, stage: hit.new_value!.stage! } : null;
}

export async function insertProposalFollowup(db: SupabaseClient, row: {
  organizationId: string; conversationId: string; opportunityId: string | null; ownerUserId: string | null; sellerMessageId: string; sentAt: string;
  identifiedBy: "stage_event" | "content"; evidence: string;
}): Promise<boolean> {
  const { data, error } = await db.from("proposal_followups").upsert({
    organization_id: row.organizationId, conversation_id: row.conversationId, opportunity_id: row.opportunityId, owner_user_id: row.ownerUserId,
    seller_message_id: row.sellerMessageId, sent_at: row.sentAt, identified_by: row.identifiedBy, evidence: row.evidence,
  }, { onConflict: "seller_message_id", ignoreDuplicates: true }).select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Propostas ainda acompanhadas (sem resultado do negócio) desde sinceIso, com o contato da conversa. */
export async function listTrackedProposalFollowups(db: SupabaseClient, organizationId: string, sinceIso: string) {
  const rows = await fetchAllPages<any>(async (from, to) => {
    const { data, error } = await db.from("proposal_followups")
      .select("id, conversation_id, opportunity_id, owner_user_id, seller_message_id, sent_at, reminder_task_id, first_seller_followup_at, first_customer_reply_at, outcome, conversations!inner(contact_id)")
      .eq("organization_id", organizationId).is("outcome", null).gte("sent_at", sinceIso).order("sent_at").order("id").range(from, to);
    if (error) throw error;
    return (data ?? []) as any[];
  });
  return rows.map((r) => ({
    id: r.id, conversationId: r.conversation_id, contactId: first<{ contact_id: string }>(r.conversations)?.contact_id ?? "", opportunityId: r.opportunity_id,
    ownerUserId: r.owner_user_id, sellerMessageId: r.seller_message_id, sentAt: r.sent_at, reminderTaskId: r.reminder_task_id,
    firstSellerFollowupAt: r.first_seller_followup_at, firstCustomerReplyAt: r.first_customer_reply_at, outcome: r.outcome,
  }));
}

export async function updateProposalFollowup(db: SupabaseClient, organizationId: string, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("proposal_followups").update(patch).eq("organization_id", organizationId).eq("id", id);
  if (error) throw error;
}

export async function insertSellerCommitment(db: SupabaseClient, row: {
  organizationId: string; conversationId: string; contactId: string; opportunityId: string | null; ownerUserId: string | null; sellerMessageId: string;
  sentAt: string; dueAt: string; kind: string; phrase: string;
}): Promise<string | null> {
  const { data, error } = await db.from("seller_commitments").upsert({
    organization_id: row.organizationId, conversation_id: row.conversationId, contact_id: row.contactId, opportunity_id: row.opportunityId,
    owner_user_id: row.ownerUserId, seller_message_id: row.sellerMessageId, sent_at: row.sentAt, due_at: row.dueAt, kind: row.kind, phrase: row.phrase.slice(0, 200),
  }, { onConflict: "seller_message_id", ignoreDuplicates: true }).select("id");
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
}

export async function supersedeSellerCommitments(db: SupabaseClient, organizationId: string, conversationId: string, keepId: string, atIso: string): Promise<void> {
  const { error } = await db.from("seller_commitments").update({ resolved_at: atIso, resolution: "superseded" })
    .eq("organization_id", organizationId).eq("conversation_id", conversationId).neq("id", keepId).is("resolved_at", null);
  if (error) throw error;
}

export async function listOpenSellerCommitments(db: SupabaseClient, organizationId: string) {
  const rows = await fetchAllPages<any>(async (from, to) => {
    const { data, error } = await db.from("seller_commitments")
      .select("id, conversation_id, contact_id, opportunity_id, owner_user_id, seller_message_id, sent_at, due_at, task_id, resolved_at")
      .eq("organization_id", organizationId).is("resolved_at", null).order("due_at").order("id").range(from, to);
    if (error) throw error;
    return (data ?? []) as any[];
  });
  return rows.map((r) => ({
    id: r.id, conversationId: r.conversation_id, contactId: r.contact_id, opportunityId: r.opportunity_id, ownerUserId: r.owner_user_id,
    sellerMessageId: r.seller_message_id, sentAt: r.sent_at, dueAt: r.due_at, taskId: r.task_id, resolvedAt: r.resolved_at,
  }));
}

export async function updateSellerCommitment(db: SupabaseClient, organizationId: string, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("seller_commitments").update(patch).eq("organization_id", organizationId).eq("id", id);
  if (error) throw error;
}

/** Tarefa interna do compromisso (dedupe e consolidação de sempre). Criada como sistema ("ai"), atribuída ao vendedor. */
export async function createCommitmentTask(db: SupabaseClient, i: {
  organizationId: string; contactId: string; conversationId: string; opportunityId: string | null; ownerId: string; type: "proposal_followup" | "return_customer";
  description: string; reason: string; priority: "normal" | "high"; dueDate: string; dueTime: string | null;
}): Promise<{ id: string }> {
  const { task } = await createTaskWithDedup(db, {
    organization_id: i.organizationId, contact_id: i.contactId, conversation_id: i.conversationId, opportunity_id: i.opportunityId,
    type: i.type, description: i.description, reason: i.reason, priority: i.priority, due_date: i.dueDate, due_time: i.dueTime,
    created_by_type: "ai", created_by_id: null, assignee_type: "human", assignee_id: i.ownerId, assign_on_merge: true,
  } as Parameters<typeof createTaskWithDedup>[1]);
  return { id: task.id };
}

export async function taskHasOpenPendency(db: SupabaseClient, organizationId: string, taskId: string, type: string): Promise<boolean> {
  let task: Awaited<ReturnType<typeof getTaskById>>;
  try { task = await getTaskById(db, taskId); } catch { return false; }
  if (!task || task.organization_id !== organizationId || !OPEN_TASK_STATUSES.includes(task.status)) return false;
  const pendencies = task.consolidated_pendencies ?? [];
  return pendencies.length ? pendencies.some((p) => p.type === type) : task.type === type;
}

export async function resolveCommitmentPendency(db: SupabaseClient, organizationId: string, taskId: string, type: string, note: string): Promise<void> {
  await resolveAwaitingCustomerPendency(db, organizationId, taskId, type as Parameters<typeof resolveAwaitingCustomerPendency>[3], note);
}
