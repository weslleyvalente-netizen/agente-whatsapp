import type { SupabaseClient } from "@supabase/supabase-js";
import type { Opportunity, OpportunityEvent } from "@aula-agente/shared";

export async function createOpportunity(
  client: SupabaseClient,
  opportunity: Omit<Opportunity, "id" | "created_at" | "updated_at">
) {
  const { data, error } = await client.from("opportunities").insert(opportunity).select().single();
  if (error) throw error;
  return data as Opportunity;
}

export async function updateOpportunity(client: SupabaseClient, id: string, updates: Partial<Opportunity>) {
  const { data, error } = await client.from("opportunities").update(updates).eq("id", id).select().single();
  if (error) throw error;
  return data as Opportunity;
}

export async function getOpportunityById(client: SupabaseClient, id: string) {
  const { data, error } = await client.from("opportunities").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Opportunity;
}

export async function getOpportunitiesByOrganization(
  client: SupabaseClient,
  organizationId: string,
  filters: { operation?: string; status?: string } = {}
) {
  let query = client.from("opportunities").select("*").eq("organization_id", organizationId);
  if (filters.operation) query = query.eq("operation", filters.operation);
  if (filters.status) query = query.eq("status", filters.status);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return data as Opportunity[];
}

export async function addOpportunityEvent(
  client: SupabaseClient,
  event: Omit<OpportunityEvent, "id" | "created_at">
) {
  const { data, error } = await client.from("opportunity_events").insert(event).select().single();
  if (error) throw error;
  return data as OpportunityEvent;
}

export async function getOpportunityEvents(client: SupabaseClient, opportunityId: string) {
  const { data, error } = await client
    .from("opportunity_events")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as OpportunityEvent[];
}
