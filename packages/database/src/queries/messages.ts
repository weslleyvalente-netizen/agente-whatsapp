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
