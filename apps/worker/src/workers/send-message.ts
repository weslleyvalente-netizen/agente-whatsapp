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

async function sendEvolutionMedia(instanceName: string, phone: string, mediaUrl: string, caption: string) {
  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;

  const response = await fetch(`${EVOLUTION_API_URL}/message/sendMedia/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({ number: phone, mediatype: "image", media: mediaUrl, caption }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Evolution API media send error ${response.status}: ${body}`);
  }

  return response.json();
}

async function sendEvolutionAudio(instanceName: string, phone: string, audioBase64: string) {
  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;

  const response = await fetch(`${EVOLUTION_API_URL}/message/sendWhatsAppAudio/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({ number: phone, audio: audioBase64, encoding: true }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Evolution API audio send error ${response.status}: ${body}`);
  }

  return response.json();
}

export function startSendMessageWorker() {
  const worker = new Worker<SendMessageJobData>(
    QUEUE_NAMES.SEND_MESSAGE,
    async (job) => {
      const { instanceId, phone, content, mediaUrl, audioBase64, caption } = job.data;

      const db = getAdminClient();
      const instance = await getInstanceById(db, instanceId);

      if (audioBase64) {
        try {
          await sendEvolutionAudio(instance.instance_name, phone, audioBase64);
        } catch (error) {
          // Never let a TTS/audio-send failure block the customer from getting a reply:
          // fall back to the same text already generated for this message. Note the
          // message row's stored media_type: "audio" becomes inaccurate when this fires
          // (not corrected retroactively — accepted tradeoff).
          const message = error instanceof Error ? error.message : "unknown_error";
          console.warn(`Audio send to ${phone} failed, falling back to text: ${message}`);
          await sendEvolutionText(instance.instance_name, phone, content);
        }
      } else if (mediaUrl) {
        await sendEvolutionMedia(instance.instance_name, phone, mediaUrl, caption || content);
      } else {
        await sendEvolutionText(instance.instance_name, phone, content);
      }

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
