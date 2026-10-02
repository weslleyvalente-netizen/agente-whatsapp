import {processScheduledAdClosure,shouldSuppressScheduledAdLegacySend} from "./scheduled-ad-closure.js";
import {syncSalesPipeline} from "@aula-agente/database";
import { Worker, type Job } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import type { SendMessageJobData } from "@aula-agente/queue";
import { getRedisConnection } from "@aula-agente/queue";
import { shouldCancelPreFreezeAgentMessage, getMessageById, getConversationById, hasFrozenContact, getAdminClient, getInstanceById, setMessageEvolutionId } from "@aula-agente/database";

// Evolution/Baileys echoes the id it assigned back in the response's
// key.id — capturing it here and backfilling it onto the row saved at
// send time (which starts with evolution_message_id: null) is what lets
// the webhook's messageExistsByEvolutionId recognize our own echo later
// and skip re-saving it as a duplicate message.
function extractEvolutionMessageId(response: unknown): string | null {
  if (response && typeof response === "object" && "key" in response) {
    const key = (response as { key?: unknown }).key;
    if (key && typeof key === "object" && "id" in key) {
      const id = (key as { id?: unknown }).id;
      if (typeof id === "string") return id;
    }
  }
  return null;
}

async function sendEvolutionText(instanceName: string, phone: string, text: string, signal?: AbortSignal) {
  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;

  const response = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({ number: phone, text }),
    signal,
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

export async function processSendMessageJob(job: Job<SendMessageJobData> | { data: SendMessageJobData }) {
  const { messageId, instanceId, phone, content, mediaUrl, audioBase64, caption } = job.data;

  const db = getAdminClient();
  const internalNotification=messageId.startsWith("handoff-notify-");
  const recorded=internalNotification?null:await getMessageById(db,messageId);
  const metadata=recorded?.metadata;
  if(recorded && metadata?.scheduled_ad_closure){
    await processScheduledAdClosure(db,job.data,recorded,async(text,signal)=>{
      const instance=await getInstanceById(db,instanceId);
      return sendEvolutionText(instance.instance_name,phone,text,signal);
    });
    return;
  }
  if(recorded && (metadata?.source==="automatic_followup" || metadata?.low_intent_followup) && await shouldSuppressScheduledAdLegacySend(db,job.data.organizationId,job.data.conversationId))return;
  if(recorded && (recorded.role==="agent" || metadata?.source==="task_followup")){
    const c=await getConversationById(db,job.data.conversationId);
    if(await shouldCancelPreFreezeAgentMessage(db,job.data.organizationId,c.contact_id,recorded.created_at)) return;
  }
  if(metadata?.source==="task_followup" || metadata?.source==="automatic_followup" || metadata?.low_intent_followup){
    const conversation=await getConversationById(db,job.data.conversationId);
    const automatic=metadata?.source!=="task_followup";
    if(await hasFrozenContact(db,job.data.organizationId,conversation.contact_id,automatic)){
      console.log("Follow-up cancelled: frozen business",messageId);
      return;
    }
  }
  const instance = await getInstanceById(db, instanceId);

  let response: unknown;

  if (audioBase64) {
    try {
      response = await sendEvolutionAudio(instance.instance_name, phone, audioBase64);
    } catch (error) {
      // Never let a TTS/audio-send failure block the customer from getting a reply:
      // fall back to the same text already generated for this message. Note the
      // message row's stored media_type: "audio" becomes inaccurate when this fires
      // (not corrected retroactively — accepted tradeoff).
      const message = error instanceof Error ? error.message : "unknown_error";
      console.warn(`Audio send to ${phone} failed, falling back to text: ${message}`);
      response = await sendEvolutionText(instance.instance_name, phone, content);
    }
  } else if (mediaUrl) {
    response = await sendEvolutionMedia(instance.instance_name, phone, mediaUrl, caption || content);
  } else {
    response = await sendEvolutionText(instance.instance_name, phone, content);
  }

  const evolutionMessageId = extractEvolutionMessageId(response);
  if (evolutionMessageId) {
    try {
      await setMessageEvolutionId(db, messageId, evolutionMessageId);
    } catch (error) {
      // Best-effort: losing the backfill only reintroduces the pre-existing
      // duplicate-on-echo behavior for this one message, never blocks the send.
      console.error(`Failed to backfill evolution_message_id for message ${messageId}:`, error);
    }
  }

  try { if(!internalNotification)await syncSalesPipeline(db,job.data.organizationId,job.data.conversationId,messageId); } catch(error) { console.error("Pipeline sync failed after send",messageId,error); }
  console.log(`Sent message to ${phone} via instance ${instance.instance_name}`);
}

export function startSendMessageWorker() {
  const worker = new Worker<SendMessageJobData>(
    QUEUE_NAMES.SEND_MESSAGE,
    processSendMessageJob,
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
