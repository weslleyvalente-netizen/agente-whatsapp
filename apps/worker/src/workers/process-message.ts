import { Worker } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import type { ProcessMessageJobData } from "@aula-agente/queue";
import { getRedisConnection, getSendMessageQueue } from "@aula-agente/queue";
import { getAdminClient, getAgentById, getRecentMessages, getConversationById } from "@aula-agente/database";
import { createMessage, updateConversation } from "@aula-agente/database";
import { getInstanceById } from "@aula-agente/database";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock";
import { resolveApiKey } from "../lib/vault";
import { runAgent } from "../agents/agent-runner";

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

        // Resolve API key for this tenant
        const apiKey = await resolveApiKey(organizationId, agent.provider);

        // Load recent message history
        const recentMessages = await getRecentMessages(db, conversationId, 20);

        // Find the current message
        const currentMessage = recentMessages.find((m) => m.id === messageId);
        if (!currentMessage) {
          throw new Error(`Message ${messageId} not found`);
        }

        // Remove current message from history
        const history = recentMessages.filter((m) => m.id !== messageId);

        // Run the agent
        const result = await runAgent({
          agent,
          messages: history,
          currentMessage,
          apiKey,
          organizationId,
        });

        // Save agent response
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
            tokens_used: result.tokensUsed,
            latency_ms: result.latencyMs,
            tool_calls: result.toolCalls,
          },
        });

        // Update conversation
        await updateConversation(db, conversationId, {
          last_message_at: new Date().toISOString(),
          status: "waiting",
        });

        // Get instance to send reply
        const instance = await getInstanceById(db, conversation.evolution_instance_id);

        // Enqueue send message
        const sendQueue = getSendMessageQueue();
        await sendQueue.add("send-message", {
          conversationId,
          messageId: responseMessage.id,
          instanceId: instance.id,
          phone: conversation.contacts?.phone || "",
          content: result.text,
          organizationId,
        });

        console.log(`Processed message ${messageId} -> response ${responseMessage.id}`);
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
