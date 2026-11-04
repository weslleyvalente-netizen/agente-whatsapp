import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages } from "../pagination.js";
import { resolveAwaitingCustomerPendency } from "./tasks.js";

// Consultas da regra "Cutucar cliente" (apps/worker/src/workers/customer-nudge.ts). Tudo paginado (PostgREST corta em 1000 linhas)
// e com .in() em lotes pequenos (URL longa). A tabela messages nunca é lida inteira: só a última mensagem de cada conversa candidata.

export interface NudgeOrganization { id: string; settings: Record<string, unknown> }

/** Organizações com customer_nudge_enabled === true (somente elas são varridas). */
export async function listCustomerNudgeOrganizations(db: SupabaseClient): Promise<NudgeOrganization[]> {
  const { data, error } = await db.from("organizations").select("id, settings").eq("settings->>customer_nudge_enabled", "true");
  if (error) throw error;
  return (data ?? []) as NudgeOrganization[];
}

const BATCH = 100;
const chunk = <T>(list: T[], size = BATCH): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export interface NudgeOpportunity {
  id: string; contactId: string; ownerId: string | null; waitingOn: string | null; waitingOnUntil: string | null; lastInteractionAt: string | null;
}

/** Negócios abertos da organização (a regra só vale para contato com negócio aberto). */
export async function listOpenOpportunitiesForNudge(db: SupabaseClient, organizationId: string): Promise<NudgeOpportunity[]> {
  const rows = await fetchAllPages<any>(async (from, to) => {
    const { data, error } = await db.from("opportunities")
      .select("id, contact_id, owner_id, waiting_on, waiting_on_until, last_interaction_at")
      .eq("organization_id", organizationId).eq("status", "open").order("id").range(from, to);
    if (error) throw error;
    return (data ?? []) as any[];
  });
  return rows.map((r) => ({
    id: r.id, contactId: r.contact_id, ownerId: r.owner_id ?? null, waitingOn: r.waiting_on ?? null,
    waitingOnUntil: r.waiting_on_until ?? null, lastInteractionAt: r.last_interaction_at ?? null,
  }));
}

export interface NudgeConversation { id: string; contactId: string; assignedTo: string | null; lastMessageAt: string }

/** Conversas desses contatos com atividade desde `sinceIso` (a última mensagem de qualquer lado já está na janela). */
export async function listRecentConversationsForContacts(db: SupabaseClient, organizationId: string, contactIds: string[], sinceIso: string): Promise<NudgeConversation[]> {
  const out: NudgeConversation[] = [];
  for (const ids of chunk(contactIds)) {
    const rows = await fetchAllPages<any>(async (from, to) => {
      const { data, error } = await db.from("conversations").select("id, contact_id, assigned_to, last_message_at")
        .eq("organization_id", organizationId).in("contact_id", ids).gte("last_message_at", sinceIso).order("id").range(from, to);
      if (error) throw error;
      return (data ?? []) as any[];
    });
    for (const r of rows) out.push({ id: r.id, contactId: r.contact_id, assignedTo: r.assigned_to ?? null, lastMessageAt: r.last_message_at });
  }
  return out;
}

export interface NudgeMessage { id: string; role: string; mediaType: string | null; createdAt: string }

const toMessage = (r: any): NudgeMessage => ({ id: r.id, role: r.role, mediaType: r.media_type ?? null, createdAt: r.created_at });

/** Última mensagem da conversa, de qualquer papel (uma linha, só papel e data: o texto não é necessário aqui). */
export async function getLastConversationMessage(db: SupabaseClient, organizationId: string, conversationId: string): Promise<Pick<NudgeMessage, "role" | "createdAt"> | null> {
  const { data, error } = await db.from("messages").select("role, created_at")
    .eq("organization_id", organizationId).eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? { role: (data as any).role, createdAt: (data as any).created_at } : null;
}

