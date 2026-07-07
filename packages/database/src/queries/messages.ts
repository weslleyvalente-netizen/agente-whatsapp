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
