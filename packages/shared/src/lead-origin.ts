export type LeadOriginSource = "site_wix" | "facebook_ads" | "instagram_ads" | "meta_ads" | "instagram_organic";
export interface IdentifiedLeadOrigin { source: LeadOriginSource; evidence: string; }
export const LEAD_ORIGIN_LABELS: Record<LeadOriginSource, string> = {
  site_wix: "Formulário do site (Wix)", facebook_ads: "Facebook — anúncio",
  instagram_ads: "Instagram — anúncio", meta_ads: "Anúncio Meta",
  instagram_organic: "Instagram orgânico",
};
export function identifyLeadOrigin(input: { wix?: boolean; text?: string; ad?: Record<string, unknown> | null }): IdentifiedLeadOrigin | null {
  if (input.wix) return { source: "site_wix", evidence: "Webhook do formulário Wix" };
  if (input.ad && Object.keys(input.ad).length) {
    let host = "";
    const url = input.ad.sourceUrl;
    if (typeof url === "string") { try { host = new URL(url).hostname.toLowerCase(); } catch { /* No trusted platform URL. */ } }
    const platform = typeof input.ad.sourcePlatform === "string" ? input.ad.sourcePlatform.toLowerCase() : "";
    const belongsTo = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    const source = belongsTo("instagram.com") || platform === "instagram" ? "instagram_ads"
      : belongsTo("facebook.com") || platform === "facebook" ? "facebook_ads" : "meta_ads";
    return { source, evidence: typeof url === "string" ? url.slice(0, 1000) : "Contexto de anúncio externalAdReply" };
  }
  const text = (input.text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\bvim\s+(?:do|pelo)\s+instagram\b/.test(text)) return { source: "instagram_organic", evidence: (input.text ?? "").slice(0, 1000) };
  return null;
}
