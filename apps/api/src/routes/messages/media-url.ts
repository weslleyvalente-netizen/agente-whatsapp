import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CHAT_MEDIA_SIGNED_URL_TTL_SECONDS,
  isChatMediaRefFor,
  parseChatMediaRef,
  sanitizeDownloadName,
} from "@aula-agente/shared";
import {
  clearMessageMediaStatus,
  getAdminClient,
  getConversationById,
  getMessageById,
  mergeMessageMetadata,
} from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { canViewLead } from "../../lib/lead-access.js";
import { enqueueStoreChatMedia } from "../../lib/queue.js";

const paramsSchema = z.object({ messageId: z.string().uuid() });
const querySchema = z.object({ download: z.string().optional() });

type MessageRow = NonNullable<Awaited<ReturnType<typeof getMessageById>>>;
type ConversationRow = Awaited<ReturnType<typeof getConversationById>>;

// Mesma ordem de checagem de audio-url.ts. Devolve a mensagem + conversa, ou já responde o erro.
async function loadAuthorizedMessage(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<{ message: MessageRow; conversation: NonNullable<ConversationRow> } | null> {
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) {
    await reply.status(400).send({ error: "Invalid message id" });
    return null;
  }

  const db = getAdminClient();
  const message = await getMessageById(db, params.data.messageId);
  if (!message) {
    await reply.status(404).send({ error: "Message not found" });
    return null;
  }

  const membership = request.user.memberships.find((m) => m.organization_id === message.organization_id);
  if (!membership) {
    await reply.status(403).send({ error: "Access denied" });
    return null;
  }

  if (
    !["contact", "human_agent"].includes(message.role) ||
    !["image", "video", "document"].includes(message.media_type ?? "")
  ) {
    await reply.status(404).send({ error: "Media not stored" });
    return null;
  }

  // getConversationById lança quando a conversa não existe: tratar como 404, não 500.
  let conversation: ConversationRow;
  try {
    conversation = await getConversationById(db, message.conversation_id);
  } catch {
    await reply.status(404).send({ error: "Message not found" });
    return null;
  }
  if (!conversation || conversation.organization_id !== message.organization_id) {
    await reply.status(404).send({ error: "Message not found" });
    return null;
  }
  if (!(await canViewLead(db, conversation.organization_id, membership.role, request.user.id, conversation.assigned_to))) {
    await reply.status(403).send({ error: "Este lead pertence a outro vendedor" });
    return null;
  }

  return { message, conversation };
}

// Link temporário (signed URL) para ver/baixar imagem, vídeo ou documento do chat guardado no
// bucket privado, e nova tentativa de captura quando a primeira falhou.
export default async function messageMediaUrlRoutes(app: FastifyInstance) {
  app.get("/messages/:messageId/media-url", {
    preHandler: [authMiddleware],
    handler: async (request, reply) => {
      const loaded = await loadAuthorizedMessage(request, reply);
      if (!loaded) return;
      const { message } = loaded;

      // media_url é editável por membros via RLS: só assina o caminho exato da própria mensagem.
      const ref = isChatMediaRefFor(message.media_url, {
        organizationId: message.organization_id,
        conversationId: message.conversation_id,
        messageId: message.id,
      })
        ? parseChatMediaRef(message.media_url)
        : null;
      if (!ref) return reply.status(404).send({ error: "Media not stored" });

      const query = querySchema.safeParse(request.query);
      const wantsDownload = (query.success && query.data.download === "1") || message.media_type === "document";
      const fileName = sanitizeDownloadName(message.metadata?.media?.file_name);
      const mimeType = message.metadata?.media?.mime_type ?? null;

      const db = getAdminClient();
      const bucket = db.storage.from(ref.bucket);
      const { data, error } = wantsDownload
        ? await bucket.createSignedUrl(ref.path, CHAT_MEDIA_SIGNED_URL_TTL_SECONDS, { download: fileName ?? true })
        : await bucket.createSignedUrl(ref.path, CHAT_MEDIA_SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) {
        request.log.warn({ messageId: message.id, err: error?.message }, "Failed to sign chat media url");
        return reply.status(404).send({ error: "Media not available" });
      }

      return reply.send({ url: data.signedUrl, expiresIn: CHAT_MEDIA_SIGNED_URL_TTL_SECONDS, fileName, mimeType });
    },
  });

  app.post("/messages/:messageId/retry-media", {
    preHandler: [authMiddleware],
    handler: async (request, reply) => {
      const loaded = await loadAuthorizedMessage(request, reply);
      if (!loaded) return;
      const { message } = loaded;

      if (message.role !== "contact" || message.metadata?.media?.status !== "failed" || message.media_url) {
        return reply.status(409).send({ error: "Media cannot be retried" });
      }

      // Limpa antes de enfileirar (o worker pode gravar "stored" logo em seguida); se a fila falhar,
      // devolve o status "failed" para o botão de nova tentativa não sumir.
      const db = getAdminClient();
      await clearMessageMediaStatus(db, message.id);
      try {
        await enqueueStoreChatMedia(
          { messageId: message.id, conversationId: message.conversation_id, organizationId: message.organization_id },
          { retry: true }
        );
      } catch (err) {
        request.log.warn({ messageId: message.id, err: err instanceof Error ? err.message : String(err) }, "Failed to enqueue chat media retry");
        await mergeMessageMetadata(db, message.id, { media: { status: "failed" } });
        return reply.status(503).send({ error: "Não foi possível reenviar agora. Tente de novo em instantes." });
      }
      return reply.send({ ok: true });
    },
  });
}
