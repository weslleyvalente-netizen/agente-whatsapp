// Imagem, vídeo e documento do chat ficam em bucket PRIVADO do Supabase Storage.
// messages.media_url guarda uma referência estável ("storage:<bucket>/<caminho>"),
// nunca uma URL assinada: o link temporário é emitido pela API a cada pedido.
export const CHAT_MEDIA_BUCKET = "chat-media";
export const CHAT_MEDIA_REF_PREFIX = `storage:${CHAT_MEDIA_BUCKET}/`;
export const CHAT_MEDIA_RETENTION_DAYS = 30;
export const CHAT_MEDIA_SIGNED_URL_TTL_SECONDS = 300;

export const CHAT_MEDIA_MAX_BYTES: Record<"image" | "video" | "document", number> = {
  image: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  document: 25 * 1024 * 1024,
};

export function buildChatMediaRef(p: {
  organizationId: string;
  conversationId: string;
  messageId: string;
  extension: string;
}): string {
  return `${CHAT_MEDIA_REF_PREFIX}${p.organizationId}/${p.conversationId}/${p.messageId}.${p.extension}`;
}

export function parseChatMediaRef(ref: string | null | undefined): { bucket: string; path: string } | null {
  if (!ref || !ref.startsWith(CHAT_MEDIA_REF_PREFIX)) return null;
  const path = ref.slice(CHAT_MEDIA_REF_PREFIX.length);
  if (!path || path.split("/").some((part) => part === ".." || part === "")) return null;
  return { bucket: CHAT_MEDIA_BUCKET, path };
}

/**
 * A referência só vale se for EXATAMENTE o caminho da própria mensagem. Como membros podem alterar
 * messages.media_url via RLS, nunca se assina nem se apaga um caminho que não pertença à linha.
 */
export function isChatMediaRefFor(
  ref: string | null | undefined,
  ids: { organizationId: string; conversationId: string; messageId: string }
): boolean {
  if (!ref || !ref.startsWith(CHAT_MEDIA_REF_PREFIX)) return false;
  const path = ref.slice(CHAT_MEDIA_REF_PREFIX.length);
  const base = `${ids.organizationId}/${ids.conversationId}/${ids.messageId}.`;
  if (!path.startsWith(base)) return false;
  return /^[a-z0-9]{1,8}$/.test(path.slice(base.length));
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/zip": "zip",
};

export function extensionFromMime(mime: string, fileName?: string): string {
  const key = (mime ?? "").split(";")[0].trim().toLowerCase();
  const mapped = MIME_EXTENSIONS[key];
  if (mapped) return mapped;
  const dot = fileName ? fileName.lastIndexOf(".") : -1;
  if (fileName && dot >= 0) {
    const ext = fileName.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  return "bin";
}

const DOWNLOAD_NAME_MAX = 120;

/**
 * Nome de arquivo vindo do cliente (WhatsApp) é hostil: vai para `&download=<nome>` da URL assinada
 * e para o Content-Disposition. Deixa só o nome-base, sem controles nem caracteres que alteram a
 * query/cabeçalho. Devolve null quando nada aproveitável sobra.
 */
export function sanitizeDownloadName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  let clean = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")
    .replace(/["&#?%;:*<>|/\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length > DOWNLOAD_NAME_MAX) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 && clean.length - dot <= 9 ? clean.slice(dot) : "";
    clean = clean.slice(0, DOWNLOAD_NAME_MAX - ext.length).trimEnd() + ext;
  }
  if (!clean || /^\.+$/.test(clean)) return null;
  return clean;
}
