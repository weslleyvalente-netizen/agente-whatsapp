import { Worker, type Job } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import { getRedisConnection, type FetchProfilePictureJobData } from "@aula-agente/queue";
import { getAdminClient } from "@aula-agente/database";
import { fetchContactProfilePicture } from "../lib/profile-picture.js";

/** Busca a foto de perfil do contato. Lança em falha para o BullMQ repetir (attempts/backoff da fila). */
export function startFetchProfilePictureWorker() {
  const worker = new Worker<FetchProfilePictureJobData>(
    QUEUE_NAMES.FETCH_PROFILE_PICTURE,
    async (job: Job<FetchProfilePictureJobData>) => {
      const result = await fetchContactProfilePicture(getAdminClient(), job.data);
      if (!result.ok) throw new Error(`fetch-profile-picture ${job.data.contactId}: ${result.reason}`);
    },
    { connection: getRedisConnection(), concurrency: 2 }
  );
  worker.on("failed", (job, err) => console.error(`Fetch profile picture job ${job?.id} failed:`, err.message));
  console.log("Fetch-profile-picture worker started");
  return worker;
}
