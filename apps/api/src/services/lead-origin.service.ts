import type { SupabaseClient } from "@aula-agente/database";
import type { IdentifiedLeadOrigin } from "@aula-agente/shared";

// Compare-and-set preserves concurrent metadata edits and the first identified origin.
export async function recordLeadOrigin(db: SupabaseClient, organizationId: string, contactId: string, origin: IdentifiedLeadOrigin | null): Promise<void> {
  if (!origin) return;
  const { data, error } = await db.from("wa_contacts").select("metadata").eq("organization_id", organizationId).eq("id", contactId).single();
  if (error) throw error;
  if (!data || data.metadata?.lead_origin) return;
  const metadata = data.metadata ?? {};
  const update = db.from("wa_contacts").update({ metadata: { ...metadata, lead_origin: { ...origin, identified_at: new Date().toISOString(), method: "automatic" } } }).eq("organization_id", organizationId).eq("id", contactId);
  const result = data.metadata === null ? await update.is("metadata", null) : await update.eq("metadata", JSON.stringify(metadata));
  if (result.error) throw result.error;
}
