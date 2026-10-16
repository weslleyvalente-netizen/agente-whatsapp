import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOMER_AUDIO_BUCKET,
  CUSTOMER_AUDIO_REF_PREFIX,
  CUSTOMER_AUDIO_RETENTION_DAYS,
  buildCustomerAudioRef,
  parseCustomerAudioRef,
} from "@aula-agente/shared";
import {
  clearMessageMediaUrls,
  getConversationById,
  getInstanceById,
  getMessageById,
  listExpiredStoredAudioMessages,
  setMessageMediaUrlIfEmpty,
} from "@aula-agente/database";
import { fetchAudioAsMp4, pickAudioFileExtension } from "@aula-agente/agent-runtime";

export interface StoreCustomerAudioInput {
  messageId: string;
  conversationId: string;
  organizationId: string;
}

export type StoreCustomerAudioResult =
  | { ok: true; mediaUrl: string }
  | { ok: true; skipped: "already_stored" | "not_customer_audio" }
  | { ok: false; reason: string };

type FetchAudio = (instanceName: string, evolutionMessageId: string) => Promise<{ base64: string; mimetype: string }>;

function isAlreadyExists(error: { message?: string; statusCode?: string | number }): boolean {
  return String(error.statusCode) === "409" || /already exists|duplicate/i.test(error.message ?? "");
}

/**
 * Baixa o áudio do cliente na Evolution (mesmo método da transcrição) e guarda no bucket privado.
 * Nunca lança: o chamador (job) decide se tenta de novo conforme o resultado.
 */
export async function storeCustomerAudio(
  db: SupabaseClient,
  input: StoreCustomerAudioInput,
  fetchAudio: FetchAudio = fetchAudioAsMp4
): Promise<StoreCustomerAudioResult> {
  try {
    const message = await getMessageById(db, input.messageId);
    if (!message || message.role !== "contact" || message.media_type !== "audio") {
      return { ok: true, skipped: "not_customer_audio" };
    }
    if (message.media_url) return { ok: true, skipped: "already_stored" };
    if (!message.evolution_message_id) return { ok: false, reason: "missing_evolution_message_id" };

    const conversation = await getConversationById(db, message.conversation_id);
    const instance = await getInstanceById(db, conversation.instance_id);

    const { base64, mimetype } = await fetchAudio(instance.instance_name, message.evolution_message_id);
    const buffer = Buffer.from(base64 ?? "", "base64");
    if (buffer.length === 0) return { ok: false, reason: "empty_audio" };

    const ref = buildCustomerAudioRef({
      organizationId: message.organization_id,
      conversationId: message.conversation_id,
      messageId: message.id,
      extension: pickAudioFileExtension(mimetype),
    });
    const path = parseCustomerAudioRef(ref)!.path;

    const { error } = await db.storage
      .from(CUSTOMER_AUDIO_BUCKET)
      .upload(path, buffer, { contentType: mimetype || "audio/mp4", upsert: false });
    // 409: arquivo já subiu numa tentativa anterior que falhou ao gravar a referência.
    if (error && !isAlreadyExists(error as { message?: string; statusCode?: string })) {
      return { ok: false, reason: error.message };
    }

    await setMessageMediaUrlIfEmpty(db, message.id, ref);
    return { ok: true, mediaUrl: ref };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unknown_error" };
  }
}

const RETENTION_BATCH = 500;

/** Retenção: apaga do bucket os áudios com mais de 90 dias e zera media_url. O texto/transcrição permanece. */
export async function runCustomerAudioRetention(db: SupabaseClient, now = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - CUSTOMER_AUDIO_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let deleted = 0;
  for (;;) {
    const batch = await listExpiredStoredAudioMessages(db, CUSTOMER_AUDIO_REF_PREFIX, cutoff, RETENTION_BATCH);
    if (batch.length === 0) break;
    const paths = batch.flatMap((row) => {
      const parsed = parseCustomerAudioRef(row.media_url);
      return parsed ? [parsed.path] : [];
    });
    if (paths.length > 0) {
      const { error } = await db.storage.from(CUSTOMER_AUDIO_BUCKET).remove(paths);
      if (error) throw new Error(`Customer audio retention: storage remove failed: ${error.message}`);
    }
    await clearMessageMediaUrls(db, batch.map((row) => row.id));
    deleted += batch.length;
    if (batch.length < RETENTION_BATCH) break;
  }
  return { deleted };
}
