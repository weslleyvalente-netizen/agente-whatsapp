import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrganizationIgnoredContact, IgnoredContactRetentionMode } from "@aula-agente/shared";

// Called on every inbound webhook message before ensureConversation — must
// stay a single indexed lookup (idx_organization_ignored_contacts_org_phone).
export async function getIgnoredContact(client: SupabaseClient, organizationId: string, phone: string) {
  const { data, error } = await client
    .from("organization_ignored_contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  return data as OrganizationIgnoredContact | null;
}

export async function listIgnoredContacts(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("organization_ignored_contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as OrganizationIgnoredContact[];
}

export async function createIgnoredContact(
  client: SupabaseClient,
  input: {
    organization_id: string;
    phone: string;
    label: string | null;
    retention_mode: IgnoredContactRetentionMode;
    created_by: string | null;
  }
) {
  const { data, error } = await client.from("organization_ignored_contacts").insert(input).select().single();
  if (error) throw error;
  return data as OrganizationIgnoredContact;
}

export async function deleteIgnoredContact(client: SupabaseClient, id: string) {
  const { error } = await client.from("organization_ignored_contacts").delete().eq("id", id);
  if (error) throw error;
}
