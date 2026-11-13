// Toque de anúncio: o que o WhatsApp informa (externalAdReply) quando o cliente chega por um anúncio "Click to WhatsApp".
// Guarda só estados e identificadores do anúncio, nunca conteúdo de conversa. A CAMPANHA não vem do WhatsApp (só o id do
// anúncio, em sourceId); campaign_id/campaign_name ficam nulos até serem preenchidos por cruzamento com os dados de mídia paga.

export type AdTouchPlatform = "instagram" | "facebook" | "meta";

export interface AdTouchData {
  platform: AdTouchPlatform;
  source_type: string | null;
  ad_id: string | null;
  ad_title: string | null;
  ad_body: string | null;
  ad_url: string | null;
  ctwa_clid: string | null;
  campaign_id: null;
  campaign_name: null;
  /** Nomes (sem valores) dos campos do externalAdReply que vieram preenchidos: serve para validar o que o WhatsApp realmente fornece. */
  available_fields: string[];
  touch_key: string;
}

export interface LeadAdTouch extends Omit<AdTouchData, "touch_key" | "campaign_id" | "campaign_name"> {
  id: string;
  touched_at: string;
  conversation_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
}

/** O que a API devolve para a tela: sem ctwa_clid nem a lista interna de campos. */
export type AdTouchView = Pick<LeadAdTouch, "id" | "touched_at" | "platform" | "source_type" | "ad_id" | "ad_title" | "ad_body" | "ad_url" | "campaign_id" | "campaign_name" | "conversation_id">;
/** conversation = vínculo comprovado (conversa do negócio); estimated = só proximidade no tempo, NÃO comprovada; indeterminate = sem evidência. */
export type AttributionBasis = "conversation" | "estimated" | "indeterminate";
export interface AdOrigin {
  /** Mais recentes primeiro. Sempre inclui o primeiro toque do contato e o toque atribuído, mesmo que passem do limite da listagem. */
  touches: AdTouchView[];
  /** Total de toques do contato (pode ser maior que touches.length). */
  total_touches: number;
  /** Toque mais antigo do contato (não é deduzido pela posição na lista). */
  first_touch_id: string | null;
  /** Só para oportunidade: toque que a originou. */
  attributed_touch_id: string | null;
  /** Só para oportunidade: "conversation" (comprovada), "estimated" (só proximidade no tempo, não comprovada) ou "indeterminate" (sem evidência). null = fora de oportunidade. */
  attribution: AttributionBasis | null;
}

const MAX = { title: 300, body: 1000, url: 1000, id: 200, clid: 500, sourceType: 60 } as const;
const MAX_FIELD_NAMES = 40;
// Campos binários ou volumosos: nem entram na lista de nomes.
const IGNORED_FIELDS = new Set(["thumbnail"]);

