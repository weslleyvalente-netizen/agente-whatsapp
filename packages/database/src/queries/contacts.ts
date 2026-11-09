import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "@aula-agente/shared";
import { brazilPhoneVariants } from "@aula-agente/shared";

export async function upsertContact(
  client: SupabaseClient,
  organizationId: string,
  phone: string,
  name: string | null,
  photoUrl: string | null
) {
  // The same real phone can be written with or without the Brazilian
  // mobile "9th digit" depending on the source (a customer typing their
  // own number vs. WhatsApp's registered JID) — check every variant so we
  // reuse the existing contact instead of creating a duplicate that's
  // missing all prior conversation history.
  const { data: existing } = await client
    .from("wa_contacts")
    .select("phone, name")
    .eq("organization_id", organizationId)
    .in("phone", brazilPhoneVariants(phone))
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // A webhook delivery without a pushName must not blank out a name we
  // already have on file for this contact.
  const resolvedPhone = existing?.phone ?? phone;

  const { data, error } = await client
    .from("wa_contacts")
    .upsert(
      {
        organization_id: organizationId,
        phone: resolvedPhone,
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

/**
 * Marca a tentativa de buscar a foto (profile_picture_checked_at = agora), mesmo sem foto, para o
 * webhook não reenfileirar a cada mensagem. Só troca profile_picture_path quando há caminho novo.
 */
export async function setContactProfilePicture(
  client: SupabaseClient,
  contactId: string,
  path: string | null
): Promise<void> {
  const update: { profile_picture_checked_at: string; profile_picture_path?: string } = {
    profile_picture_checked_at: new Date().toISOString(),
  };
  if (path !== null) update.profile_picture_path = path;
  const { error } = await client.from("wa_contacts").update(update).eq("id", contactId);
  if (error) throw error;
}
