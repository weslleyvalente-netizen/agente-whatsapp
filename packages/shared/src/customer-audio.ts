// Áudios recebidos de clientes ficam em bucket PRIVADO do Supabase Storage.
// messages.media_url guarda uma referência estável ("storage:<bucket>/<caminho>"),
// nunca uma URL assinada: o link temporário é emitido pela API a cada pedido.
export const CUSTOMER_AUDIO_BUCKET = "customer-audio";
export const CUSTOMER_AUDIO_REF_PREFIX = `storage:${CUSTOMER_AUDIO_BUCKET}/`;
export const CUSTOMER_AUDIO_RETENTION_DAYS = 90;
export const CUSTOMER_AUDIO_SIGNED_URL_TTL_SECONDS = 300;

export function buildCustomerAudioRef(p: {
  organizationId: string;
  conversationId: string;
  messageId: string;
  extension: string;
}): string {
  return `${CUSTOMER_AUDIO_REF_PREFIX}${p.organizationId}/${p.conversationId}/${p.messageId}.${p.extension}`;
}

export function parseCustomerAudioRef(ref: string | null | undefined): { bucket: string; path: string } | null {
  if (!ref || !ref.startsWith(CUSTOMER_AUDIO_REF_PREFIX)) return null;
  const path = ref.slice(CUSTOMER_AUDIO_REF_PREFIX.length);
  if (!path || path.split("/").some((part) => part === ".." || part === "")) return null;
  return { bucket: CUSTOMER_AUDIO_BUCKET, path };
}

export function isStoredCustomerAudioRef(ref: string | null | undefined): boolean {
  return parseCustomerAudioRef(ref) !== null;
}

export const CUSTOMER_AUDIO_EXTENSIONS = ["mp4", "mp3", "wav", "webm", "ogg"] as const;
export const CUSTOMER_AUDIO_MAX_BYTES = 50 * 1024 * 1024;

/**
 * A referência só vale se for EXATAMENTE o caminho da própria mensagem. Como membros podem alterar
 * messages.media_url via RLS, nunca se assina nem se apaga um caminho que não pertença à linha.
 */
export function isCustomerAudioRefFor(
  ref: string | null | undefined,
  ids: { organizationId: string; conversationId: string; messageId: string }
): boolean {
  if (!ref || !ref.startsWith(CUSTOMER_AUDIO_REF_PREFIX)) return false;
  const path = ref.slice(CUSTOMER_AUDIO_REF_PREFIX.length);
  return CUSTOMER_AUDIO_EXTENSIONS.some(
    (ext) => path === `${ids.organizationId}/${ids.conversationId}/${ids.messageId}.${ext}`
  );
}
