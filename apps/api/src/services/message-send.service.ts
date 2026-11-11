import {
  getAdminClient,
  updateConversation,
  getInstanceById,
  createHandoffEvent,
  getOpenHandoffEvent,
  markFirstHumanReply,
  setMessageMediaUrlIfEmpty,
  updateMessageContent,
} from "@aula-agente/database";
import {
  CUSTOMER_AUDIO_BUCKET,
  buildCustomerAudioRef,
  parseCustomerAudioRef,
  buildChatMediaRef,
  parseChatMediaRef,
  sanitizeDownloadName,
} from "@aula-agente/shared";
import type { Conversation, Message } from "@aula-agente/shared";
import { saveMessage } from "./message.service.js";
import { handleConversationTakeover } from "./task.service.js";
import { enqueueSendMessage } from "../lib/queue.js";
import { trackFirstHumanMessage } from "./lead-human-message.js";

export interface SendPanelMessageParams {
  conversation: Conversation;
  content: string;
  actorUserId: string;
  // Manual sends from the inbox always activate takeover (default true).
  // Follow-up-from-task passes false by default (D3) so the AI keeps
  // answering the conversation normally after a one-off follow-up.
  activateTakeover?: boolean;
  metadata?: Record<string, unknown> | null;
  // Point 2: when true, the send-message job gets attempts: 1 — BullMQ's
  // default retry (3 attempts) must never fire for a follow-up-from-task
  // send, since a job whose HTTP response to us got lost after Evolution
  // already delivered the message would otherwise resend it for real.
  noAutoRetry?: boolean;
  // Áudio gravado pelo vendedor: sobe para o Storage antes de enfileirar o envio.
  audio?: { buffer: Buffer; extension: "webm" | "mp4" | "ogg"; durationSeconds?: number };
  // Imagem, vídeo ou documento enviado pelo vendedor: sobe para o bucket chat-media antes de enfileirar.
  attachment?: {
    buffer: Buffer;
    kind: "image" | "video" | "document";
    mime: string;
    extension: string;
    fileName: string;
    caption?: string;
  };
}

/** Falha no envio de anexo; `uploaded` indica se o arquivo já foi armazenado (conta no limite por hora). */
export class SellerAttachmentSendError extends Error {
  constructor(message: string, public readonly uploaded: boolean) {
    super(message);
    this.name = "SellerAttachmentSendError";
  }
}

/** Falha no envio de áudio; `uploaded` indica se o arquivo já foi armazenado (conta no limite por hora). */
export class SellerAudioSendError extends Error {
  constructor(message: string, public readonly uploaded: boolean) {
    super(message);
    this.name = "SellerAudioSendError";
  }
}

async function removeOrphanUpload(db: ReturnType<typeof getAdminClient>, bucket: string, path: string) {
  try {
    await db.storage.from(bucket).remove([path]);
  } catch (err) {
    console.error(`Failed to remove orphaned attachment ${path}:`, err);
  }
}

export interface SendPanelMessageResult {
  message: Message;
  instanceId: string;
}

