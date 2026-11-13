import type { SupabaseClient } from "@aula-agente/database";
import { pickAttributedTouch, type AdOrigin, type AdTouchView } from "@aula-agente/shared";

export type { AdOrigin, AdTouchView };

const COLUMNS = "id, touched_at, platform, source_type, ad_id, ad_title, ad_body, ad_url, campaign_id, campaign_name, conversation_id";
const HISTORY_LIMIT = 50;

/**
 * Histórico de toques de anúncio do contato (mais recente primeiro) e, para uma oportunidade, qual deles a originou
 * (o mais recente até a criação dela; os demais ficam no histórico). Não devolve ctwa_clid nem a lista interna de campos.
 */
export async function getAdOriginForContact(
  db: SupabaseClient, organizationId: string, contactId: string, opportunityCreatedAt?: string
): Promise<AdOrigin> {
  const { data, error } = await db.from("lead_ad_touches").select(COLUMNS)
    .eq("organization_id", organizationId).eq("contact_id", contactId)
    .order("touched_at", { ascending: false }).limit(HISTORY_LIMIT);
  if (error) throw error;
  const touches = (data ?? []) as AdTouchView[];
  const attributed = opportunityCreatedAt ? pickAttributedTouch(touches, opportunityCreatedAt) : null;
  return { touches, attributed_touch_id: attributed?.id ?? null };
}