/** Última mensagem do cliente (role contact), sem o texto: dá o corte dos toques. O texto vem de getMessageText só quando precisa. */
export async function getLastCustomerMessage(db: SupabaseClient, organizationId: string, conversationId: string): Promise<NudgeMessage | null> {
  const { data, error } = await db.from("messages").select("id, role, media_type, created_at")
    .eq("organization_id", organizationId).eq("conversation_id", conversationId).eq("role", "contact")
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? toMessage(data) : null;
}

/** Texto de uma mensagem (usado só no filtro de recusa, depois que a tarefa já sairia). */
export async function getMessageText(db: SupabaseClient, organizationId: string, messageId: string): Promise<string> {
  const { data, error } = await db.from("messages").select("content").eq("organization_id", organizationId).eq("id", messageId).maybeSingle();
  if (error) throw error;
  return ((data as { content: string | null } | null)?.content) ?? "";
}

export interface NudgeTaskRef { id: string; status: string; createdAt: string }

/** Todas as tarefas customer_nudge da conversa (abertas ou não): conta os toques e acha a aberta. */
export async function listNudgeTasksByConversation(db: SupabaseClient, organizationId: string, conversationId: string): Promise<NudgeTaskRef[]> {
  const { data, error } = await db.from("tasks").select("id, status, created_at")
    .eq("organization_id", organizationId).eq("conversation_id", conversationId).eq("type", "customer_nudge");
  if (error) throw error;
  return ((data ?? []) as any[]).map((r) => ({ id: r.id, status: r.status, createdAt: r.created_at }));
}

export interface OpenNudgeTask { id: string; conversationId: string | null; contactId: string; opportunityId: string | null; createdAt: string }

/** Tarefas customer_nudge abertas da organização (candidatas à resolução automática). */
export async function listOpenNudgeTasks(db: SupabaseClient, organizationId: string): Promise<OpenNudgeTask[]> {
  const rows = await fetchAllPages<any>(async (from, to) => {
    const { data, error } = await db.from("tasks").select("id, conversation_id, contact_id, opportunity_id, created_at")
      .eq("organization_id", organizationId).eq("type", "customer_nudge").in("status", ["pending", "in_progress", "rescheduled"]).order("id").range(from, to);
    if (error) throw error;
    return (data ?? []) as any[];
  });
  return rows.map((r) => ({ id: r.id, conversationId: r.conversation_id ?? null, contactId: r.contact_id, opportunityId: r.opportunity_id ?? null, createdAt: r.created_at }));
}

/** Dos ids de negócio informados, quais seguem abertos. */
export async function listOpenOpportunityIds(db: SupabaseClient, organizationId: string, opportunityIds: string[]): Promise<Set<string>> {
  const open = new Set<string>();
  for (const ids of chunk(opportunityIds)) {
    const { data, error } = await db.from("opportunities").select("id").eq("organization_id", organizationId).eq("status", "open").in("id", ids);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string }>) open.add(r.id);
  }
  return open;
}

/** Dos contatos informados, quais têm algum negócio aberto (tarefas antigas sem opportunity_id). */
export async function listContactIdsWithOpenOpportunity(db: SupabaseClient, organizationId: string, contactIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ids of chunk(contactIds)) {
    const { data, error } = await db.from("opportunities").select("contact_id").eq("organization_id", organizationId).eq("status", "open").in("contact_id", ids);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ contact_id: string }>) out.add(r.contact_id);
  }
  return out;
}

/** O vendedor (role human_agent; mensagem da IA não conta) já mandou mensagem na conversa depois do instante informado? */
export async function hasSellerMessageAfter(db: SupabaseClient, organizationId: string, conversationId: string, afterIso: string): Promise<boolean> {
  const { count, error } = await db.from("messages").select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId).eq("conversation_id", conversationId).eq("role", "human_agent").gt("created_at", afterIso);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Conclui uma tarefa customer_nudge com nota (também a retira de tarefa consolidada, preservando as outras pendências). */
export async function completeNudgeTask(db: SupabaseClient, organizationId: string, taskId: string, note: string): Promise<void> {
  await resolveAwaitingCustomerPendency(db, organizationId, taskId, "customer_nudge", note);
}
