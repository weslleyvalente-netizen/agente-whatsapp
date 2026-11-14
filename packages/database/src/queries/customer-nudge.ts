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

export interface NudgeTaskRef { id: string; status: string; createdAt: string; completedAt: string | null }

const OPEN_STATUSES = ["pending", "in_progress", "rescheduled"];
export const NUDGE_TOUCH_EVENT = "customer_nudge_touch";
/** Marca gravada na nota do evento de toque: liga o toque à CONVERSA (a tarefa consolidada pode ser de outra conversa do negócio). */
export const nudgeTouchNote = (conversationId: string, touch: number) => `Cutucar cliente — toque ${touch} de 3 (nudge-conv:${conversationId})`;

/** Instante em que a pendência "customer_nudge" entrou na tarefa; sem lista consolidada, a própria criação da tarefa (tarefa legada do tipo). */
function nudgeAddedAt(task: { type: string; created_at: string; consolidated_pendencies?: Array<{ type: string; added_at: string }> | null }): string | null {
  const own = (task.consolidated_pendencies ?? []).find((p) => p.type === "customer_nudge");
  if (own) return own.added_at;
  return task.type === "customer_nudge" ? task.created_at : null;
}

/**
 * Toques já feitos na conversa (cada item = um toque), em DUAS fontes, sem contar duas vezes:
 * 1) eventos `customer_nudge_touch` — sobrevivem à pendência ser removida da tarefa consolidada;
 * 2) tarefas legadas do tipo customer_nudge criadas antes dos eventos existirem (sem evento próprio).
 */
export async function listNudgeTasksByConversation(db: SupabaseClient, organizationId: string, conversationId: string): Promise<NudgeTaskRef[]> {
  const { data: tasks, error } = await db.from("tasks").select("id, status, created_at, completed_at")
    .eq("organization_id", organizationId).eq("conversation_id", conversationId).eq("type", "customer_nudge");
  if (error) throw error;
  const { data: events, error: evErr } = await db.from("task_events").select("task_id, created_at")
    .eq("organization_id", organizationId).eq("event_type", NUDGE_TOUCH_EVENT).like("note", `%nudge-conv:${conversationId}%`);
  if (evErr) throw evErr;
  const evRows = (events ?? []) as Array<{ task_id: string; created_at: string }>;
  const withEvent = new Set(evRows.map((e) => e.task_id));
  const legacy = ((tasks ?? []) as any[]).filter((r) => !withEvent.has(r.id))
    .map((r): NudgeTaskRef => ({ id: r.id, status: r.status, createdAt: r.created_at, completedAt: r.completed_at ?? null }));
  // Evento de tarefa que ainda é do tipo customer_nudge: herda status/conclusão dela (o intervalo entre toques e o "aberto" seguem como antes).
  const typedById = new Map(((tasks ?? []) as any[]).map((r) => [r.id, r]));
  const fromEvents = evRows.map((e, i): NudgeTaskRef => {
    const own = typedById.get(e.task_id);
    return { id: `${e.task_id}#${i}`, status: own?.status ?? "completed", createdAt: e.created_at, completedAt: own?.completed_at ?? null };
  });
  return [...legacy, ...fromEvents];
}

/** Registra o toque na tarefa que o carrega (nova ou consolidada). Fonte da contagem de toques; não depende da pendência continuar na lista. */
export async function recordNudgeTouch(db: SupabaseClient, organizationId: string, taskId: string, conversationId: string, touch: number): Promise<void> {
  const { error } = await db.from("task_events").insert({
    task_id: taskId, organization_id: organizationId, event_type: NUDGE_TOUCH_EVENT, note: nudgeTouchNote(conversationId, touch), created_by_type: "ai", created_by_id: null,
  });
  if (error) throw error;
}

export interface OpenNudgeTask { id: string; conversationId: string | null; contactId: string; opportunityId: string | null; createdAt: string }

/**
 * Tarefas abertas que carregam um "Cutucar cliente": do tipo customer_nudge OU com a pendência dentro da lista consolidada
 * (com a consolidação ligada o tipo da tarefa vira o da pendência principal). `createdAt` = quando a PENDÊNCIA entrou.
 */
export async function listOpenNudgeTasks(db: SupabaseClient, organizationId: string): Promise<OpenNudgeTask[]> {
  const select = "id, type, conversation_id, contact_id, opportunity_id, created_at, consolidated_pendencies";
  const typed = await fetchAllPages<any>(async (from, to) => {
    const { data, error } = await db.from("tasks").select(select)
      .eq("organization_id", organizationId).eq("type", "customer_nudge").in("status", OPEN_STATUSES).order("id").range(from, to);
    if (error) throw error;
    return (data ?? []) as any[];
  });
  const grouped = await fetchAllPages<any>(async (from, to) => {
    const { data, error } = await db.from("tasks").select(select)
      .eq("organization_id", organizationId).filter("consolidated_pendencies", "cs", JSON.stringify([{ type: "customer_nudge" }])).in("status", OPEN_STATUSES).order("id").range(from, to);
    if (error) throw error;
    return (data ?? []) as any[];
  });
  const byId = new Map<string, any>();
  for (const r of [...typed, ...grouped]) byId.set(r.id, r);
  return [...byId.values()].map((r) => ({
    id: r.id, conversationId: r.conversation_id ?? null, contactId: r.contact_id, opportunityId: r.opportunity_id ?? null, createdAt: nudgeAddedAt(r) ?? r.created_at,
  }));
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

/**
 * O vendedor acabou de falar com o cliente: encerra na hora APENAS a pendência "Cutucar cliente" desta conversa
 * (as demais obrigações da tarefa consolidada continuam abertas). O worker faz o mesmo a cada 30 min, como rede de segurança.
 * Só encerra pendência criada ANTES da mensagem. Devolve quantas encerrou.
 */
export async function completeNudgeTasksOnSellerMessage(db: SupabaseClient, organizationId: string, conversationId: string, atIso: string): Promise<number> {
  const open = (await listOpenNudgeTasks(db, organizationId)).filter((t) => t.conversationId === conversationId && Date.parse(t.createdAt) < Date.parse(atIso));
  let done = 0;
  for (const t of open) {
    try {
      await resolveAwaitingCustomerPendency(db, organizationId, t.id, "customer_nudge", "Vendedor já cutucou o cliente (mensagem enviada depois da tarefa).", 0, atIso);
      done++;
    } catch (err) { console.error(`completeNudgeTasksOnSellerMessage: task ${t.id} failed:`, err); }
  }
  return done;
}
