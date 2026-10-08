import type { FastifyInstance } from "fastify";
import { sendMessageSchema } from "@aula-agente/shared";
import { getAdminClient, getConversationById } from "@aula-agente/database";
import { authMiddleware, requireOrg } from "../../middleware/auth.js";
import { canViewLead } from "../../lib/lead-access.js";
import { sendPanelMessage } from "../../services/message-send.service.js";

export default async function messageSendRoutes(app: FastifyInstance) {
  app.post("/messages/send", {
    preHandler: [authMiddleware],
    handler: async (request, reply) => {
      const parseResult = sendMessageSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const { conversation_id, content } = parseResult.data;
      const db = getAdminClient();

      const conversation = await getConversationById(db, conversation_id);
      if (!conversation) {
        return reply.status(404).send({ error: "Conversation not found" });
      }

      const membership = request.user.memberships.find(
        (m) => m.organization_id === conversation.organization_id
      );
      if (!membership) {
        return reply.status(403).send({ error: "Access denied" });
      }

      if (!(await canViewLead(db, conversation.organization_id, membership.role, request.user.id, conversation.assigned_to))) {
        return reply.status(403).send({ error: "Este lead pertence a outro vendedor" });
      }

      let result;
      try {
        result = await sendPanelMessage({
          conversation,
          content,
          actorUserId: request.user.id,
        });
      } catch (err) {
        console.error(`Failed to send message for conversation ${conversation_id}:`, err);
        return reply.status(500).send({ error: "Failed to save message" });
      }

      return reply.status(200).send({ ok: true, messageId: result.message.id });
    },
  });
}
