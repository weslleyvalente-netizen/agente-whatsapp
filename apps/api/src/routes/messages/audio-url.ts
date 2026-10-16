import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CUSTOMER_AUDIO_SIGNED_URL_TTL_SECONDS,
  parseCustomerAudioRef,
} from "@aula-agente/shared";
import { getAdminClient, getConversationById, getMessageById } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { canViewLead } from "../../lib/lead-access.js";

const paramsSchema = z.object({ messageId: z.string().uuid() });

// Link temporário (signed URL) para tocar o áudio de um cliente guardado no
// bucket privado. A permissão é a mesma das demais rotas de conversa: membro da
// organização e, com o isolamento por vendedor ligado, dono da conversa.
export default async function messageAudioUrlRoutes(app: FastifyInstance) {
  app.get("/messages/:messageId/audio-url", {
    preHandler: [authMiddleware],
    handler: async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: "Invalid message id" });

      const db = getAdminClient();
      const message = await getMessageById(db, params.data.messageId);
      if (!message) return reply.status(404).send({ error: "Message not found" });

      const membership = request.user.memberships.find((m) => m.organization_id === message.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const conversation = await getConversationById(db, message.conversation_id);
      if (!conversation) return reply.status(404).send({ error: "Message not found" });
      if (!(await canViewLead(db, conversation.organization_id, membership.role, request.user.id, conversation.assigned_to))) {
        return reply.status(403).send({ error: "Este lead pertence a outro vendedor" });
      }

      const ref = parseCustomerAudioRef(message.media_url);
      if (!ref) return reply.status(404).send({ error: "Audio not stored" });

      const { data, error } = await db.storage
        .from(ref.bucket)
        .createSignedUrl(ref.path, CUSTOMER_AUDIO_SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) {
        request.log.warn({ messageId: message.id, err: error?.message }, "Failed to sign customer audio url");
        return reply.status(404).send({ error: "Audio not available" });
      }

      return reply.send({ url: data.signedUrl, expiresIn: CUSTOMER_AUDIO_SIGNED_URL_TTL_SECONDS });
    },
  });
}
