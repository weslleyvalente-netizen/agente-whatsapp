import { Worker } from "bullmq";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QUEUE_NAMES } from "@aula-agente/shared";
import type { ProcessMessageJobData } from "@aula-agente/queue";
import { getRedisConnection, getSendMessageQueue } from "@aula-agente/queue";
import type { Message } from "@aula-agente/shared";
import {
  getAdminClient,
  getAgentById,
  getRecentMessages,
  getConversationById,
  getLastContactMessage,
} from "@aula-agente/database";
import { createMessage, updateConversation, updateMessageContent, recordAiUsageEvent } from "@aula-agente/database";
import { getInstanceById } from "@aula-agente/database";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock.js";
import { resolveApiKey, resolveElevenLabsApiKey } from "@aula-agente/agent-runtime";
import { runAgent } from "@aula-agente/agent-runtime";
import { transcribeAudioMessage } from "../lib/audio-transcription.js";
import { describeImageMessage } from "../lib/image-description.js";
import { generateSpeech, isSimpleEnoughForAudio } from "../lib/audio-generation.js";
import { isNoOpReply } from "../lib/no-op-reply.js";
import { collectPendingContactMessages, isReplyStillFresh } from "../lib/message-grouping.js";

const AUDIO_DURATION_CAP_SECONDS = 300;
const AUDIO_FALLBACK_TEXT =
  "Desculpa, não consegui entender esse áudio 🙏 Pode escrever a mensagem, por favor?";
const IMAGE_FALLBACK_TEXT =
  "Desculpa, não consegui analisar essa imagem 🙏 Pode me contar em texto o que tem nela?";

async function sendFallbackText(
  db: SupabaseClient,
  text: string,
  params: { conversationId: string; organizationId: string; instanceId: string; phone: string }
) {
  const responseMessage = await createMessage(db, {
    conversation_id: params.conversationId,
    organization_id: params.organizationId,
    evolution_message_id: null,
    role: "agent",
    content: text,
    media_url: null,
    media_type: null,
    metadata: null,
  });

  const sendQueue = getSendMessageQueue();
  await sendQueue.add("send-message", {
    conversationId: params.conversationId,
    messageId: responseMessage.id,
    instanceId: params.instanceId,
    phone: params.phone,
    content: text,
    organizationId: params.organizationId,
  });
}

