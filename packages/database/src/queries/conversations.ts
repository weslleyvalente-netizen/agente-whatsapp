import type { SupabaseClient } from "@supabase/supabase-js";
import type { Conversation, ConversationNote, ConversationMetrics, OrganizationSettings } from "@aula-agente/shared";
import { isHumanTakeoverExpired } from "@aula-agente/shared";

export async function getConversationsByOrganization(
  client: SupabaseClient,
  organizationId: string,
  status?: string
) {
  let query = client
    .from("conversations")
    .select("*, wa_contacts(*)")
    .eq("organization_id", organizationId)
    .order("last_message_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function getConversationStatusesByOrganization(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("conversations")
    .select("status")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return data as Array<{ status: string }>;
}

export async function getConversationById(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("conversations")
    .select("*, wa_contacts(*), agents(name)")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

export async function findOpenConversation(
  client: SupabaseClient,
  contactId: string,
  agentId: string
) {
  const { data, error } = await client
    .from("conversations")
    .select("*")
    .eq("contact_id", contactId)
    .eq("agent_id", agentId)
    .in("status", ["open", "waiting"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Conversation | null;
}

export async function createConversation(
  client: SupabaseClient,
  conversation: Omit<Conversation, "id" | "created_at" | "updated_at">
) {
  const { data, error } = await client
    .from("conversations")
    .insert(conversation)
    .select()
    .single();
  if (error) throw error;
  return data as Conversation;
}

export async function updateConversation(
  client: SupabaseClient,
  id: string,
  updates: Partial<Conversation>
) {
  const { data, error } = await client
    .from("conversations")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as Conversation;
}

// defaultTimeoutMs applies only to orgs that haven't configured their own
// human_takeover_timeout_minutes (see OrganizationSettings) — each org's
// setting is read here rather than filtered in SQL, since it can disable
// auto-resume entirely (null) or use a value the database can't compare
// against with a single fixed cutoff.
export async function getExpiredTakeovers(client: SupabaseClient, defaultTimeoutMs: number) {
  const { data, error } = await client
    .from("conversations")
    .select("*, organizations(settings)")
    .eq("is_human_takeover", true);
  if (error) throw error;

  const now = Date.now();
  const rows = data as unknown as Array<
    Conversation & { organizations: { settings: OrganizationSettings } | null }
  >;

  return rows
    .filter((row) =>
      isHumanTakeoverExpired(
        row.human_takeover_at,
        row.organizations?.settings?.human_takeover_timeout_minutes,
        defaultTimeoutMs,
        now
      )
    )
    .map(({ organizations: _organizations, ...conversation }) => conversation as Conversation);
}

export async function getStaleWaitingConversations(
  client: SupabaseClient,
  organizationId: string,
  agentId: string,
  cutoffISO: string
) {
  const { data, error } = await client
    .from("conversations")
    .select("id, contact_id, created_at, last_message_at")
    .eq("organization_id", organizationId)
    .eq("agent_id", agentId)
    .eq("status", "waiting")
    .eq("is_human_takeover", false)
    .lt("last_message_at", cutoffISO);
  if (error) throw error;
  return data as Array<{ id: string; contact_id: string; created_at: string; last_message_at: string }>;
}

export async function getHumanTakeoverConversations(client: SupabaseClient, organizationId: string) {
  const [takeoverResult, aiDisabledResult] = await Promise.all([
    client
      .from("conversations")
      .select("id, human_takeover_at, wa_contacts(name, phone)")
      .eq("organization_id", organizationId)
      .eq("is_human_takeover", true),
    client
      .from("conversations")
      .select("id, human_takeover_at, wa_contacts!inner(name, phone, ai_disabled)")
      .eq("organization_id", organizationId)
      .eq("wa_contacts.ai_disabled", true),
  ]);
  if (takeoverResult.error) throw takeoverResult.error;
  if (aiDisabledResult.error) throw aiDisabledResult.error;

  type Row = {
    id: string;
    human_takeover_at: string | null;
    wa_contacts: { name: string | null; phone: string } | null;
  };

  const byId = new Map<string, Row>();
  for (const row of [...(takeoverResult.data as unknown as Row[]), ...(aiDisabledResult.data as unknown as Row[])]) {
    byId.set(row.id, row);
  }

  return Array.from(byId.values()).sort((a, b) =>
    (a.human_takeover_at ?? "").localeCompare(b.human_takeover_at ?? "")
  );
}

export async function addConversationNote(
  client: SupabaseClient,
  note: Omit<ConversationNote, "id" | "created_at" | "updated_at">
) {
  const { data, error } = await client
    .from("conversation_notes")
    .insert(note)
    .select()
    .single();
  if (error) throw error;
  return data as ConversationNote;
}

export async function getConversationNotes(client: SupabaseClient, conversationId: string) {
  const { data, error } = await client
    .from("conversation_notes")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as ConversationNote[];
}
