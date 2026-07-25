import { Worker } from "bullmq";
import { QUEUE_NAMES, DEFAULT_TASK_RULES, toISODateInTimeZone } from "@aula-agente/shared";
import type { StaleConversationFollowupJobData } from "@aula-agente/queue";
import { getRedisConnection, getStaleConversationFollowupQueue } from "@aula-agente/queue";
import {
  getAdminClient,
  getAllOrganizations,
  getStaleWaitingConversations,
  getOpenTaskByConversation,
  getLatestTaskByConversationAndType,
  hasOpportunitySignalTask,
  createTaskWithDedup,
} from "@aula-agente/database";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export function startStaleConversationFollowupWorker() {
  const worker = new Worker<StaleConversationFollowupJobData>(
    QUEUE_NAMES.STALE_CONVERSATION_FOLLOWUP,
    async () => {
      const db = getAdminClient();
      const organizations = await getAllOrganizations(db);
      let created = 0;

      for (const org of organizations) {
        const staleHours =
          (org.settings as { task_rules?: { stale_conversation_hours?: number } })?.task_rules
            ?.stale_conversation_hours ?? DEFAULT_TASK_RULES.stale_conversation_hours;
        const cutoffISO = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();

        const staleConversations = await getStaleWaitingConversations(db, org.id, cutoffISO);

        for (const conversation of staleConversations) {
          const openTask = await getOpenTaskByConversation(db, org.id, conversation.id);
          if (openTask) continue;

          // Don't re-fire for the same stretch of silence: only create another
          // customer_unresponsive task if the customer has spoken since the last one.
          const priorAutoTask = await getLatestTaskByConversationAndType(
            db,
            org.id,
            conversation.id,
            "customer_unresponsive"
          );
          if (priorAutoTask && conversation.last_message_at <= priorAutoTask.created_at) continue;

          const hasSignal = await hasOpportunitySignalTask(db, org.id, conversation.contact_id);
          if (!hasSignal) continue;

          await createTaskWithDedup(db, {
            organization_id: org.id,
            contact_id: conversation.contact_id,
            conversation_id: conversation.id,
            type: "customer_unresponsive",
            description: `Cliente parou de responder há mais de ${staleHours}h, com sinal de oportunidade em aberto.`,
            reason: `Sem resposta há mais de ${staleHours}h`,
            priority: "high",
            due_date: toISODateInTimeZone(new Date()),
            created_by_type: "ai",
            created_by_id: null,
          });
          created++;
        }
      }

      if (created > 0) {
        console.log(`Created ${created} customer_unresponsive task(s)`);
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
