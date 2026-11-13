import type { SupabaseClient } from "@aula-agente/database";
import { attributeTouch, type AdOrigin, type AdTouchView } from "@aula-agente/shared";

export type { AdOrigin, AdTouchView };

const COLUMNS = "id, touched_at, platform, source_type, ad_id, ad_title, ad_body, ad_url, campaign_id, campaign_name, conversation_id";
const RECENT_LIMIT = 50;
const CLOCK_TOLERANCE_MS = 60_000;

type Db = SupabaseClient;
const base = (db: Db, organizationId: string, contactId: string, columns = COLUMNS, opts?: { count?: "exact"; head?: boolean }) =>
  db.from("lead_ad_touches").select(columns, opts as never).eq("organization_id", organizationId).eq("contact_id", contactId);

async function rows(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<AdTouchView[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AdTouchView[];
}

export interface OpportunityContext { createdAt: string; conversationIds?: string[] }

/**
 * Origem por anúncio de um contato. A lista traz os 50 toques mais recentes MAIS o primeiro toque (o mais antigo, consultado à
 * parte: nunca deduzido pela posição) e, para uma oportunidade, o toque atribuído (buscado por consulta própria, sem depender
 * dos 50 mais recentes). Atribuição só com evidência (attributeTouch): ligado à conversa do negócio, senão dentro de 14 dias
 * antes da criação, senão indeterminada. Não devolve ctwa_clid nem a lista interna de campos.
 */
export async function getAdOriginForContact(
  db: Db, organizationId: string, contactId: string, opportunity?: OpportunityContext
): Promise<AdOrigin> {
  const conversationIds = (opportunity?.conversationIds ?? []).filter(Boolean);
  const until = opportunity ? new Date(Date.parse(opportunity.createdAt) + CLOCK_TOLERANCE_MS).toISOString() : null;
  const untilValid = until && Number.isFinite(Date.parse(until));

  const [recent, earliest, countResult, beforeOpportunity, linked] = await Promise.all([
    rows(base(db, organizationId, contactId).order("touched_at", { ascending: false }).limit(RECENT_LIMIT)),
    rows(base(db, organizationId, contactId).order("touched_at", { ascending: true }).limit(1)),
    base(db, organizationId, contactId, "id", { count: "exact", head: true }) as unknown as PromiseLike<{ count: number | null; error: unknown }>,
    untilValid ? rows(base(db, organizationId, contactId).lte("touched_at", until!).order("touched_at", { ascending: false }).limit(RECENT_LIMIT)) : Promise.resolve([] as AdTouchView[]),
    untilValid && conversationIds.length
      ? rows(base(db, organizationId, contactId).in("conversation_id", conversationIds).lte("touched_at", until!).order("touched_at", { ascending: false }).limit(RECENT_LIMIT))
      : Promise.resolve([] as AdTouchView[]),
  ]);
  if (countResult.error) throw countResult.error;

  let attributed: AdTouchView | null = null;
  let attribution: AdOrigin["attribution"] = null;
  if (opportunity) {
    const result = attributeTouch(dedupe([...beforeOpportunity, ...linked]), { createdAt: opportunity.createdAt, conversationIds });
    attributed = result.touch;
    attribution = result.basis;
  }

  const touches = dedupe([...recent, ...earliest, ...(attributed ? [attributed] : [])])
    .sort((a, b) => Date.parse(b.touched_at) - Date.parse(a.touched_at));
  return {
    touches,
    total_touches: countResult.count ?? touches.length,
    first_touch_id: earliest[0]?.id ?? null,
    attributed_touch_id: attributed?.id ?? null,
    attribution,
  };
}

function dedupe(list: AdTouchView[]): AdTouchView[] {
  const seen = new Map<string, AdTouchView>();
  for (const t of list) if (!seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()];
}

const ASSIGNMENT_LIMIT = 100;

/**
 * Conversas vinculadas à oportunidade: as de lead_assignments (a MESMA relação usada pela view opportunity_ad_origins).
 * Nunca "a conversa mais recente do contato": ela pode ser outra.
 */
export async function getOpportunityConversationIds(db: Db, organizationId: string, opportunityId: string): Promise<string[]> {
  const { data, error } = await db.from("lead_assignments").select("conversation_id")
    .eq("organization_id", organizationId).eq("opportunity_id", opportunityId)
    .not("conversation_id", "is", null).limit(ASSIGNMENT_LIMIT);
  if (error) throw error;
  return [...new Set(((data ?? []) as Array<{ conversation_id: string | null }>).map((r) => r.conversation_id).filter((id): id is string => !!id))];
}

/** Origem por anúncio de uma oportunidade: vínculo comprovado pela conversa (lead_assignments), senão estimativa por janela de 14 dias, senão indeterminada. */
export async function getAdOriginForOpportunity(
  db: Db, opportunity: { id: string; organization_id: string; contact_id: string; created_at: string }
): Promise<AdOrigin> {
  const conversationIds = await getOpportunityConversationIds(db, opportunity.organization_id, opportunity.id);
  return getAdOriginForContact(db, opportunity.organization_id, opportunity.contact_id, { createdAt: opportunity.created_at, conversationIds });
}