function text(value: unknown, max: number): string | null {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

function hostOf(url: string | null): string {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function platformOf(url: string | null, sourceApp: string | null): AdTouchPlatform {
  const host = hostOf(url);
  const belongsTo = (d: string) => host === d || host.endsWith(`.${d}`);
  const app = sourceApp?.toLowerCase() ?? "";
  if (belongsTo("instagram.com") || app === "instagram") return "instagram";
  if (belongsTo("facebook.com") || app === "facebook") return "facebook";
  return "meta";
}

function urlWithoutParams(url: string): string {
  return url.replace(/[?#].*$/, "");
}

function normalizeForKey(value: string | null): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function presentFieldNames(ad: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(ad)) {
    if (IGNORED_FIELDS.has(key) || !/^[A-Za-z0-9_]{1,60}$/.test(key)) continue;
    const present = typeof value === "string" ? value.trim() !== "" : typeof value === "number" ? Number.isFinite(value) : value === true;
    if (present) names.push(key);
  }
  return names.sort().slice(0, MAX_FIELD_NAMES);
}

/** null quando não há contexto de anúncio ou nada que identifique o anúncio (id, link, título ou texto). */
export function extractAdTouch(ad: Record<string, unknown> | null | undefined): AdTouchData | null {
  if (!ad || typeof ad !== "object") return null;
  const ad_id = text(ad.sourceId, MAX.id);
  const ad_url = text(ad.sourceUrl, MAX.url);
  const ad_title = text(ad.title, MAX.title);
  const ad_body = text(ad.body, MAX.body);
  if (!ad_id && !ad_url && !ad_title && !ad_body) return null;
  const touch_key = ad_id
    ? `id:${ad_id}`
    : ad_url
      ? `url:${urlWithoutParams(ad_url)}`
      : `txt:${normalizeForKey(ad_title)}|${normalizeForKey(ad_body)}`;
  return {
    platform: platformOf(ad_url, text(ad.sourceApp, 40)),
    source_type: text(ad.sourceType, MAX.sourceType),
    ad_id, ad_title, ad_body, ad_url,
    ctwa_clid: text(ad.ctwaClid, MAX.clid),
    campaign_id: null, campaign_name: null,
    available_fields: presentFieldNames(ad),
    touch_key,
  };
}

export const TOUCH_SESSION_GAP_MS = 24 * 60 * 60 * 1000;
export const ATTRIBUTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 60_000;
const RECENT_TOUCH_COMPARE = 20;

export interface RecentTouch { touch_key: string; ctwa_clid: string | null; touched_at: string }

/**
 * Este contexto de anúncio é um NOVO toque? Reenvio da mesma mensagem é barrado à parte (índice único por mensagem).
 * - anúncio que não aparece nos toques recentes do contato: novo;
 * - mesmo anúncio e mesmo clique (ctwa_clid) já visto: duplicado; clique diferente (comprova outro clique): novo;
 * - mesmo anúncio sem como comparar o clique (falta em um dos lados): vale o tempo desde o último toque do anúncio:
 *   24 h ou mais = novo atendimento; menos, ou mensagem mais antiga que o último toque (reenvio) = duplicado.
 */
export function shouldRecordTouch(
  candidate: { touch_key: string; ctwa_clid: string | null; touchedAt: Date },
  recent: RecentTouch[]
): boolean {
  const same = recent.filter((r) => r.touch_key === candidate.touch_key).slice(0, RECENT_TOUCH_COMPARE);
  if (same.length === 0) return true;
  if (candidate.ctwa_clid && same.some((r) => r.ctwa_clid === candidate.ctwa_clid)) return false;
  const latest = same.reduce((best, r) => (Date.parse(r.touched_at) > Date.parse(best.touched_at) ? r : best));
  if (candidate.ctwa_clid && latest.ctwa_clid) return true; // ambos com clique e diferentes: outro clique comprovado
  const gap = candidate.touchedAt.getTime() - Date.parse(latest.touched_at);
  return Number.isFinite(gap) && gap >= TOUCH_SESSION_GAP_MS;
}

/**
 * Toque que originou a oportunidade, só com evidência:
 * 1. ligado a uma conversa VINCULADA ao negócio (lead_assignments.conversation_id) e até a criação dele, sem limite de idade: "conversation" (comprovada);
 * 2. senão, o mais recente dentro de 14 dias antes da criação: "estimated" (estimada, NÃO comprovada);
 * 3. senão, origem "indeterminate" (nada é atribuído). Tolerância de 1 min de relógio. Mesma regra da view opportunity_ad_origins.
 */
export function attributeTouch<T extends { touched_at: string; conversation_id?: string | null }>(
  touches: T[],
  opportunity: { createdAt: string; conversationIds?: string[] }
): { touch: T | null; basis: AttributionBasis } {
  const created = Date.parse(opportunity.createdAt);
  if (!Number.isFinite(created)) return { touch: null, basis: "indeterminate" };
  const conversations = new Set(opportunity.conversationIds ?? []);
  let linked: T | null = null, linkedAt = -Infinity;
  let recent: T | null = null, recentAt = -Infinity;
  for (const t of touches) {
    const at = Date.parse(t.touched_at);
    if (!Number.isFinite(at) || at > created + CLOCK_TOLERANCE_MS) continue;
    if (t.conversation_id && conversations.has(t.conversation_id) && at > linkedAt) { linked = t; linkedAt = at; }
    if (at >= created - ATTRIBUTION_WINDOW_MS && at > recentAt) { recent = t; recentAt = at; }
  }
  if (linked) return { touch: linked, basis: "conversation" };
  if (recent) return { touch: recent, basis: "estimated" };
  return { touch: null, basis: "indeterminate" };
}
