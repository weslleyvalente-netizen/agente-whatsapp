import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "@aula-agente/shared";

export async function getMessagesByConversation(
  client: SupabaseClient,
  conversationId: string,
  limit = 50
) {
  const { data, error } = await client
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data as Message[];
}

export async function getRecentMessages(
  client: SupabaseClient,
  conversationId: string,
  limit = 20
) {
  const { data, error } = await client
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as Message[]).reverse();
}

export async function createMessage(
  client: SupabaseClient,
  message: Omit<Message, "id" | "created_at">
) {
  const { data, error } = await client
    .from("messages")
    .insert(message)
    .select()
    .single();
  if (error) throw error;
  return data as Message;
}

export async function updateMessageContent(client: SupabaseClient, id: string, content: string) {
  const { error } = await client.from("messages").update({ content }).eq("id", id);
  if (error) throw error;
}

export async function messageExistsByEvolutionId(
  client: SupabaseClient,
  evolutionMessageId: string
) {
  const { data, error } = await client
    .from("messages")
    .select("id")
    .eq("evolution_message_id", evolutionMessageId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

export async function getAgentMessagesForCost(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("messages")
    .select("created_at, metadata")
    .eq("organization_id", organizationId)
    .eq("role", "agent")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as Pick<Message, "created_at" | "metadata">[];
}

export async function getMessagesForDashboard(
  client: SupabaseClient,
  organizationId: string,
  sinceISO: string
) {
  const { data, error } = await client
    .from("messages")
    .select("conversation_id, role, created_at")
    .eq("organization_id", organizationId)
    .gte("created_at", sinceISO)
    .order("conversation_id", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as Array<{ conversation_id: string; role: string; created_at: string }>;
}

// Scoped narrowly for the Trainer's "Analisar conversas reais" flow: only
// role/content/created_at, never wa_contacts.name/phone or conversation_notes,
// and bounded by both a conversation count and a time window.
export async function getRecentMessagesForOrganization(
  client: SupabaseClient,
  organizationId: string,
  params: { conversationLimit: number; sinceISO: string }
): Promise<Array<{ conversation_id: string; role: string; content: string; created_at: string }>> {
  const { data: conversationRows, error: convError } = await client
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .order("last_message_at", { ascending: false })
    .limit(params.conversationLimit);
  if (convError) throw convError;

  const conversationIds = (conversationRows as Array<{ id: string }>).map((c) => c.id);
  if (conversationIds.length === 0) return [];

  const { data, error } = await client
    .from("messages")
    .select("conversation_id, role, content, created_at")
    .in("conversation_id", conversationIds)
    .gte("created_at", params.sinceISO)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as Array<{ conversation_id: string; role: string; content: string; created_at: string }>;
}
