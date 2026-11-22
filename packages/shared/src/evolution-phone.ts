const PHONE_SUFFIX = "@s.whatsapp.net";

/**
 * Número real do contato a partir da key do webhook do Evolution.
 * Após reconexão o Evolution pode entregar `remoteJid = "<n>@lid"` e o número
 * verdadeiro em `remoteJidAlt`. Sem alt válido, devolve o remoteJid inalterado
 * (nunca inventa número).
 */
export function resolveEvolutionPhone(key: { remoteJid: string; remoteJidAlt?: string | null }): string {
  const { remoteJid, remoteJidAlt } = key;
  if (remoteJid.endsWith("@lid") && typeof remoteJidAlt === "string" && remoteJidAlt.endsWith(PHONE_SUFFIX)) {
    const phone = remoteJidAlt.slice(0, -PHONE_SUFFIX.length);
    // Só dígitos, 8 a 15 (E.164): "0@s.whatsapp.net" e textos não numéricos não são telefone.
    if (/^\d{8,15}$/.test(phone)) return phone;
  }
  return remoteJid.replace(PHONE_SUFFIX, "");
}

/**
 * Par (identificador @lid, número real) quando o PRÓPRIO evento do WhatsApp traz os dois: chat @lid com alt de telefone, ou chat já
 * com o telefone e o @lid no alt (UAZAPI chatlid). Número só com 10 a 15 dígitos e nunca o da própria loja. Nunca por nome/foto.
 */
export function lidPairOf(key: { remoteJid: string; remoteJidAlt?: string | null }, resolvedPhone: string, ownPhone?: string | null): { lid: string; phone: string } | null {
  const lid = key.remoteJid.endsWith("@lid") ? key.remoteJid : typeof key.remoteJidAlt === "string" && key.remoteJidAlt.endsWith("@lid") ? key.remoteJidAlt : null;
  if (!lid || !/^\d{10,15}$/.test(resolvedPhone)) return null;
  const own = (ownPhone ?? "").replace(/\D/g, "");
  if (own && own === resolvedPhone) return null;
  return { lid, phone: resolvedPhone };
}
