import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdminClient, createMessage, updateConversation } from "@aula-agente/database";
import { webhookVerifyMiddleware } from "../../middleware/webhook-verify.js";
import { enqueueSendMessage } from "../../lib/queue.js";

// TEMPORARY, one-off use: correcting two real leads (Geovane, Lucas) whose
// conversations opened with a question they'd already answered on the Wix
// form, because the manual replay of their submissions (after fixing the
// wix-lead webhook bug) didn't carry interest/budget. Sends as role "agent"
// (not human_agent), so it doesn't flip the conversation into human
// takeover. Remove this route once those two messages are sent.
const bodySchema = z.object({ phone: z.string().min(1), text: z.string().min(1) });

export default async function adminSendOnceRoutes(app: FastifyInstance) {
  app.post("/webhooks/admin-send-once", {
    preHandler: [webhookVerifyMiddleware],
    handler: async (request, reply) => {
      const parseResult = bodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: "Invalid payload" });
      }
      const { phone, text } = parseResult.data;

      const db = getAdminClient();
      const { data: contact } = await db.from("wa_contacts").select("id, organization_id").eq("phone", phone).single();
      if (!contact) return reply.status(404).send({ error: "Contact not found" });

      const { data: conversation } = await db
        .from("conversations")
        .select("id, evolution_instance_id")
        .eq("contact_id", contact.id)
        .single();
      if (!conversation) return reply.status(404).send({ error: "Conversation not found" });

      const message = await createMessage(db, {
        conversation_id: conversation.id,
        organization_id: contact.organization_id,
        evolution_message_id: null,
        role: "agent",
        content: text,
        media_url: null,
        media_type: null,
        metadata: null,
      });

      await enqueueSendMessage({
        conversationId: conversation.id,
        messageId: message.id,
        instanceId: conversation.evolution_instance_id,
        phone,
        content: text,
        organizationId: contact.organization_id,
      });

      await updateConversation(db, conversation.id, { last_message_at: new Date().toISOString() });

      return reply.status(200).send({ ok: true, messageId: message.id });
    },
  });
}
