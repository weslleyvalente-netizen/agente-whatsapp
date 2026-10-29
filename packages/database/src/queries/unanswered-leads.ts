import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages } from "../pagination.js";

export interface SweepOrganization { id: string; settings: Record<string, unknown> }

export interface UnansweredCandidate {
  messageId: string;
  conversationId: string;
  organizationId: string;
  evolutionInstanceId: string;
  content: string;
  mediaType: string | null;
  createdAt: string;
  isHumanTakeover: boolean;
  /** conversations.assigned_to: vendedor dono da conversa (quem recebe o aviso por push). */
  assignedTo: string | null;
  contactId: string;
  contactName: string | null;
  contactPhone: string;
  aiDisabled: boolean;
  /** metadata.ai_routed_at: o webhook encaminhou esta mensagem à IA. */
  aiRoutedAt: string | null;
  /** metadata.ai_processed_at: o pipeline da IA terminou de tratar esta mensagem (com ou sem resposta). */
  aiProcessedAt: string | null;
}

/** Organizações com unanswered_lead_sweep_enabled === true (somente elas são varridas). */
export async function listUnansweredSweepOrganizations(db: SupabaseClient): Promise<SweepOrganization[]> {
  const { data, error } = await db.from("organizations").select("id, settings").eq("settings->>unanswered_lead_sweep_enabled", "true");
  if (error) throw error;
  return (data ?? []) as SweepOrganization[];
}

const ONE = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

const SELECT = "id, conversation_id, content, media_type, created_at, metadata, conversations!inner(id, evolution_instance_id, is_human_takeover, assigned_to, contact_id, wa_contacts!inner(id, name, phone, ai_disabled))";

function toCandidate(row: any, organizationId: string): UnansweredCandidate | null {
  const conv = ONE<any>(row.conversations);
  const contact = ONE<any>(conv?.wa_contacts);
  if (!conv || !contact) return null;
  return {
    messageId: row.id, conversationId: row.conversation_id, organizationId,
    evolutionInstanceId: conv.evolution_instance_id, content: row.content ?? "", mediaType: row.media_type ?? null,
    createdAt: row.created_at, isHumanTakeover: conv.is_human_takeover === true, assignedTo: conv.assigned_to ?? null,
    contactId: contact.id, contactName: contact.name ?? null, contactPhone: contact.phone, aiDisabled: contact.ai_disabled === true,
    aiRoutedAt: row.metadata?.ai_routed_at ?? null, aiProcessedAt: row.metadata?.ai_processed_at ?? null,
  };
}

/**
 * Última mensagem do cliente (role "contact") de cada conversa da organização desde `since`, paginada
 * (o PostgREST corta cada resposta em 1000 linhas). Quem decide se está sem resposta é a função pura.
 */
export async function listLatestInboundMessages(db: SupabaseClient, organizationId: string, since: Date): Promise<UnansweredCandidate[]> {
  const rows = await fetchAllPages<any>(async (from, to) => {
    const { data, error } = await db.from("messages").select(SELECT)
      .eq("organization_id", organizationId).eq("role", "contact").gte("created_at", since.toISOString())
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
    if (error) throw error;
    return (data ?? []) as any[];
  });
  const seen = new Set<string>();
  const out: UnansweredCandidate[] = [];
  for (const row of rows) {
    if (seen.has(row.conversation_id)) continue; // ordenado do mais novo para o mais antigo
    seen.add(row.conversation_id);
    const c = toCandidate(row, organizationId);
    if (c) out.push(c);
  }
  return out;
}

/** Mensagens encaminhadas à IA e nunca processadas, entre `from` e `to` (usado só para contar as muito antigas). */
export async function listStaleUnprocessedRouted(db: SupabaseClient, organizationId: string, from: Date, to: Date): Promise<UnansweredCandidate[]> {
  const rows = await fetchAllPages<any>(async (a, b) => {
    const { data, error } = await db.from("messages").select(SELECT)
      .eq("organization_id", organizationId).eq("role", "contact")
      .gte("created_at", from.toISOString()).lt("created_at", to.toISOString())
      .not("metadata->>ai_routed_at", "is", null).is("metadata->>ai_processed_at", null)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(a, b);
    if (error) throw error;
    return (data ?? []) as any[];
  });
  return rows.map((r) => toCandidate(r, organizationId)).filter((c): c is UnansweredCandidate => !!c);
}

/** Existe resposta nossa (IA, humano ou sistema) na conversa depois do instante informado? */
export async function hasOutboundMessageAfter(db: SupabaseClient, conversationId: string, afterIso: string): Promise<boolean> {
  const { count, error } = await db.from("messages").select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId).in("role", ["agent", "human_agent", "system"]).gt("created_at", afterIso);
  if (error) throw error;
  return (count ?? 0) > 0;
}

export interface AckContext {
  /** A mensagem imediatamente anterior da conversa também é do cliente (sem resposta nossa no meio). */
  earlierInboundUnanswered: boolean;
  /** A última mensagem nossa (agent/human_agent) antes dela termina em "?". */
  lastOutboundAsksQuestion: boolean;
}

/**
 * Contexto para decidir se um "ok"/"obrigado" é mesmo um encerramento: lê só as últimas mensagens da conversa antes de
 * `beforeIso` (a mensagem do cliente em análise). Chamada só para mensagens que já casam com o filtro de encerramento.
 */
export async function getAckContext(db: SupabaseClient, conversationId: string, beforeIso: string): Promise<AckContext> {
  const { data, error } = await db.from("messages").select("role, content")
    .eq("conversation_id", conversationId).lt("created_at", beforeIso).order("created_at", { ascending: false }).limit(10);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ role: string; content: string | null }>;
  const lastOut = rows.find((r) => r.role === "agent" || r.role === "human_agent");
  return { earlierInboundUnanswered: rows[0]?.role === "contact", lastOutboundAsksQuestion: !!lastOut && (lastOut.content ?? "").trim().endsWith("?") };
}

/** Mescla `patch` em messages.metadata. */
export async function stampMessageMetadata(db: SupabaseClient, messageId: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await db.from("messages").select("metadata").eq("id", messageId).single();
  if (error) throw error;
  const { error: upErr } = await db.from("messages").update({ metadata: { ...((data as any)?.metadata ?? {}), ...patch } }).eq("id", messageId);
  if (upErr) throw upErr;
}

/**
 * Marca ai_processed_at nas mensagens do cliente da conversa que o webhook encaminhou à IA (ai_routed_at) e ainda não
 * foram marcadas, criadas até `upTo` (o início da execução: o que chegou depois tem o próprio job).
 */
export async function markMessagesAiProcessed(db: SupabaseClient, conversationId: string, upTo: Date, processedAtIso: string): Promise<number> {
  const { data, error } = await db.from("messages").select("id, metadata")
    .eq("conversation_id", conversationId).eq("role", "contact").lte("created_at", upTo.toISOString())
    .not("metadata->>ai_routed_at", "is", null).is("metadata->>ai_processed_at", null);
  if (error) throw error;
  let n = 0;
  for (const row of (data ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
    const { error: upErr } = await db.from("messages").update({ metadata: { ...(row.metadata ?? {}), ai_processed_at: processedAtIso } }).eq("id", row.id);
    if (upErr) throw upErr;
    n++;
  }
  return n;
}
