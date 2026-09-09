import type { FastifyInstance } from "fastify";
import { updateConversationSchema } from "@aula-agente/shared";
import type { Conversation } from "@aula-agente/shared";
import { getAdminClient, getConversationById, updateConversation } from "@aula-agente/database";
import { authMiddleware } from "../../middleware/auth.js";
import { autoCompleteConversationTask } from "../../services/task.service.js";

export default async function conversationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.patch<{ Params: { conversationId: string } }>("/conversations/:conversationId", async (request, reply) => {
    const parseResult = updateConversationSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getConversationById(db, request.params.conversationId);
    const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    // Same reasoning as messages/send.ts and the evolution webhook: taking
    // the conversation over (via this toggle, independent of sending a
    // message) means the human is handling whatever the conversation's
    // open task was tracking, so close it out. Only on the transition into
    // takeover, not on every subsequent update.
    const isNewTakeover = parseResult.data.is_human_takeover === true && !existing.is_human_takeover;

    const updates: Partial<Conversation> = { ...parseResult.data };
    // human_takeover_at and assigned_to follow the server's clock/session,
    // not client-supplied values — mirrors messages/send.ts and the
    // evolution webhook, which never trust the caller for either.
    if (parseResult.data.is_human_takeover !== undefined) {
      updates.human_takeover_at = parseResult.data.is_human_takeover ? new Date().toISOString() : null;
      if (parseResult.data.assigned_to === undefined) {
        updates.assigned_to = parseResult.data.is_human_takeover ? request.user.id : null;
      }
    }

    const updated = await updateConversation(db, request.params.conversationId, updates);

    if (isNewTakeover) {
      try {
        await autoCompleteConversationTask(db, existing.organization_id, request.params.conversationId, request.user.id);
      } catch (err) {
        request.log.error(
          { err, conversationId: request.params.conversationId },
          "Failed to auto-complete task on takeover toggle"
        );
      }
    }

    return updated;
  });
}
