import type { SupabaseClient } from "@supabase/supabase-js";
import { ignoredContactPhoneCandidates, type OrganizationIgnoredContact, type IgnoredContactRetentionMode } from "@aula-agente/shared";

// Called on every inbound webhook message before ensureConversation — must
// stay a single indexed lookup (idx_organization_ignored_contacts_org_phone).
// Compara o telefone com e sem o 9º dígito (celular brasileiro): a Evolution entrega alguns números sem o 9 e a lista pode ter o 9
// (ou o contrário). Só celulares brasileiros bem formados ganham a outra forma (ver ignoredContactPhoneCandidates); números
// diferentes nunca casam. Se houver mais de uma linha para o mesmo número, vale o modo mais restritivo (no_store) e, depois, o casamento exato.
export async function getIgnoredContact(client: SupabaseClient, organizationId: string, phone: string) {
  const candidates = ignoredContactPhoneCandidates(phone);
  if (candidates.length === 0) return null;
  const { data, error } = await client
    .from("organization_ignored_contacts")
    .select("*")
    .eq("organization_id", organizationId)
    .in("phone", candidates);
  if (error) throw error;
  const rows = (data ?? []) as OrganizationIgnoredContact[];
  if (rows.length <= 1) return rows[0] ?? null;
  return rows.find((r) => r.retention_mode === "no_store") ?? rows.find((r) => r.phone === phone) ?? rows[0];
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
