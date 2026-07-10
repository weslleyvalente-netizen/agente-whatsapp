import { Worker, type Job } from "bullmq";
import { QUEUE_NAMES, HUMAN_TAKEOVER_TIMEOUT_MS } from "@aula-agente/shared";
import type { TakeoverTimeoutJobData } from "@aula-agente/queue";
import { getRedisConnection, getTakeoverTimeoutQueue } from "@aula-agente/queue";
import { getAdminClient, getExpiredTakeovers, updateConversation } from "@aula-agente/database";

export function startTakeoverTimeoutWorker() {
  const worker = new Worker<TakeoverTimeoutJobData>(
    QUEUE_NAMES.TAKEOVER_TIMEOUT,
    async (_job: Job) => {
      const db = getAdminClient();
      const expired = await getExpiredTakeovers(db, HUMAN_TAKEOVER_TIMEOUT_MS);

      for (const conversation of expired) {
        await updateConversation(db, conversation.id, {
          is_human_takeover: false,
          human_takeover_at: null,
        });
        console.log(`Auto-released takeover for conversation ${conversation.id}`);
      }

      if (expired.length > 0) {
        console.log(`Released ${expired.length} expired takeovers`);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    }
  );

  // Schedule repeating job every 5 minutes
  const queue = getTakeoverTimeoutQueue();
  queue.upsertJobScheduler(
    "takeover-timeout-scheduler",
    { every: 5 * 60 * 1000 },
    { name: "check-expired-takeovers" }
  );

  worker.on("failed", (job, err) => {
    console.error(`Takeover timeout job ${job?.id} failed:`, err.message);
  });

  console.log("Takeover-timeout worker started (runs every 5 min)");
  return worker;
}
