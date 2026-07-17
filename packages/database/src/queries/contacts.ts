import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "@aula-agente/shared";

export async function upsertContact(
  client: SupabaseClient,
  organizationId: string,
  phone: string,
  name: string | null,
  photoUrl: string | null
) {
  const { data, error } = await client
    .from("wa_contacts")
    .upsert(
      {
        organization_id: organizationId,
        phone,
        name,
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
