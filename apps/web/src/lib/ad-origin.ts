import type { AdTouchView } from "@aula-agente/shared";

const PLATFORM_LABELS: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", meta: "Anúncio Meta" };

export function adPlatformLabel(platform: string): string {
  return Object.hasOwn(PLATFORM_LABELS, platform) ? PLATFORM_LABELS[platform] : PLATFORM_LABELS.meta;
}

/** Só http(s) vira link: o endereço vem do WhatsApp e nunca deve virar javascript: ou data:. */
export function safeAdUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export function formatAdTouchDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

export function adTouchHeading(t: Pick<AdTouchView, "ad_title" | "ad_id" | "platform">): string {
  if (t.ad_title?.trim()) return t.ad_title.trim();
  if (t.ad_id) return `Anúncio ${t.ad_id}`;
  const label = adPlatformLabel(t.platform);
  return label === "Anúncio Meta" ? label : `Anúncio do ${label}`;
}
