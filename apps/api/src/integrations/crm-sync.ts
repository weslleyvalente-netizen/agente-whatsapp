import { getAdminClient } from "@aula-agente/database";

interface ContactForCrmSync {
  id: string;
  organization_id: string;
  phone: string;
  name: string | null;
}

export async function syncContactToCrm(contact: ContactForCrmSync): Promise<void> {
  const syncOrgId = process.env.CRM_SYNC_ORGANIZATION_ID;
  if (!syncOrgId || contact.organization_id !== syncOrgId) {
    return;
  }

  try {
    const db = getAdminClient();

    const { data: existing, error: findError } = await db
      .from("contacts")
      .select("id")
      .eq("phone", contact.phone)
      .maybeSingle();

    if (findError) throw findError;

    let crmContactId: string;

    if (existing) {
      crmContactId = existing.id as string;
    } else {
      const { data: created, error: insertError } = await db
        .from("contacts")
        .insert({ name: contact.name, phone: contact.phone })
        .select("id")
        .single();

      if (insertError) throw insertError;
      crmContactId = (created as { id: string }).id;
    }

    const { error: activityError } = await db.from("activities").insert({
      contact_id: crmContactId,
      title: "Novo contato via WhatsApp",
      done: false,
    });

    if (activityError) throw activityError;
  } catch (err) {
    console.error("[crm-sync] failed to sync contact to CRM:", err);
  }
}
