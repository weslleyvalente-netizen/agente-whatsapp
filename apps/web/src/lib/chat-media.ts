// Estado de exibição da mídia (imagem/vídeo/documento) de uma mensagem.
// Prefixo mantido local (ver CHAT_MEDIA_REF_PREFIX em @aula-agente/shared) para o bundle do navegador.
const CHAT_MEDIA_REF_PREFIX = "storage:chat-media/";
const PENDING_WINDOW_MS = 10 * 60 * 1000;
const MEDIA_TYPES = new Set(["image", "video", "document"]);

export type ChatMediaState = "stored" | "expired" | "too_large" | "failed" | "pending" | "none";

export interface ChatMediaInput {
  role: string;
  media_type: string | null;
  media_url: string | null;
  metadata: { media?: { status?: string } } | null;
  created_at: string;
}

export function chatMediaState(m: ChatMediaInput, now: Date = new Date()): ChatMediaState {
  if (!m.media_type || !MEDIA_TYPES.has(m.media_type)) return "none";
  const stored = m.media_url?.startsWith(CHAT_MEDIA_REF_PREFIX) ?? false;
  // Só o cliente tem captura em andamento; mídia enviada da loja não fica "carregando".
  if (m.role !== "contact" && !stored) return "none";
  if (m.media_url) return m.media_url.startsWith(CHAT_MEDIA_REF_PREFIX) ? "stored" : "none";
  const status = m.metadata?.media?.status;
  if (status === "stored") return "expired";
  if (status === "too_large") return "too_large";
  if (status === "failed") return "failed";
  // Após "Tentar de novo" o status é limpo: a captura voltou à fila, qualquer que seja a idade.
  if (m.metadata?.media) return "pending";
  const age = now.getTime() - new Date(m.created_at).getTime();
  return age < PENDING_WINDOW_MS ? "pending" : "none";
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  const fmt = (v: number) => {
    const r = Math.round(v * 10) / 10;
    return String(r).replace(".", ",");
  };
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${fmt(n / 1024)} KB`;
  return `${fmt(n / (1024 * 1024))} MB`;
}

// Textos que o webhook grava quando a mídia chega sem legenda.
export function isMediaPlaceholder(content: string): boolean {
  return ["[imagem]", "[video]", "[vídeo]", "[documento]"].includes(content.trim().toLowerCase());
}
