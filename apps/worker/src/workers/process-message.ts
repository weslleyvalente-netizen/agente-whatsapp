import { Worker } from "bullmq";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QUEUE_NAMES } from "@aula-agente/shared";
import type { ProcessMessageJobData } from "@aula-agente/queue";
import { getRedisConnection, getSendMessageQueue } from "@aula-agente/queue";
import { getAdminClient, getAgentById, getRecentMessages, getConversationById } from "@aula-agente/database";
import { createMessage, updateConversation, updateMessageContent } from "@aula-agente/database";
import { getInstanceById } from "@aula-agente/database";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock.js";
import { resolveApiKey } from "../lib/vault.js";
import { runAgent } from "../agents/agent-runner.js";
import { transcribeAudioMessage } from "../lib/audio-transcription.js";

const AUDIO_DURATION_CAP_SECONDS = 300;
const AUDIO_FALLBACK_TEXT =
  "Desculpa, não consegui entender esse áudio 🙏 Pode escrever a mensagem, por favor?";

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
      const { conversationId, messageId, agentId, organizationId } = job.data;

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

        // Load instance now — needed both by agent tools (to send a photo
        // mid-turn) and further down to send the text reply.
        const instance = await getInstanceById(db, conversation.evolution_instance_id);
        const phone = conversation.wa_contacts?.phone || "";

        // Resolve API key for this tenant
        const apiKey = await resolveApiKey(organizationId, agent.provider);

        // Load recent message history
        const recentMessages = await getRecentMessages(db, conversationId, 20);

        // Find the current message
        const currentMessage = recentMessages.find((m) => m.id === messageId);
        if (!currentMessage) {
          throw new Error(`Message ${messageId} not found`);
        }

        // Unsupported WhatsApp message types (reactions, protocol messages, etc.)
        // are saved with empty content — the LLM can't process those, skip them.
        if (!currentMessage.content.trim()) {
          console.log(`Message ${messageId} has empty content, skipping`);
          return;
        }

        // Voice notes arrive with a "[audio]" placeholder — transcribe it to
        // real text before the agent ever sees it. This runs here (not in
        // the webhook) so the webhook keeps acking Evolution fast regardless
        // of transcription latency. Any failure (missing key, fetch error,
        // transcription error, empty transcript, or too-long audio) sends a
        // fixed "please type instead" reply and skips the LLM entirely.
        let effectiveMessage = currentMessage;

        if (currentMessage.media_type === "audio") {
          const durationSeconds = currentMessage.metadata?.duration_seconds;

          if (typeof durationSeconds === "number" && durationSeconds > AUDIO_DURATION_CAP_SECONDS) {
            console.log(`Message ${messageId} audio exceeds ${AUDIO_DURATION_CAP_SECONDS}s cap, skipping transcription`);
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
            evolutionMessageId: currentMessage.evolution_message_id!,
            organizationId,
          });

          if (!transcription.ok) {
            console.log(`Message ${messageId} transcription failed: ${transcription.reason}`);
            await sendFallbackText(db, AUDIO_FALLBACK_TEXT, {
              conversationId,
              organizationId,
              instanceId: instance.id,
              phone,
            });
            return;
          }

          const transcribedContent = `🎤 ${transcription.text}`;
          await updateMessageContent(db, currentMessage.id, transcribedContent);
          effectiveMessage = { ...currentMessage, content: transcribedContent };
        }

        // Remove current message from history
        const history = recentMessages.filter((m) => m.id !== messageId);

        // Run the agent
        const result = await runAgent({
          agent,
          messages: history,
          currentMessage: effectiveMessage,
          apiKey,
          organizationId,
          conversationId,
          instanceId: instance.id,
          phone,
        });

        // Save and send the agent's text reply — skipped if the agent's
        // final text is empty, which now legitimately happens when it only
        // called sendVehiclePhoto and considered the photo itself the
        // complete reply (that tool already saved and enqueued its own
        // message independently of this one).
        if (result.text.trim()) {
          const responseMessage = await createMessage(db, {
            conversation_id: conversationId,
            organization_id: organizationId,
            evolution_message_id: null,
            role: "agent",
            content: result.text,
            media_url: null,
            media_type: null,
            metadata: {
              model: result.model,
              input_tokens: result.inputTokens,
              output_tokens: result.outputTokens,
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
          });

          console.log(`Processed message ${messageId} -> response ${responseMessage.id}`);
        } else {
          console.log(`Processed message ${messageId} -> no text reply (tool-only response)`);
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
