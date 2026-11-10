import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CHAT_MEDIA_BUCKET,
  CHAT_MEDIA_MAX_BYTES,
  CHAT_MEDIA_REF_PREFIX,
  CHAT_MEDIA_RETENTION_DAYS,
  buildChatMediaRef,
  extensionFromMime,
  isChatMediaRefFor,
  parseChatMediaRef,
} from "@aula-agente/shared";
import {
  clearMessageMediaUrls,
  getConversationById,
  getInstanceById,
  getMessageById,
  listExpiredStoredAudioMessages,
  mergeMessageMetadata,
  setMessageMediaUrlIfEmpty,
} from "@aula-agente/database";
import { fetchMediaBase64, type EvolutionMediaBase64 } from "@aula-agente/agent-runtime";

export interface StoreChatMediaInput {
  messageId: string;
  conversationId: string;
  organizationId: string;
}

export type StoreChatMediaResult =
  | { ok: true; mediaUrl: string }
  | { ok: true; skipped: "already_stored" | "not_chat_media" | "too_large" }
  // permanent: repetir não adianta (o worker não deve gastar retentativas).
  | { ok: false; reason: string; permanent?: boolean };

type ChatMediaType = "image" | "video" | "document";
type FetchMedia = (instanceName: string, evolutionMessageId: string) => Promise<Partial<EvolutionMediaBase64>>;

const CAPTURE_FETCH_TIMEOUT_MS = 90_000;
const defaultFetchMedia: FetchMedia = (instanceName, evolutionMessageId) =>
  fetchMediaBase64(instanceName, evolutionMessageId, CAPTURE_FETCH_TIMEOUT_MS);

const FALLBACK_CONTENT_TYPE: Record<ChatMediaType, string> = {
  image: "image/jpeg",
  video: "video/mp4",
  document: "application/octet-stream",
};

function isChatMediaType(value: string | null | undefined): value is ChatMediaType {
  return value === "image" || value === "video" || value === "document";
}

function isAlreadyExists(error: { message?: string; statusCode?: string | number }): boolean {
  return String(error.statusCode) === "409" || /already exists|duplicate/i.test(error.message ?? "");
}

/**
 * Baixa imagem/vídeo/documento do cliente na Evolution e guarda no bucket privado.
 * Nunca lança: o chamador (job) decide se tenta de novo conforme o resultado.
 */
export async function storeChatMedia(
  db: SupabaseClient,
  input: StoreChatMediaInput,
  fetchMedia: FetchMedia = defaultFetchMedia
): Promise<StoreChatMediaResult> {
  try {
    const message = await getMessageById(db, input.messageId);
    if (!message || message.role !== "contact" || !isChatMediaType(message.media_type)) {
      return { ok: true, skipped: "not_chat_media" };
    }
    if (message.media_url) return { ok: true, skipped: "already_stored" };
    if (!message.evolution_message_id) return { ok: false, reason: "missing_evolution_message_id", permanent: true };
    const mediaType = message.media_type;

    const conversation = await getConversationById(db, message.conversation_id);
    const instance = await getInstanceById(db, conversation.evolution_instance_id);

    const media = await fetchMedia(instance.instance_name, message.evolution_message_id);
    const buffer = Buffer.from(media.base64 ?? "", "base64");
    if (buffer.length === 0) {
      await mergeMessageMetadata(db, message.id, { media: { status: "failed" } });
      return { ok: false, reason: "empty_media", permanent: true };
    }
    const contentType = media.mimetype || FALLBACK_CONTENT_TYPE[mediaType];
    const fileName = media.fileName || (mediaType === "document" ? message.content?.trim() || undefined : undefined);

    if (buffer.length > CHAT_MEDIA_MAX_BYTES[mediaType]) {
      await mergeMessageMetadata(db, message.id, {
        media: { status: "too_large", mime_type: contentType, size_bytes: buffer.length },
      });
      return { ok: true, skipped: "too_large" };
    }

    const ref = buildChatMediaRef({
      organizationId: message.organization_id,
      conversationId: message.conversation_id,
      messageId: message.id,
      extension: extensionFromMime(contentType, fileName),
    });
    const path = parseChatMediaRef(ref)!.path;

    const { error } = await db.storage
      .from(CHAT_MEDIA_BUCKET)
      .upload(path, buffer, { contentType, upsert: false });
    // 409: arquivo já subiu numa tentativa anterior que falhou ao gravar a referência.
    if (error && !isAlreadyExists(error as { message?: string; statusCode?: string })) {
      return { ok: false, reason: error.message };
    }

    await setMessageMediaUrlIfEmpty(db, message.id, ref);
    await mergeMessageMetadata(db, message.id, {
      media: {
        status: "stored",
        mime_type: contentType,
        size_bytes: buffer.length,
        ...(fileName ? { file_name: fileName } : {}),
      },
    });
    return { ok: true, mediaUrl: ref };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unknown_error" };
  }
}

const RETENTION_BATCH = 500;

/** Retenção: apaga do bucket a mídia com mais de 30 dias e zera media_url. metadata.media permanece. */
export async function runChatMediaRetention(db: SupabaseClient, now = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - CHAT_MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let deleted = 0;
  for (;;) {
    const batch = await listExpiredStoredAudioMessages(db, CHAT_MEDIA_REF_PREFIX, cutoff, RETENTION_BATCH);
    if (batch.length === 0) break;
    // media_url é editável por membros via RLS: só apaga o caminho que pertence à própria linha.
    // Referência forjada/inconsistente apenas tem media_url zerado, sem apagar nada.
    const paths = batch.flatMap((row) => {
      const ids = { organizationId: row.organization_id, conversationId: row.conversation_id, messageId: row.id };
      return isChatMediaRefFor(row.media_url, ids) ? [parseChatMediaRef(row.media_url)!.path] : [];
    });
    if (paths.length > 0) {
      const { error } = await db.storage.from(CHAT_MEDIA_BUCKET).remove(paths);
      if (error) throw new Error(`Chat media retention: storage remove failed: ${error.message}`);
    }
    await clearMessageMediaUrls(db, batch.map((row) => row.id));
    deleted += batch.length;
    if (batch.length < RETENTION_BATCH) break;
  }
  return { deleted };
}
