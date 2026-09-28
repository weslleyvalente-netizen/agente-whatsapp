import type { FastifyInstance } from "fastify";
import { sendMessageSchema } from "@aula-agente/shared";
import {
  getAdminClient,
  getConversationById,
  updateConversation,
  getInstanceById,
  createHandoffEvent,
  getOpenHandoffEvent,
  markFirstHumanReply,
} from "@aula-agente/database";
import { authMiddleware, requireOrg } from "../../middleware/auth.js";
import { saveMessage } from "../../services/message.service.js";
import { handleConversationTakeover } from "../../services/task.service.js";
import { enqueueSendMessage } from "../../lib/queue.js";

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

      // Get conversation
      const conversation = await getConversationById(db, conversation_id);
      if (!conversation) {
        return reply.status(404).send({ error: "Conversation not found" });
      }

      // Check user has access to this org
      const membership = request.user.memberships.find(
        (m) => m.organization_id === conversation.organization_id
      );
      if (!membership) {
        return reply.status(403).send({ error: "Access denied" });
      }

      // Save human agent message
      const message = await saveMessage({
        conversationId: conversation_id,
        organizationId: conversation.organization_id,
        evolutionMessageId: null,
        role: "human_agent",
        content,
      });

      if (!message) {
        return reply.status(500).send({ error: "Failed to save message" });
      }

      // A human replying manually takes the conversation over — the AI
      // agent stops responding until someone explicitly hands it back
      // (the existing "Devolver ao Agente" toggle). assigned_to is only
      // set on the first takeover — the first responder keeps ownership —
      // but human_takeover_at is refreshed on every reply, since it drives
      // the auto-expiry timer (HUMAN_TAKEOVER_TIMEOUT_MS). Leaving it frozen
      // at the first reply let the agent resume mid-conversation after 30
      // minutes even while a human was still actively replying.
      const isFirstTakeover = !conversation.is_human_takeover;

      await updateConversation(db, conversation_id, {
        is_human_takeover: true,
        human_takeover_at: new Date().toISOString(),
        ...(isFirstTakeover ? { assigned_to: request.user.id } : {}),
      });

      // Best-effort: a human taking over means they're now handling
      // whatever this conversation's open task was tracking — reassign it
      // to them, don't close it out. Only on the takeover itself, not
      // every subsequent reply. Never blocks the message send.
      if (isFirstTakeover) {
        try {
          await handleConversationTakeover(db, conversation.organization_id, conversation_id, request.user.id);
        } catch (err) {
          console.error(`Failed to reassign task on takeover for conversation ${conversation_id}:`, err);
        }
        try {
          await createHandoffEvent(db, {
            organization_id: conversation.organization_id,
            conversation_id,
            trigger_type: "painel_manual",
            criado_por: "humano",
          });
        } catch (err) {
          console.error(`Failed to record painel_manual handoff event for conversation ${conversation_id}:`, err);
        }
      }

      // If this reply answers an AI-initiated handoff (requestHuman) that's
      // still waiting, close the loop for the "tempo até a primeira
      // resposta" metric (Fase 4) — best-effort, never blocks the send.
      try {
        const openHandoff = await getOpenHandoffEvent(db, conversation_id);
        if (openHandoff) {
          await markFirstHumanReply(db, openHandoff.id, new Date().toISOString());
        }
      } catch (err) {
        console.error(`Failed to mark first human reply for conversation ${conversation_id}:`, err);
      }

      // Get instance for sending
      const instance = await getInstanceById(db, conversation.evolution_instance_id);

      // Get contact phone from conversation
      const contact = conversation.wa_contacts;

      // Enqueue send
      await enqueueSendMessage({
        conversationId: conversation_id,
        messageId: message.id,
        instanceId: instance.id,
        phone: contact.phone,
        content,
        organizationId: conversation.organization_id,
      });

      return reply.status(200).send({ ok: true, messageId: message.id });
    },
  });
}