// Extracted from routes/messages/send.ts so the same send+takeover+handoff
// orchestration is shared by the manual inbox send and the
// follow-up-from-task flow (task-followup.service.ts) instead of duplicated.
export async function sendPanelMessage(params: SendPanelMessageParams): Promise<SendPanelMessageResult> {
  const { conversation, actorUserId, audio, attachment } = params;
  const attachmentName = attachment ? sanitizeDownloadName(attachment.fileName) ?? `anexo.${attachment.extension}` : null;
  const content = audio
    ? "[audio]"
    : attachment
      ? attachment.caption ?? (attachment.kind === "image" ? "[imagem]" : attachment.kind === "video" ? "[video]" : attachmentName!)
      : params.content;
  const metadata = audio
    ? { source: "seller_audio", ...(audio.durationSeconds != null ? { duration_seconds: audio.durationSeconds } : {}) }
    : attachment
      ? {
          source: "seller_attachment",
          media: { status: "stored", file_name: attachmentName, mime_type: attachment.mime, size_bytes: attachment.buffer.length },
        }
      : params.metadata;
  const activateTakeover = params.activateTakeover ?? true;
  const db = getAdminClient();

  const message = await saveMessage({
    conversationId: conversation.id,
    organizationId: conversation.organization_id,
    evolutionMessageId: null,
    role: "human_agent",
    content,
    ...(audio ? { mediaType: "audio" as const } : attachment ? { mediaType: attachment.kind } : {}),
    metadata: metadata ?? null,
  });

  if (!message) {
    throw new Error(`Failed to save message for conversation ${conversation.id}`);
  }

  let storedAudioRef: string | undefined;
  let storedMediaRef: string | undefined;
  let uploaded = false;

  // Para áudio e anexo, qualquer falha depois de salvar a linha marca send_failed_at (o painel não pode mostrar
  // como enviado um áudio que não saiu) e relança com a informação de que o arquivo já foi armazenado.
  try {
    if (audio) {
      storedAudioRef = buildCustomerAudioRef({
        organizationId: conversation.organization_id,
        conversationId: conversation.id,
        messageId: message.id,
        extension: audio.extension,
      });
      const parsed = parseCustomerAudioRef(storedAudioRef);
      if (!parsed) throw new Error("Referência de áudio inválida");
      const { error } = await db.storage.from(CUSTOMER_AUDIO_BUCKET).upload(parsed.path, audio.buffer, {
        contentType: `audio/${audio.extension}`,
        upsert: false,
      });
      if (error) throw error;
      uploaded = true;
      if (!(await setMessageMediaUrlIfEmpty(db, message.id, storedAudioRef))) {
        throw new Error("Não foi possível gravar a referência do áudio");
      }
    }

    if (attachment) {
      storedMediaRef = buildChatMediaRef({
        organizationId: conversation.organization_id,
        conversationId: conversation.id,
        messageId: message.id,
        extension: attachment.extension,
      });
      const parsed = parseChatMediaRef(storedMediaRef);
      if (!parsed) throw new Error("Referência de anexo inválida");
      const { error } = await db.storage.from(parsed.bucket).upload(parsed.path, attachment.buffer, {
        contentType: attachment.mime,
        upsert: false,
      });
      if (error) throw error;
      uploaded = true;
      let linked = false;
      try {
        linked = await setMessageMediaUrlIfEmpty(db, message.id, storedMediaRef);
      } catch (linkErr) {
        await removeOrphanUpload(db, parsed.bucket, parsed.path);
        throw linkErr;
      }
      if (!linked) {
        // A linha nunca apontou para o arquivo: remove só o objeto que acabou de subir.
        await removeOrphanUpload(db, parsed.bucket, parsed.path);
        throw new Error("Não foi possível gravar a referência do anexo");
      }
    }

    const isFirstTakeover = !conversation.is_human_takeover;

    if (activateTakeover) {
      await updateConversation(db, conversation.id, {
        is_human_takeover: true,
        human_takeover_at: new Date().toISOString(),
        ...(isFirstTakeover ? { assigned_to: actorUserId } : {}),
      });

      if (isFirstTakeover) {
        try {
          await handleConversationTakeover(db, conversation.organization_id, conversation.id, actorUserId);
        } catch (err) {
          console.error(`Failed to reassign task on takeover for conversation ${conversation.id}:`, err);
        }
        try {
          await createHandoffEvent(db, {
            organization_id: conversation.organization_id,
            conversation_id: conversation.id,
            trigger_type: "painel_manual",
            criado_por: "humano",
          });
        } catch (err) {
          console.error(`Failed to record painel_manual handoff event for conversation ${conversation.id}:`, err);
        }
      }
    }

    // Closes an existing requestHuman handoff loop's "tempo até a primeira
    // resposta" metric regardless of activateTakeover — this reply answers a
    // pending handoff either way. Best-effort, never blocks the send.
    try {
      const openHandoff = await getOpenHandoffEvent(db, conversation.id);
      if (openHandoff) {
        await markFirstHumanReply(db, openHandoff.id, new Date().toISOString());
      }
    } catch (err) {
      console.error(`Failed to mark first human reply for conversation ${conversation.id}:`, err);
    }

    // Rodízio: a primeira mensagem humana do vendedor atribuído assume o lead e marca a primeira resposta.
    await trackFirstHumanMessage(db, {
      organizationId: conversation.organization_id,
      conversationId: conversation.id,
      role: message.role,
      source: "panel",
      actorUserId,
      metadata: metadata ?? null,
    });

    const instance = await getInstanceById(db, conversation.evolution_instance_id);
    const contact = (conversation as unknown as { wa_contacts: { phone: string } }).wa_contacts;

    await enqueueSendMessage(
      {
        conversationId: conversation.id,
        messageId: message.id,
        instanceId: instance.id,
        phone: contact.phone,
        content,
        organizationId: conversation.organization_id,
        ...(storedAudioRef ? { storedAudioRef } : {}),
        ...(attachment && storedMediaRef
          ? {
              storedMediaRef,
              mediaFileName: attachmentName!,
              mediaMime: attachment.mime,
              mediaKind: attachment.kind,
              ...(attachment.caption ? { caption: attachment.caption } : {}),
            }
          : {}),
      },
      params.noAutoRetry || audio || attachment ? { attempts: 1 } : undefined
    );

    return { message, instanceId: instance.id };
  } catch (err) {
    if (!audio && !attachment) throw err;
    console.error(`Failed to send seller ${audio ? "audio" : "attachment"} for conversation ${conversation.id}:`, err);
    try {
      await updateMessageContent(db, message.id, content, {
        ...(metadata ?? {}),
        send_failed_at: new Date().toISOString(),
      } as Message["metadata"]);
    } catch (markErr) {
      console.error(`Failed to mark send_failed_at for message ${message.id}:`, markErr);
    }
    if (attachment) throw new SellerAttachmentSendError("Falha ao enviar o anexo", uploaded);
    throw new SellerAudioSendError("Falha ao enviar o áudio", uploaded);
  }
}
