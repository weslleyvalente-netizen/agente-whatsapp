import type { SupabaseClient } from "@supabase/supabase-js";
import type { Opportunity, OpportunityEvent, WaitingOn } from "@aula-agente/shared";

export async function createOpportunity(
  client: SupabaseClient,
  opportunity: Omit<Opportunity, "id" | "created_at" | "updated_at"> & { created_at?: string }
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
  // Embeds the contact's name/phone so the Kanban card can identify the
  // deal without a second round-trip — the board is unusable without it,
  // since most opportunities won't have product_model set.
  let query = client
    .from("opportunities")
    .select("*, wa_contacts(name, phone)")
    .eq("organization_id", organizationId);
  if (filters.operation) query = query.eq("operation", filters.operation);
  if (filters.status) query = query.eq("status", filters.status);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return data as (Opportunity & { wa_contacts: { name: string | null; phone: string } | null })[];
}

// Used by stale-conversation-followup.ts to decide whether an automatic
// nudge should actually message the customer (see decideFollowupGate in
// @aula-agente/shared) — the caller only acts on this when it returns
// exactly one row; several open opportunities for the same contact means
// which one applies to a given conversation is ambiguous, so the caller
// falls back to today's behavior rather than guessing.
export async function getOpenOpportunitiesByContact(
  client: SupabaseClient,
  organizationId: string,
  contactId: string
) {
  const { data, error } = await client
    .from("opportunities")
    .select("id, waiting_on, waiting_on_until, frozen_until")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("status", "open");
  if (error) throw error;
  return data as Array<{ id: string; waiting_on: string | null; waiting_on_until: string | null; frozen_until: string | null }>;
}

// Fase 2, item 5: candidates for the LiberaCred resumption cadence — open
// opportunities stuck at the exact stage the diagnosis flagged as the
// biggest, cheapest-to-unblock bottleneck (137 stalled at the time of
// docs/diagnostico-fase0.md).
export interface LiberaCredPlanPresentedOpportunity {
  id: string;
  contact_id: string;
  credit_amount: number | null;
  sale_amount: number | null;
  bid_amount: number | null;
  waiting_on: WaitingOn | null;
  waiting_on_until: string | null;
  last_progress_at: string | null;
  last_interaction_at: string | null;
  created_at: string;
}

export async function getOpenLiberaCredPlanPresentedOpportunities(
  client: SupabaseClient,
  organizationId: string
): Promise<LiberaCredPlanPresentedOpportunity[]> {
  const { data, error } = await client
    .from("opportunities")
    .select(
      "id, contact_id, credit_amount, sale_amount, bid_amount, waiting_on, waiting_on_until, last_progress_at, last_interaction_at, created_at"
    )
    .eq("organization_id", organizationId)
    .eq("operation", "libera_cred")
    .eq("stage", "plan_term_presented")
    .eq("status", "open");
  if (error) throw error;
  return data as LiberaCredPlanPresentedOpportunity[];
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
