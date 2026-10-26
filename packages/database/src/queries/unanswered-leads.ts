import type { SupabaseClient } from "@supabase/supabase-js";

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
  contactId: string;
  contactName: string | null;
  contactPhone: string;
  aiDisabled: boolean;
}

/** Organizações com unanswered_lead_sweep_enabled === true (somente elas são varridas). */
export async function listUnansweredSweepOrganizations(db: SupabaseClient): Promise<SweepOrganization[]> {
  const { data, error } = await db.from("organizations").select("id, settings").eq("settings->>unanswered_lead_sweep_enabled", "true");
  if (error) throw error;
  return (data ?? []) as SweepOrganization[];
}

const ONE = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/**
 * Última mensagem do cliente (role "contact") de cada conversa da organização desde `since`.
 * Quem decide se está sem resposta é a função pura; aqui só se carrega o necessário (sem limite superior de idade,
 * para que uma mensagem recente e ainda em agrupamento não faça uma mais antiga parecer a última).
 */
export async function listLatestInboundMessages(db: SupabaseClient, organizationId: string, since: Date, limit = 2000): Promise<UnansweredCandidate[]> {
  const { data, error } = await db
    .from("messages")
    .select("id, conversation_id, content, media_type, created_at, conversations!inner(id, evolution_instance_id, is_human_takeover, contact_id, wa_contacts!inner(id, name, phone, ai_disabled))")
    .eq("organization_id", organizationId)
    .eq("role", "contact")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const seen = new Set<string>();
  const out: UnansweredCandidate[] = [];
  for (const row of (data ?? []) as any[]) {
    if (seen.has(row.conversation_id)) continue; // ordenado do mais novo para o mais antigo
    seen.add(row.conversation_id);
    const conv = ONE<any>(row.conversations);
    const contact = ONE<any>(conv?.wa_contacts);
    if (!conv || !contact) continue;
    out.push({
      messageId: row.id, conversationId: row.conversation_id, organizationId,
      evolutionInstanceId: conv.evolution_instance_id, content: row.content ?? "", mediaType: row.media_type ?? null,
      createdAt: row.created_at, isHumanTakeover: conv.is_human_takeover === true,
      contactId: contact.id, contactName: contact.name ?? null, contactPhone: contact.phone, aiDisabled: contact.ai_disabled === true,
    });
  }
  return out;
}

/** Existe resposta nossa (IA, humano ou sistema) na conversa depois do instante informado? */
export async function hasOutboundMessageAfter(db: SupabaseClient, conversationId: string, afterIso: string): Promise<boolean> {
  const { count, error } = await db.from("messages").select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId).in("role", ["agent", "human_agent", "system"]).gt("created_at", afterIso);
  if (error) throw error;
  return (count ?? 0) > 0;
}
