import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionInstance } from "@aula-agente/shared";

export async function getInstancesByOrganization(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("evolution_instances")
    .select("*, agents:active_agent_id(id, name)")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function getInstanceById(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("evolution_instances")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as EvolutionInstance;
}

export async function getInstanceByInstanceId(client: SupabaseClient, instanceId: string) {
  const { data, error } = await client
    .from("evolution_instances")
    .select("*")
    .eq("instance_id", instanceId)
    .single();
  if (error) throw error;
  return data as EvolutionInstance;
}

export async function createInstance(
  client: SupabaseClient,
  instance: Pick<EvolutionInstance, "organization_id" | "instance_name" | "instance_id" | "webhook_url">
) {
  const { data, error } = await client
    .from("evolution_instances")
    .insert({ ...instance, status: "disconnected" })
    .select()
    .single();
  if (error) throw error;
  return data as EvolutionInstance;
}

export async function updateInstance(
  client: SupabaseClient,
  id: string,
  updates: Partial<EvolutionInstance>
) {
  const { data, error } = await client
    .from("evolution_instances")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as EvolutionInstance;
}

export async function deleteInstance(client: SupabaseClient, id: string) {
  const { error } = await client.from("evolution_instances").delete().eq("id", id);
  if (error) throw error;
}
