import { UnrecoverableError, Worker, type Job } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import {
  getCustomerAudioRetentionQueue,
  getRedisConnection,
  type CustomerAudioRetentionJobData,
  type StoreCustomerAudioJobData,
} from "@aula-agente/queue";
import { getAdminClient } from "@aula-agente/database";
import { runCustomerAudioRetention, storeCustomerAudio } from "../lib/customer-audio.js";

const RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;

/** Captura do áudio do cliente. Lança em falha para o BullMQ repetir (attempts/backoff da fila). */
export function startStoreCustomerAudioWorker() {
  const worker = new Worker<StoreCustomerAudioJobData>(
    QUEUE_NAMES.STORE_CUSTOMER_AUDIO,
    async (job: Job<StoreCustomerAudioJobData>) => {
      const result = await storeCustomerAudio(getAdminClient(), job.data);
      if (!result.ok) {
        const message = `store-customer-audio ${job.data.messageId}: ${result.reason}`;
        // Falha permanente: não gasta retentativas.
        throw result.permanent ? new UnrecoverableError(message) : new Error(message);
      }
    },
    { connection: getRedisConnection(), concurrency: 3 }
  );
  worker.on("failed", (job, err) => {
    const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    console.error(`Store customer audio job ${job?.id} failed${final ? " (final, player mostrará áudio indisponível)" : ""}:`, err.message);
  });
  console.log("Store-customer-audio worker started");
  return worker;
}

/** Retenção de 90 dias, uma vez por dia. */
export function startCustomerAudioRetentionWorker() {
  const worker = new Worker<CustomerAudioRetentionJobData>(
    QUEUE_NAMES.CUSTOMER_AUDIO_RETENTION,
    async () => {
      const { deleted } = await runCustomerAudioRetention(getAdminClient());
      if (deleted > 0) console.log(`Customer audio retention: ${deleted} áudio(s) apagado(s)`);
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
  getCustomerAudioRetentionQueue().upsertJobScheduler(
    "customer-audio-retention-scheduler",
    { every: RETENTION_EVERY_MS },
    { name: "sweep-customer-audio-retention" }
  );
  worker.on("failed", (job, err) => console.error(`Customer audio retention job ${job?.id} failed:`, err.message));
  console.log("Customer-audio-retention worker started (runs daily)");
  return worker;
}
