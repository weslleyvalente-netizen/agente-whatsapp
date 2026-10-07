import type { FastifyInstance } from "fastify";
import {
  evolutionWebhookPayloadSchema,
  identifyLeadOrigin,
  resolveGreetingFilterConfig,
  isGreetingOrShortConfirmation,
  matchPendingOutboundMessage,
} from "@aula-agente/shared";
import type { GreetingFilterConfig } from "@aula-agente/shared";
import {
  getAdminClient,
  resolveUnresponsiveTasksOnReply,
  getInstanceByInstanceId,
  updateConversation,
  getIgnoredContact,
  createHandoffEvent,
  getOrganizationById,
  getOpenHandoffEvent,
  markFirstHumanReply,
  findPendingOutboundMessages,
  setMessageEvolutionId,
} from "@aula-agente/database";
import { webhookVerifyMiddleware } from "../../middleware/webhook-verify.js";
import { ensureConversation } from "../../services/conversation.service.js";
import { saveMessage } from "../../services/message.service.js";
import { handleConversationTakeover } from "../../services/task.service.js";
import { enqueueProcessMessage } from "../../lib/queue.js";
import { trackFirstHumanMessage } from "../../services/lead-human-message.js";
import { recordLeadOrigin } from "../../services/lead-origin.service.js";
import { syncContactToCrm } from "../../integrations/crm-sync.js";

// A placeholder saved instead of real content for an ignored contact's
// message under retention_mode "minimal_record" — proves traffic still
// arrives without storing anything the contact actually said.
const IGNORED_CONTACT_PLACEHOLDER = "[mensagem de contato ignorado]";

// Echo race guard (see matchPendingOutboundMessage): how far back to look
// for one of OUR OWN outbound messages still waiting for its
// evolution_message_id backfill. Generous enough to cover normal network/
// worker latency, tight enough to not casually match an unrelated later
// message with the same text.
const PENDING_ECHO_MATCH_WINDOW_MS = 2 * 60 * 1000;

// Pure decision extracted for testing (see evolution.test.ts): a fromMe
// message only skips activating takeover when it's both the start of a new
// episode (isFirstTakeover) AND a configured greeting/short confirmation —
// a human already mid-conversation always keeps refreshing the timeout,
// regardless of what they type.
export function shouldSkipTakeoverForGreeting(
  content: string,
  isFirstTakeover: boolean,
  config: GreetingFilterConfig
): boolean {
  return isFirstTakeover && isGreetingOrShortConfirmation(content, config);
}

// Every path through this function must return non-empty content: it's
// stored as message text and later replayed verbatim into the Anthropic
// Messages API, which rejects the entire request if any message in the
// conversation has empty content — one empty-content row anywhere in the
// last 20 messages permanently blocks every future agent reply in that
// conversation (verified live against a real stuck conversation).
const UNSUPPORTED_MESSAGE_PLACEHOLDER = "[mensagem não suportada]";

// Emoji reactions and message-deletion events aren't customer content — they
// carry no text the agent should ever see. Left unfiltered, they'd fall
// through extractByType's default case to UNSUPPORTED_MESSAGE_PLACEHOLDER
// (a non-empty string, by design — see above) which the LLM then tries to
// respond to (confirmed live: a customer reacting with an emoji got "não
// consegui abrir esse arquivo" back). Checked before saving or enqueueing,
// same as the group-message check.
const NON_CONTENT_MESSAGE_TYPES = new Set(["reactionMessage", "protocolMessage"]);

export function isNonContentMessageType(messageType: string): boolean {
  return NON_CONTENT_MESSAGE_TYPES.has(messageType);
}

// Click-to-WhatsApp ads (Meta/Instagram) attach the ad's title and body as
// data.contextInfo.externalAdReply — a sibling of data.message, not nested
// inside it. WhatsApp's own pre-filled greeting for the customer ("Oi! Vim
// do anúncio do Libera Cred!") lives here too, but the text the customer
// actually sends is often a generic fallback like "Olá! Posso ter mais
// informações sobre isso?" — "isso" meaning nothing without this context.
// Verified against a real webhook delivery via Evolution's own
// /chat/findMessages endpoint. Without this, the agent has no way to know
// which product the customer is even asking about.
function extractAdContextPrefix(data: Record<string, unknown>): string {
  const contextInfo = data.contextInfo as Record<string, unknown> | undefined;
  const externalAdReply = contextInfo?.externalAdReply as Record<string, unknown> | undefined;
  if (!externalAdReply) return "";

  const title = externalAdReply.title as string | undefined;
  const body = externalAdReply.body as string | undefined;
  if (!title && !body) return "";

  const details = [title, body].filter(Boolean).join(" — ");
  return `[Cliente veio de um anúncio: ${details}]\n`;
}

