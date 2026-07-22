import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "@aula-agente/shared";

export async function upsertContact(
  client: SupabaseClient,
  organizationId: string,
  phone: string,
  name: string | null,
  photoUrl: string | null
) {
  // A webhook delivery without a pushName must not blank out a name we
  // already have on file for this contact.
  const { data: existing } = await client
    .from("wa_contacts")
    .select("name")
    .eq("organization_id", organizationId)
    .eq("phone", phone)
    .maybeSingle();

  const { data, error } = await client
    .from("wa_contacts")
    .upsert(
      {
        organization_id: organizationId,
        phone,
        name: name ?? existing?.name ?? null,
        photo_url: photoUrl,
      },
      { onConflict: "organization_id,phone" }
    )
    .select()
    .single();
  if (error) throw error;
  return data as Contact;
}

export async function getContactById(client: SupabaseClient, id: string) {
  const { data, error } = await client.from("wa_contacts").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Contact;
}
