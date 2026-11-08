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