function extractByType(
  message: Record<string, unknown> | undefined,
  messageType: string
): { content: string; mediaType: string | null; durationSeconds?: number } {
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

export function extractMessageContent(data: Record<string, unknown>): { content: string; mediaType: string | null; durationSeconds?: number } {
  const message = data.message as Record<string, unknown> | undefined;
  const messageType = data.messageType as string;

  const extracted = extractByType(message, messageType);
  const adPrefix = extractAdContextPrefix(data);
  return adPrefix ? { ...extracted, content: `${adPrefix}${extracted.content}` } : extracted;
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

      if (isNonContentMessageType(payload.data.messageType)) {
        return reply.status(200).send({ ok: true, skipped: "non_content_message_type" });
      }

      const instanceId = payload.instance;
      const evolutionMessageId = payload.data.key.id;
      const phone = payload.data.key.remoteJid.replace("@s.whatsapp.net", "");
      // For a fromMe delivery (human replying directly from the connected
      // phone), pushName is the connected WhatsApp account's own profile
      // name, not the customer's — passing it through here overwrote the
      // customer's real contact name with the attendant's own name on
      // every manual reply. null is safe: upsertContact already falls
      // back to whatever name is already on file when name is null.
      const contactName = payload.data.key.fromMe ? null : payload.data.pushName || null;

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

      // Contatos ignorados (Fase 1): a number the organization explicitly
      // told the system to ignore — e.g. a third party's own WhatsApp bot
      // that ended up being messaged from the connected number and got
      // mistaken for a lead (see docs/diagnostico-fase0.md, seção 1.1).
      // Checked before anything is written, for both directions of traffic.
      // Fails open (treated as "not ignored") on any lookup error — e.g. the
      // migration for organization_ignored_contacts not deployed yet must
      // never take down message processing for every other contact.
      let ignoredContact: Awaited<ReturnType<typeof getIgnoredContact>> = null;
      try {
        ignoredContact = await getIgnoredContact(getAdminClient(), organizationId, phone);
      } catch (err) {
        request.log.error({ err, organizationId }, "Failed to check ignored contacts — processing normally");
      }
      if (ignoredContact && ignoredContact.retention_mode === "no_store") {
        return reply.status(200).send({ ok: true, skipped: "ignored_contact" });
      }

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
      const extracted = extractMessageContent(payload.data as Record<string, unknown>);
      // retention_mode "minimal_record": keep a row proving traffic arrived,
      // but never the real content, and never touch takeover/tasks/AI below.
      const isIgnoredMinimalRecord = ignoredContact?.retention_mode === "minimal_record";
      const content = isIgnoredMinimalRecord ? IGNORED_CONTACT_PLACEHOLDER : extracted.content;
      const mediaType = isIgnoredMinimalRecord ? null : extracted.mediaType;
      const durationSeconds = isIgnoredMinimalRecord ? undefined : extracted.durationSeconds;

      if (!payload.data.key.fromMe && !isIgnoredMinimalRecord) {
        const context = payload.data.contextInfo;
        const message = payload.data.message as Record<string, unknown> | null | undefined;
        const nested = message?.extendedTextMessage as { contextInfo?: { externalAdReply?: Record<string, unknown> } } | undefined;
        const origin = identifyLeadOrigin({ text: extracted.content, ad: context?.externalAdReply ?? nested?.contextInfo?.externalAdReply });
        try {
          await recordLeadOrigin(getAdminClient(), organizationId, contact.id, origin);
        } catch (err) {
          request.log.error({ err, contactId: contact.id }, "Failed to record lead origin");
        }
      }

      if (payload.data.key.fromMe) {
        const db = getAdminClient();

        // Echo race guard: this fromMe echo might be OUR OWN outbound
        // message (Helena's own reply, a manual panel send, or a Task
        // follow-up) arriving before the send-message worker backfilled its
        // real evolution_message_id — in which case messageExistsByEvolutionId
        // inside saveMessage below can't recognize it yet. Match it here by
        // conversation + content/media_type within a short recent window
        // instead, so it's treated as already-recorded (skip everything,
        // same as an exact id match) rather than a brand-new human-initiated
        // message that would wrongly re-activate takeover or duplicate the row.
        if (!isIgnoredMinimalRecord) {
          const sinceISO = new Date(Date.now() - PENDING_ECHO_MATCH_WINDOW_MS).toISOString();
          const pendingCandidates = await findPendingOutboundMessages(db, conversation.id, sinceISO);
          const matched = matchPendingOutboundMessage(pendingCandidates, { mediaType, content });
          if (matched) {
            await setMessageEvolutionId(db, matched.id, evolutionMessageId);
            return reply.status(200).send({ ok: true, skipped: "duplicate", messageId: matched.id });
          }
        }

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

        const isFirstTakeover = !conversation.is_human_takeover;

        // A message to/from an ignored contact never activates takeover or
        // touches tasks, regardless of content — same reasoning as no_store,
        // just with the row kept for retention_mode "minimal_record".
        if (isIgnoredMinimalRecord) {
          return reply.status(200).send({ ok: true, messageId: humanMessage.id, source: "fromMe" });
        }

        // Fase 1 (handoff explícito): a short greeting/confirmation
        // ("Bom dia") that starts a NEW episode does not activate takeover —
        // it's saved and sent to the model like any human_agent message
        // (see the "Notas operacionais" section of the compiled prompt),
        // but doesn't silence the AI for the rest of the conversation. Once
        // a real takeover is already active, any fromMe message keeps
        // refreshing the timeout as before, regardless of content.
        const org = await getOrganizationById(db, organizationId);
        const greetingFilterConfig = resolveGreetingFilterConfig(org.settings);
        const skipTakeover = shouldSkipTakeoverForGreeting(content, isFirstTakeover, greetingFilterConfig);

        await trackFirstHumanMessage(db, {
          organizationId,
          conversationId: conversation.id,
          role: "human_agent",
          source: "phone_echo",
          metadata: null,
          greetingFiltered: skipTakeover,
        });

        if (skipTakeover) {
          try {
            await createHandoffEvent(db, {
              organization_id: organizationId,
              conversation_id: conversation.id,
              trigger_type: "fromMe_greeting_filtered",
              criado_por: "humano",
            });
          } catch (err) {
            request.log.error({ err, conversationId: conversation.id }, "Failed to record fromMe_greeting_filtered handoff event");
          }
        } else {
          // Always refresh human_takeover_at, even if already in takeover —
          // the auto-expiry timer (HUMAN_TAKEOVER_TIMEOUT_MS) counts from this
          // timestamp, so leaving it frozen at the first reply let the agent
          // resume mid-conversation after 30 minutes even while the human was
          // still actively replying every few minutes.
          await updateConversation(db, conversation.id, {
            is_human_takeover: true,
            human_takeover_at: new Date().toISOString(),
          });

          // Same reasoning as messages/send.ts: a human replying (even
          // directly from their phone) means they're now handling whatever
          // this conversation's open task was tracking — reassign it, don't
          // close it out. No dashboard user to attribute it to here, so
          // actorId is null.
          if (isFirstTakeover) {
            try {
              await handleConversationTakeover(db, organizationId, conversation.id, null);
            } catch (err) {
              request.log.error({ err, conversationId: conversation.id }, "Failed to reassign task on fromMe takeover");
            }
            try {
              await createHandoffEvent(db, {
                organization_id: organizationId,
                conversation_id: conversation.id,
                trigger_type: "fromMe_real",
                criado_por: "humano",
              });
            } catch (err) {
              request.log.error({ err, conversationId: conversation.id }, "Failed to record fromMe_real handoff event");
            }
          }

          // If this reply answers an AI-initiated handoff (requestHuman)
          // still waiting, close the loop for the "tempo até a primeira
          // resposta" metric (Fase 4) — regardless of isFirstTakeover, since
          // requestHuman already set is_human_takeover=true before the
          // human's own first reply arrives here.
          try {
            const openHandoff = await getOpenHandoffEvent(db, conversation.id);
            if (openHandoff) {
              await markFirstHumanReply(db, openHandoff.id, new Date().toISOString());
            }
          } catch (err) {
            request.log.error({ err, conversationId: conversation.id }, "Failed to mark first human reply");
          }
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

      // Ignored contact (retention_mode "minimal_record"): row kept, but
      // never enqueued for the AI and never synced to the CRM.
      if (isIgnoredMinimalRecord) {
        return reply.status(200).send({ ok: true, messageId: message.id, skipped: "ignored_contact" });
      }

      // Independent of AI execution: a real customer reply resolves prior silence.
      try {
        await resolveUnresponsiveTasksOnReply(getAdminClient(), {
          organizationId, contactId: contact.id, conversationId: conversation.id,
          role: message.role, createdAt: message.created_at, messageId: message.id,
        });
      } catch (err) {
        request.log.error({ err, conversationId: conversation.id }, "Failed to resolve unresponsive tasks after customer reply");
      }

      // If human takeover is active, don't enqueue for LLM processing
      if (conversation.is_human_takeover) {
        return reply.status(200).send({ ok: true, skipped: "human_takeover" });
      }

      // Contact has AI permanently disabled ("Desativar IA permanentemente"
      // in the inbox) — never enqueue for LLM processing, regardless of
      // takeover state.
      if (contact.ai_disabled) {
        return reply.status(200).send({ ok: true, skipped: "ai_disabled" });
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