export function startProcessMessageWorker() {
  const worker = new Worker<ProcessMessageJobData>(
    QUEUE_NAMES.PROCESS_MESSAGE,
    async (job) => {
      // messageId in job.data is only the message that triggered this
      // particular enqueue call — with deduplication+replace (see
      // apps/api/src/lib/queue.ts) it's whichever message was most recent
      // when the debounced job was scheduled, not necessarily everything
      // that ends up in the batch. The batch itself is always re-derived
      // from the DB below (collectPendingContactMessages), never from this.
      const { conversationId, agentId, organizationId } = job.data;

      // Acquire conversation lock
      const lockValue = await acquireConversationLock(conversationId);
      if (!lockValue) {
        throw new Error(`Failed to acquire lock for conversation ${conversationId}`);
      }

      try {
        const db = getAdminClient();

        // Load agent config
        const agent = await getAgentById(db, agentId);
        if (!agent.is_active) {
          console.log(`Agent ${agentId} is inactive, skipping`);
          return;
        }

        // Check if still not in human takeover
        const conversation = await getConversationById(db, conversationId);
        if (conversation.is_human_takeover) {
          console.log(`Conversation ${conversationId} is in human takeover, skipping`);
          return;
        }
        if (conversation.wa_contacts?.ai_disabled) {
          console.log(`Conversation ${conversationId} contact has AI permanently disabled, skipping`);
          return;
        }

        // Load instance now — needed both by agent tools (to send a photo
        // mid-turn) and further down to send the text reply.
        const instance = await getInstanceById(db, conversation.evolution_instance_id);
        const phone = conversation.wa_contacts?.phone || "";

        // Resolve API key for this tenant
        const apiKey = await resolveApiKey(organizationId, agent.provider);

        // Load recent message history
        const recentMessages = await getRecentMessages(db, conversationId, 20);

        // Every contact message since our last reply is one turn — the
        // upstream debounce (apps/api/src/lib/queue.ts, ~6s after the
        // customer's last message) means there may be several by the time
        // this job runs. An empty batch means a stray/duplicate run found
        // nothing left to answer (see collectPendingContactMessages'
        // idempotency note in apps/worker/src/lib/message-grouping.ts) —
        // safe to just stop, this is not an error.
        const pendingMessages = collectPendingContactMessages(recentMessages);
        if (pendingMessages.length === 0) {
          console.log(`No pending contact messages for conversation ${conversationId}, skipping`);
          return;
        }

        // Voice notes and photos need per-message preprocessing
        // (transcription / image description) before anything gets combined
        // into one turn — same logic as before, now looped over the batch.
        // A single failure aborts the whole batch with a fallback text, same
        // as the old single-message behavior; a partial-batch continuation
        // isn't worth the complexity for what's a rare failure path.
        const effectiveMessages: Message[] = [];
        for (const message of pendingMessages) {
          let effectiveContent = message.content;

          // Voice notes arrive with a "[audio]" placeholder — transcribe it
          // to real text before the agent ever sees it. This runs here (not
          // in the webhook) so the webhook keeps acking Evolution fast
          // regardless of transcription latency. Any failure (missing key,
          // fetch error, transcription error, empty transcript, or too-long
          // audio) sends a fixed "please type instead" reply and skips the
          // LLM entirely.
          if (message.media_type === "audio") {
            const durationSeconds = message.metadata?.duration_seconds;

            if (typeof durationSeconds === "number" && durationSeconds > AUDIO_DURATION_CAP_SECONDS) {
              console.log(`Message ${message.id} audio exceeds ${AUDIO_DURATION_CAP_SECONDS}s cap, skipping transcription`);
              await sendFallbackText(db, AUDIO_FALLBACK_TEXT, {
                conversationId,
                organizationId,
                instanceId: instance.id,
                phone,
              });
              return;
            }

            const transcription = await transcribeAudioMessage({
              instanceName: instance.instance_name,
              evolutionMessageId: message.evolution_message_id!,
              organizationId,
            });

            if (!transcription.ok) {
              console.log(`Message ${message.id} transcription failed: ${transcription.reason}`);
              await sendFallbackText(db, AUDIO_FALLBACK_TEXT, {
                conversationId,
                organizationId,
                instanceId: instance.id,
                phone,
              });
              return;
            }

            effectiveContent = `🎤 ${transcription.text}`;
            await updateMessageContent(db, message.id, effectiveContent);
          }

          // Photos arrive with a "[imagem]" placeholder (or just the
          // caption, if the customer wrote one) — describe the actual image
          // content before the agent ever sees it, same reasoning as audio
          // above. Guarded with the "📷 " prefix check so a BullMQ retry
          // (attempts: 3 on this queue — see packages/queue/src/queues.ts)
          // doesn't re-run the vision call against the already-described
          // content.
          if (message.media_type === "image" && !message.content.startsWith("📷 ")) {
            const caption = message.content === "[imagem]" ? undefined : message.content;

            const description = await describeImageMessage({
              instanceName: instance.instance_name,
              evolutionMessageId: message.evolution_message_id!,
              caption,
              provider: agent.provider,
              model: agent.model,
              apiKey,
            });

            // Best-effort: a vision call happened (and cost money) whenever
            // `usage` is present, even on the "empty_description" failure
            // path — only the "image_too_large" and fetch/timeout paths
            // skip the LLM entirely and have no usage to log.
            if (description.usage) {
              recordAiUsageEvent(db, {
                organizationId,
                agentId: agent.id,
                source: "image_description",
                model: agent.model,
                inputTokens: description.usage.inputTokens,
                outputTokens: description.usage.outputTokens,
                cacheReadTokens: description.usage.cacheReadTokens,
                cacheWriteTokens: description.usage.cacheWriteTokens,
              }).catch((err) => console.error("[process-message] failed to record ai_usage_event", err));
            }

            if (!description.ok) {
              console.log(`Message ${message.id} image description failed: ${description.reason}`);
              await sendFallbackText(db, IMAGE_FALLBACK_TEXT, {
                conversationId,
                organizationId,
                instanceId: instance.id,
                phone,
              });
              return;
            }

            effectiveContent = caption ? `📷 ${description.text}\n\n${caption}` : `📷 ${description.text}`;
            await updateMessageContent(db, message.id, effectiveContent);
          }

          // Unsupported WhatsApp message types (reactions, protocol
          // messages, etc.) are saved with empty content — the LLM can't
          // process those, exclude them from the batch.
          if (effectiveContent.trim()) {
            effectiveMessages.push({ ...message, content: effectiveContent });
          } else {
            console.log(`Message ${message.id} has empty content, excluding from batch`);
          }
        }

        if (effectiveMessages.length === 0) {
          console.log(`Batch for conversation ${conversationId} had no processable content, skipping`);
          return;
        }

        // The synthetic turn the agent responds to: every bubble folded
        // into one message, oldest first, so order is preserved exactly as
        // the customer sent it. Only role/content reach the LLM
        // (buildFinalTurnMessage in agent-runtime) — the last real
        // message's media_type is read further below to decide whether an
        // audio reply makes sense (mirroring the customer's own modality).
        const lastPendingMessage = pendingMessages[pendingMessages.length - 1];
        const batchMessage: Message = {
          ...lastPendingMessage,
          content: effectiveMessages.map((m) => m.content).join("\n"),
        };

        const pendingIds = new Set(pendingMessages.map((m) => m.id));
        const history = recentMessages.filter((m) => !pendingIds.has(m.id));

        // Run the agent
        const result = await runAgent({
          agent,
          messages: history,
          currentMessage: batchMessage,
          apiKey,
          organizationId,
          conversationId,
          instanceId: instance.id,
          phone,
          contactId: conversation.contact_id,
          contactName: conversation.wa_contacts?.name ?? null,
        });

        // Generation can take a while (LLM latency, tool calls). Before
        // acting on the result, re-check reality: a human may have taken
        // over, AI may have been disabled, or the customer may have sent
        // something new that this reply never saw. Sending it now would be
        // wrong in any of those cases — drop it. Nothing is lost: a newer
        // message triggered its own debounced job, which will recompute the
        // full pending batch (collectPendingContactMessages) including
        // whatever this drops.
        const freshConversation = await getConversationById(db, conversationId);
        if (freshConversation.is_human_takeover) {
          console.log(`Conversation ${conversationId} was taken over by a human during generation, dropping reply`);
          return;
        }
        if (freshConversation.wa_contacts?.ai_disabled) {
          console.log(`Conversation ${conversationId} contact had AI disabled during generation, dropping reply`);
          return;
        }
        const latestContact = await getLastContactMessage(db, conversationId);
        if (!isReplyStillFresh(lastPendingMessage.created_at, latestContact?.created_at ?? null)) {
          console.log(`Conversation ${conversationId} has a newer customer message, dropping stale reply`);
          return;
        }

        // Save and send the agent's text reply — skipped if the agent's
        // final text is empty, which now legitimately happens when it only
        // called sendVehiclePhoto and considered the photo itself the
        // complete reply (that tool already saved and enqueued its own
        // message independently of this one). Also skipped when the model
        // wrote a meta-comment like "(sem resposta necessária)" instead of
        // truly empty text — confirmed in production, that placeholder was
        // getting sent straight to the customer.
        if (result.text.trim() && !isNoOpReply(result.text)) {
          // Mirror the customer's own modality: only even attempt audio when
          // they sent audio, the agent has the toggle on, and the reply text
          // itself is simple enough to be understood by ear (no link, no
          // multi-item list). Any failure — toggle off, complex text, or the
          // TTS call itself failing — falls through to the plain text send
          // below exactly like it always has.
          let audioBase64: string | undefined;
          if (
            agent.tools_config.audio_replies &&
            lastPendingMessage.media_type === "audio" &&
            isSimpleEnoughForAudio(result.text)
          ) {
            const elevenLabsApiKey = await resolveElevenLabsApiKey(organizationId);
            const speech = await generateSpeech({
              text: result.text,
              voice: agent.tools_config.audio_voice,
              apiKey: elevenLabsApiKey,
            });
            if (speech.ok) {
              audioBase64 = speech.audioBase64;
            } else {
              console.log(`Batch ending in message ${lastPendingMessage.id} audio generation failed, falling back to text: ${speech.reason}`);
            }
          }

          const responseMessage = await createMessage(db, {
            conversation_id: conversationId,
            organization_id: organizationId,
            evolution_message_id: null,
            role: "agent",
            content: result.text,
            media_url: null,
            media_type: audioBase64 ? "audio" : null,
            metadata: {
              model: result.model,
              input_tokens: result.inputTokens,
              output_tokens: result.outputTokens,
              cache_read_tokens: result.cacheReadTokens,
              cache_write_tokens: result.cacheWriteTokens,
              cache_status: result.cacheStatus,
              latency_ms: result.latencyMs,
              tool_calls: result.toolCalls,
            },
          });

          const sendQueue = getSendMessageQueue();
          await sendQueue.add("send-message", {
            conversationId,
            messageId: responseMessage.id,
            instanceId: instance.id,
            phone,
            content: result.text,
            organizationId,
            ...(audioBase64 ? { audioBase64 } : {}),
          });

          console.log(`Processed ${pendingMessages.length} message(s) ending in ${lastPendingMessage.id} -> response ${responseMessage.id}`);
        } else {
          if (result.text.trim()) {
            console.log(`Processed ${pendingMessages.length} message(s) ending in ${lastPendingMessage.id} -> suppressed no-op placeholder reply: "${result.text}"`);
          } else {
            console.log(`Processed ${pendingMessages.length} message(s) ending in ${lastPendingMessage.id} -> no text reply (tool-only response)`);
          }
        }

        // Update conversation
        await updateConversation(db, conversationId, {
          last_message_at: new Date().toISOString(),
          status: "waiting",
        });
      } finally {
        await releaseConversationLock(conversationId, lockValue);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`Job ${job?.id} failed:`, err.message);
  });

  console.log("Process-message worker started");
  return worker;
}
