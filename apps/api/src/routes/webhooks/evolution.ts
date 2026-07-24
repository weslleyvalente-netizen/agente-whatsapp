import type { FastifyInstance } from "fastify";
import { evolutionWebhookPayloadSchema } from "@aula-agente/shared";
import { getAdminClient, getInstanceByInstanceId, updateConversation } from "@aula-agente/database";
import { webhookVerifyMiddleware } from "../../middleware/webhook-verify.js";
import { ensureConversation } from "../../services/conversation.service.js";
import { saveMessage } from "../../services/message.service.js";
import { enqueueProcessMessage } from "../../lib/queue.js";
import { syncContactToCrm } from "../../integrations/crm-sync.js";

// Every path through this function must return non-empty content: it's
// stored as message text and later replayed verbatim into the Anthropic
// Messages API, which rejects the entire request if any message in the
// conversation has empty content — one empty-content row anywhere in the
// last 20 messages permanently blocks every future agent reply in that
// conversation (verified live against a real stuck conversation).
const UNSUPPORTED_MESSAGE_PLACEHOLDER = "[mensagem não suportada]";

export function extractMessageContent(data: Record<string, unknown>): { content: string; mediaType: string | null; durationSeconds?: number } {
  const message = data.message as Record<string, unknown> | undefined;
  const messageType = data.messageType as string;

  if (!message) return { content: UNSUPPORTED_MESSAGE_PLACEHOLDER, mediaType: null };

  switch (messageType) {
    case "conversation":
      return { content: (message.conversation as string) || UNSUPPORTED_MESSAGE_PLACEHOLDER, mediaType: null };
    case "imageMessage":
      return {
        content: (message.imageMessage as Record<string, string>)?.caption || "[imagem]",
        mediaType: "image",
      };
    case "audioMessage": {
      const audio = message.audioMessage as Record<string, unknown> | undefined;
      const seconds = typeof audio?.seconds === "number" ? audio.seconds : undefined;
      return { content: "[audio]", mediaType: "audio", durationSeconds: seconds };
    }
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
      return { content: UNSUPPORTED_MESSAGE_PLACEHOLDER, mediaType: null };
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

      // Ignore group messages — this agent only handles direct conversations
      if (payload.data.key.remoteJid.endsWith("@g.us")) {
        return reply.status(200).send({ ok: true, skipped: "group_message" });
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

      // Extract message content
      const { content, mediaType, durationSeconds } = extractMessageContent(payload.data as Record<string, unknown>);

      if (payload.data.key.fromMe) {
        // A human replied directly from the connected phone or WhatsApp Web
        // (not through our inbox) — record it and take the conversation
        // over exactly like a manual inbox reply does, so the agent stops
        // auto-replying to the same customer. We don't know which dashboard
        // user sent it (there's no dashboard session here), so assigned_to
        // stays unset — it can still be assigned manually afterward.
        const humanMessage = await saveMessage({
          conversationId: conversation.id,
          organizationId,
          evolutionMessageId,
          role: "human_agent",
          content,
          mediaType: mediaType as any,
        });

        if (!humanMessage) {
          return reply.status(200).send({ ok: true, skipped: "duplicate" });
        }

        if (!conversation.is_human_takeover) {
          await updateConversation(getAdminClient(), conversation.id, {
            is_human_takeover: true,
            human_takeover_at: new Date().toISOString(),
          });
        }

        if (isNew) {
          await syncContactToCrm(contact);
        }

        return reply.status(200).send({ ok: true, messageId: humanMessage.id, source: "fromMe" });
      }

      // Save message (with idempotency)
      const message = await saveMessage({
        conversationId: conversation.id,
        organizationId,
        evolutionMessageId,
        role: "contact",
        content,
        mediaType: mediaType as any,
        metadata: durationSeconds !== undefined ? { duration_seconds: durationSeconds } : undefined,
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

      // Best-effort: mirror brand-new contacts into the CRM. Never blocks
      // or fails the webhook — errors are swallowed inside syncContactToCrm.
      if (isNew) {
        await syncContactToCrm(contact);
      }

      return reply.status(200).send({ ok: true, messageId: message.id });
    },
  });
}
