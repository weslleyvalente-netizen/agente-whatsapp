import type { FastifyInstance } from "fastify";
import { evolutionWebhookPayloadSchema } from "@aula-agente/shared";
import { getAdminClient, getInstanceByInstanceId } from "@aula-agente/database";
import { webhookVerifyMiddleware } from "../../middleware/webhook-verify.js";
import { ensureConversation } from "../../services/conversation.service.js";
import { saveMessage } from "../../services/message.service.js";
import { enqueueProcessMessage } from "../../lib/queue.js";
import { syncContactToCrm } from "../../integrations/crm-sync.js";

function extractMessageContent(data: Record<string, unknown>): { content: string; mediaType: string | null } {
  const message = data.message as Record<string, unknown> | undefined;
  const messageType = data.messageType as string;

  if (!message) return { content: "", mediaType: null };

  switch (messageType) {
    case "conversation":
      return { content: (message.conversation as string) || "", mediaType: null };
    case "imageMessage":
      return {
        content: (message.imageMessage as Record<string, string>)?.caption || "[imagem]",
        mediaType: "image",
      };
    case "audioMessage":
      return { content: "[audio]", mediaType: "audio" };
    case "videoMessage":
      return {
        content: (message.videoMessage as Record<string, string>)?.caption || "[video]",
        mediaType: "video",
      };
    case "documentMessage":
      return {
        content: (message.documentMessage as Record<string, string>)?.fileName || "[documento]",
        mediaType: "document",
      };
    case "stickerMessage":
      return { content: "[sticker]", mediaType: "sticker" };
    case "locationMessage": {
      const loc = message.locationMessage as Record<string, number> | undefined;
      return {
        content: `[location: ${loc?.degreesLatitude}, ${loc?.degreesLongitude}]`,
        mediaType: "location",
      };
    }
    default:
      return { content: "", mediaType: null };
  }
}

export default async function evolutionWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/evolution", {
    preHandler: [webhookVerifyMiddleware],
    handler: async (request, reply) => {
      const parseResult = evolutionWebhookPayloadSchema.safeParse(request.body);

      if (!parseResult.success) {
        request.log.warn({ errors: parseResult.error.issues }, "Invalid webhook payload");
        return reply.status(400).send({ error: "Invalid payload" });
      }

      const payload = parseResult.data;

      // Ignore messages from us
      if (payload.data.key.fromMe) {
        return reply.status(200).send({ ok: true, skipped: "fromMe" });
      }

      const instanceId = payload.instance;
      const evolutionMessageId = payload.data.key.id;
      const phone = payload.data.key.remoteJid.replace("@s.whatsapp.net", "");
      const contactName = payload.data.pushName || null;

      // Look up instance
      let instance;
      try {
        instance = await getInstanceByInstanceId(getAdminClient(), instanceId);
      } catch {
        request.log.warn({ instanceId }, "Unknown Evolution instance");
        return reply.status(200).send({ ok: true, skipped: "unknown_instance" });
      }

      // Check if instance has an active agent
      if (!instance.active_agent_id) {
        request.log.warn({ instanceId }, "Instance has no active agent");
        return reply.status(200).send({ ok: true, skipped: "no_agent" });
      }

      const organizationId = instance.organization_id;
      const agentId = instance.active_agent_id;

      // Ensure conversation exists
      const { conversation, contact, isNew } = await ensureConversation({
        organizationId,
        agentId,
        instanceId: instance.id,
        phone,
        contactName,
        contactPhotoUrl: null,
      });

      // Best-effort: mirror brand-new contacts into the CRM. Never blocks
      // or fails the webhook — errors are swallowed inside syncContactToCrm.
      if (isNew) {
        await syncContactToCrm(contact);
      }

      // Extract message content
      const { content, mediaType } = extractMessageContent(payload.data as Record<string, unknown>);

      // Save message (with idempotency)
      const message = await saveMessage({
        conversationId: conversation.id,
        organizationId,
        evolutionMessageId,
        role: "contact",
        content,
        mediaType: mediaType as any,
      });

      // If message was already processed (duplicate webhook), skip
      if (!message) {
        return reply.status(200).send({ ok: true, skipped: "duplicate" });
      }

      // If human takeover is active, don't enqueue for LLM processing
      if (conversation.is_human_takeover) {
        return reply.status(200).send({ ok: true, skipped: "human_takeover" });
      }

      // Enqueue for LLM processing
      await enqueueProcessMessage({
        conversationId: conversation.id,
        messageId: message.id,
        agentId,
        organizationId,
      });

      return reply.status(200).send({ ok: true, messageId: message.id });
    },
  });
}
