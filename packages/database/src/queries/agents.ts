import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent } from "@aula-agente/shared";

export async function getAgentsByOrganization(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("agents")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as Agent[];
}

export async function getAgentById(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("agents")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as Agent;
}

export async function createAgent(
  client: SupabaseClient,
  agent: Omit<Agent, "id" | "created_at" | "updated_at">
) {
  const { data, error } = await client
    .from("agents")
    .insert(agent)
    .select()
    .single();
  if (error) throw error;
  return data as Agent;
}

export async function updateAgent(client: SupabaseClient, id: string, updates: Partial<Agent>) {
  const { data, error } = await client
    .from("agents")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as Agent;
}

export async function deleteAgent(client: SupabaseClient, id: string) {
  const { error } = await client.from("agents").delete().eq("id", id);
  if (error) throw error;
}
