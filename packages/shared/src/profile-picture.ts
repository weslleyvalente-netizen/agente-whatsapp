// Fotos de perfil do WhatsApp ficam em bucket PRIVADO do Supabase Storage.
// O link temporário (signed URL) é emitido pela API a cada pedido.
export const PROFILE_PICTURE_BUCKET = "profile-pictures";
export const PROFILE_PICTURE_REFRESH_DAYS = 7;
export const PROFILE_PICTURE_RETRY_HOURS = 24;
export const PROFILE_PICTURE_SIGNED_URL_TTL_SECONDS = 3600;

const VALID_PHONE = /^\d{8,15}$/;
const HOUR_MS = 60 * 60 * 1000;

export function buildProfilePicturePath(p: {
  organizationId: string;
  contactId: string;
  extension: "jpg" | "png" | "webp";
}): string {
  return `${p.organizationId}/${p.contactId}.${p.extension}`;
}

/**
 * Decide se vale buscar a foto de perfil de novo. Telefones que não são só dígitos (ex.: "...@lid")
 * nunca são consultados. Com foto: renova após 7 dias. Sem foto: tenta de novo após 24 h.
 */
export function shouldRefreshProfilePicture(
  c: { phone: string; profile_picture_path: string | null; profile_picture_checked_at: string | null },
  now: Date = new Date()
): boolean {
  if (!VALID_PHONE.test(c.phone)) return false;
  if (!c.profile_picture_checked_at) return true;
  const checkedAt = Date.parse(c.profile_picture_checked_at);
  if (Number.isNaN(checkedAt)) return true;
  const windowMs = c.profile_picture_path
    ? PROFILE_PICTURE_REFRESH_DAYS * 24 * HOUR_MS
    : PROFILE_PICTURE_RETRY_HOURS * HOUR_MS;
  return now.getTime() - checkedAt >= windowMs;
}

const NAME_CONNECTORS = new Set(["da", "das", "de", "do", "dos", "e"]);

/** Iniciais para o avatar: 1ª letra das duas primeiras palavras (sem conectivos "da/de/do..."). "#" sem nome. */
export function contactInitials(name: string | null, _phone: string): string {
  const words = (name ?? "").split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !NAME_CONNECTORS.has(w.toLowerCase()));
  const picked = (meaningful.length > 0 ? meaningful : words).slice(0, 2);
  const initials = picked.map((w) => Array.from(w)[0] ?? "").join("").toUpperCase();
  return initials || "#";
}

/** Índice estável (hash simples) dentro de [0, paletteSize) para escolher a cor do avatar. */
export function avatarColorIndex(seed: string, paletteSize: number): number {
  if (!Number.isInteger(paletteSize) || paletteSize <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % paletteSize;
}
