import { Worker } from "bullmq";
import {
  QUEUE_NAMES,
  DEFAULT_FOLLOWUP_AUTOMATICO,
  decideFollowupStage,
  toISODateInTimeZone,
} from "@aula-agente/shared";
import type { StaleConversationFollowupJobData } from "@aula-agente/queue";
import { getRedisConnection, getStaleConversationFollowupQueue, getSendMessageQueue } from "@aula-agente/queue";
import {
  getAdminClient,
  getAllOrganizations,
  getAgentsByOrganization,
  getStaleWaitingConversations,
  getConversationById,
  getRecentMessages,
  getLastContactMessage,
  getOpenTaskByConversation,
  getLatestTaskByConversationAndType,
  getTaskEvents,
  hasOpportunitySignalTask,
  createTaskWithDedup,
  updateTask,
  addTaskEvent,
  createMessage,
} from "@aula-agente/database";
import { resolveApiKey, runAgent } from "@aula-agente/agent-runtime";
import { acquireConversationLock, releaseConversationLock } from "../lib/lock.js";
import { buildFollowupNudgeMessage } from "../lib/followup-nudge.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export function startStaleConversationFollowupWorker() {
  const worker = new Worker<StaleConversationFollowupJobData>(
    QUEUE_NAMES.STALE_CONVERSATION_FOLLOWUP,
    async () => {
      const db = getAdminClient();
      const organizations = await getAllOrganizations(db);
      let sent = 0;

      for (const org of organizations) {
        const agents = await getAgentsByOrganization(db, org.id);

        for (const agent of agents) {
          if (!agent.is_active) continue;

          const followupConfig = agent.tools_config.followup_automatico ?? DEFAULT_FOLLOWUP_AUTOMATICO;
          if (!followupConfig.ativo) continue;

          const cutoffISO = new Date(
            Date.now() - followupConfig.primeiro_followup_horas * 60 * 60 * 1000
          ).toISOString();

          const staleConversations = await getStaleWaitingConversations(db, org.id, agent.id, cutoffISO);

          for (const conversation of staleConversations) {
            const hasSignal = await hasOpportunitySignalTask(db, org.id, conversation.contact_id);
            if (!hasSignal) continue;

            // Correction #1 (see plan's Global Constraints): only the real
            // last message tells us whether Helena is the one waiting.
            const lastMessages = await getRecentMessages(db, conversation.id, 1);
            const lastMessage = lastMessages[0];
            if (!lastMessage || lastMessage.role !== "agent") continue;

            // Correction #2: anchor the two windows to when the customer
            // actually went quiet, not to last_message_at (which Helena's
            // own follow-up sends would otherwise keep bumping forward).
            const lastContact = await getLastContactMessage(db, conversation.id);
            const anchorISO = lastContact?.created_at ?? conversation.created_at;
            const hoursSilent = (Date.now() - new Date(anchorISO).getTime()) / (1000 * 60 * 60);

            const existingTask = await getLatestTaskByConversationAndType(
              db,
              org.id,
              conversation.id,
              "customer_unresponsive"
            );
            const events = existingTask ? await getTaskEvents(db, existingTask.id) : [];
            const stage1AlreadySent = events.some(
              (e) => e.event_type === "auto_followup_stage_1" && e.created_at > anchorISO
            );
            const stage2AlreadySent = events.some(
              (e) => e.event_type === "auto_followup_stage_2" && e.created_at > anchorISO
            );

            const decision = decideFollowupStage({
              hoursSinceCustomerReply: hoursSilent,
              primeiroFollowupHoras: followupConfig.primeiro_followup_horas,
              segundoFollowupHoras: followupConfig.segundo_followup_horas,
              stage1AlreadySent,
              stage2AlreadySent,
            });

            if (decision === "none") continue;

            // Don't pile a followup message on top of an unrelated open task
            // that's already tracking next steps for this conversation — but
            // only before the customer_unresponsive task itself exists;
            // stage 2 always continues the one stage 1 created.
            if (decision === "send_stage_1" && !existingTask) {
              const otherOpenTask = await getOpenTaskByConversation(db, org.id, conversation.id);
              if (otherOpenTask) continue;
            }

            const stage = decision === "send_stage_1" ? 1 : 2;

            const lockValue = await acquireConversationLock(conversation.id);
            if (!lockValue) continue; // being handled by process-message right now — try again next tick

            try {
              const fullConversation = await getConversationById(db, conversation.id);
              const phone = fullConversation.wa_contacts?.phone;
              if (!phone) continue;

              const apiKey = await resolveApiKey(org.id, agent.provider);
              const history = await getRecentMessages(db, conversation.id, 20);
              const nudge = buildFollowupNudgeMessage({
                conversationId: conversation.id,
                organizationId: org.id,
                stage,
                hoursSilent,
              });

              const result = await runAgent({
                agent,
                messages: history,
                currentMessage: nudge,
                apiKey,
                organizationId: org.id,
                conversationId: conversation.id,
                instanceId: fullConversation.evolution_instance_id,
                phone,
                contactId: conversation.contact_id,
                contactName: fullConversation.wa_contacts?.name ?? null,
              });

              if (result.text.trim()) {
                const responseMessage = await createMessage(db, {
                  conversation_id: conversation.id,
                  organization_id: org.id,
                  evolution_message_id: null,
                  role: "agent",
                  content: result.text,
                  media_url: null,
                  media_type: null,
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

                await getSendMessageQueue().add("send-message", {
                  conversationId: conversation.id,
                  messageId: responseMessage.id,
                  instanceId: fullConversation.evolution_instance_id,
                  phone,
                  content: result.text,
                  organizationId: org.id,
                });
              }

              const roundedHours = Math.round(hoursSilent);
              const { task } = await createTaskWithDedup(db, {
                organization_id: org.id,
                contact_id: conversation.contact_id,
                conversation_id: conversation.id,
                type: "customer_unresponsive",
                description:
                  stage === 1
                    ? `Cliente parou de responder há mais de ${roundedHours}h — followup automático enviado.`
                    : `Cliente não respondeu nem à 2ª tentativa automática de followup, após mais de ${roundedHours}h de silêncio.`,
                reason: `Sem resposta há mais de ${roundedHours}h`,
                priority: stage === 1 ? "high" : "urgent",
                due_date: toISODateInTimeZone(new Date()),
                created_by_type: "ai",
                created_by_id: null,
              });

              if (stage === 2) {
                await updateTask(db, task.id, { priority: "urgent" });
              }

              await addTaskEvent(db, {
                task_id: task.id,
                organization_id: org.id,
                event_type: stage === 1 ? "auto_followup_stage_1" : "auto_followup_stage_2",
                note: result.text.trim()
                  ? `Followup automático (tentativa ${stage}) enviado ao cliente.`
                  : `Followup automático (tentativa ${stage}): a IA avaliou o contexto e decidiu não enviar mensagem.`,
                created_by_type: "ai",
                created_by_id: null,
              });

              sent++;
            } finally {
              await releaseConversationLock(conversation.id, lockValue);
            }
          }
        }
      }

      if (sent > 0) {
        console.log(`Sent ${sent} automatic followup message(s)`);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    }
  );

  const queue = getStaleConversationFollowupQueue();
  queue.upsertJobScheduler(
    "stale-conversation-followup-scheduler",
    { every: CHECK_INTERVAL_MS },
    { name: "check-stale-conversations" }
  );

  worker.on("failed", (job, err) => {
    console.error(`Stale-conversation-followup job ${job?.id} failed:`, err.message);
  });

  console.log("Stale-conversation-followup worker started (runs every 15 min)");
  return worker;
}
