import { UnrecoverableError, Worker, type Job } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import {
  getChatMediaRetentionQueue,
  getRedisConnection,
  type ChatMediaRetentionJobData,
  type StoreChatMediaJobData,
} from "@aula-agente/queue";
import { getAdminClient, mergeMessageMetadata } from "@aula-agente/database";
import { runChatMediaRetention, storeChatMedia } from "../lib/chat-media.js";

const RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;

/** Captura de imagem/vídeo/documento do cliente. Lança em falha para o BullMQ repetir (attempts/backoff da fila). */
export function startStoreChatMediaWorker() {
  const worker = new Worker<StoreChatMediaJobData>(
    QUEUE_NAMES.STORE_CHAT_MEDIA,
    async (job: Job<StoreChatMediaJobData>) => {
      const result = await storeChatMedia(getAdminClient(), job.data);
      if (!result.ok) {
        const message = `store-chat-media ${job.data.messageId}: ${result.reason}`;
        // Falha permanente: não gasta retentativas.
        throw result.permanent ? new UnrecoverableError(message) : new Error(message);
      }
    },
    { connection: getRedisConnection(), concurrency: 3 }
  );
  worker.on("failed", (job, err) => {
    const final = !!job && (err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1));
    console.error(`Store chat media job ${job?.id} failed${final ? " (final)" : ""}:`, err.message);
    if (final && job) {
      mergeMessageMetadata(getAdminClient(), job.data.messageId, { media: { status: "failed" } }).catch((e: unknown) =>
        console.error(`Store chat media: could not mark ${job.data.messageId} as failed:`, e instanceof Error ? e.message : e)
      );
    }
  });
  console.log("Store-chat-media worker started");
  return worker;
}

/** Retenção de 30 dias, uma vez por dia. */
export function startChatMediaRetentionWorker() {
  const worker = new Worker<ChatMediaRetentionJobData>(
    QUEUE_NAMES.CHAT_MEDIA_RETENTION,
    async () => {
      const { deleted } = await runChatMediaRetention(getAdminClient());
      if (deleted > 0) console.log(`Chat media retention: ${deleted} arquivo(s) apagado(s)`);
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
  getChatMediaRetentionQueue().upsertJobScheduler(
    "chat-media-retention-scheduler",
    { every: RETENTION_EVERY_MS },
    { name: "sweep-chat-media-retention" }
  );
  worker.on("failed", (job, err) => console.error(`Chat media retention job ${job?.id} failed:`, err.message));
  console.log("Chat-media-retention worker started (runs daily)");
  return worker;
}
