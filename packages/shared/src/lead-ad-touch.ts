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
export interface AdOrigin { touches: AdTouchView[]; attributed_touch_id: string | null }

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

const CLOCK_TOLERANCE_MS = 60_000;

/**
 * Toque que originou a oportunidade: o mais recente até o momento da criação dela (tolerância de 1 min de relógio).
 * Mesma regra da view opportunity_ad_origins. Os demais toques do contato ficam no histórico.
 */
export function pickAttributedTouch<T extends { touched_at: string }>(touches: T[], opportunityCreatedAt: string): T | null {
  const limit = Date.parse(opportunityCreatedAt);
  if (!Number.isFinite(limit)) return null;
  let best: T | null = null;
  let bestAt = -Infinity;
  for (const t of touches) {
    const at = Date.parse(t.touched_at);
    if (!Number.isFinite(at) || at > limit + CLOCK_TOLERANCE_MS) continue;
    if (at > bestAt) { best = t; bestAt = at; }
  }
  return best;
}
