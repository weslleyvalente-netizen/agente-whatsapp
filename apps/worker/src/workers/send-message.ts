import { Worker } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import type { SendMessageJobData } from "@aula-agente/queue";
import { getRedisConnection } from "@aula-agente/queue";
import { getAdminClient, getInstanceById } from "@aula-agente/database";

async function sendEvolutionText(instanceName: string, phone: string, text: string) {
  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;

  const response = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({ number: phone, text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Evolution API send error ${response.status}: ${body}`);
  }

  return response.json();
}

export function startSendMessageWorker() {
  const worker = new Worker<SendMessageJobData>(
    QUEUE_NAMES.SEND_MESSAGE,
    async (job) => {
      const { instanceId, phone, content } = job.data;

      const db = getAdminClient();
      const instance = await getInstanceById(db, instanceId);

      await sendEvolutionText(instance.instance_name, phone, content);

      console.log(`Sent message to ${phone} via instance ${instance.instance_name}`);
    },
    {
      connection: getRedisConnection(),
      concurrency: 20,
      limiter: {
        max: 30,
        duration: 1000, // 30 messages per second max
      },
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`Send job ${job?.id} failed:`, err.message);
  });

  console.log("Send-message worker started");
  return worker;
}
