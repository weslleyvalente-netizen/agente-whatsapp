import {processScheduledAdClosure,shouldSuppressScheduledAdLegacySend} from "./scheduled-ad-closure.js";
import {syncSalesPipeline} from "@aula-agente/database";
import { Worker, type Job } from "bullmq";
import { QUEUE_NAMES, CHAT_MEDIA_SIGNED_URL_TTL_SECONDS, isChatMediaRefFor, parseChatMediaRef, parseCustomerAudioRef, sanitizeEvolutionError } from "@aula-agente/shared";
import type { SendMessageJobData } from "@aula-agente/queue";
import { notifySendFailure, type SendFailureDeps } from "../lib/send-failure-alert.js";
import { getRedisConnection } from "@aula-agente/queue";
import { shouldCancelPreFreezeAgentMessage, markMessageSendFailed, createTaskWithDedup, findOpenTaskWithPendencyType, resolveAwaitingCustomerPendency, getOrganizationById, countRecentSendFailures, listManagerUserIds, hasPushSubscription, isPushConfigured, claimPushDedupe, releasePushDedupe, sendPushToUser, getMessageById, getConversationById, hasFrozenContact, getAdminClient, getInstanceById, setMessageEvolutionId, updateMessageContent } from "@aula-agente/database";

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
    throw new Error(sanitizeEvolutionError(response.status, body));
  }

  return response.json();
}

async function sendEvolutionMedia(
  instanceName: string,
  phone: string,
  mediaUrl: string,
  caption: string,
  opts?: { mediatype?: "image" | "video" | "document"; fileName?: string; mimetype?: string }
) {
  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL!;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY!;

  const response = await fetch(`${EVOLUTION_API_URL}/message/sendMedia/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      number: phone,
      mediatype: opts?.mediatype ?? "image",
      media: mediaUrl,
      caption,
      ...(opts?.fileName ? { fileName: opts.fileName } : {}),
      ...(opts?.mimetype ? { mimetype: opts.mimetype } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(sanitizeEvolutionError(response.status, body).replace("send error","media send error"));
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
    throw new Error(sanitizeEvolutionError(response.status, body).replace("send error","audio send error"));
  }

  return response.json();
}

async function markSellerAudioFailed(db: ReturnType<typeof getAdminClient>, messageId: string, content: string, metadata?: object | null) {
  try {
    await updateMessageContent(db, messageId, content, {
      ...(metadata ?? {}),
      send_failed_at: new Date().toISOString(),
    } as never);
  } catch (markError) {
    console.error(`Failed to mark send_failed_at for message ${messageId}:`, markError);
  }
}

type SendJob = Job<SendMessageJobData> | { data: SendMessageJobData };

export function realSendFailureDeps(db: ReturnType<typeof getAdminClient>): SendFailureDeps {
  return {
    settings: async (orgId) => (await getOrganizationById(db, orgId)).settings ?? {},
    managerIds: (orgId) => listManagerUserIds(db, orgId),
    countRecentFailures: (orgId, since) => countRecentSendFailures(db, orgId, since),
    canReceivePush: async (orgId, userId) => isPushConfigured() && hasPushSubscription(db, orgId, userId),
    claim: (key, userId) => claimPushDedupe(db, key, userId),
    release: (keys) => releasePushDedupe(db, keys),
    sendPush: async (orgId, userId, payload) => (await sendPushToUser(db, userId, payload, { organizationId: orgId })).sent,
    createTask: async (ctx, text) => {
      await createTaskWithDedup(db, {
        organization_id: ctx.organizationId, contact_id: ctx.contactId, conversation_id: ctx.conversationId, opportunity_id: null,
        type: "message_send_failed", description: text.description, reason: text.reason, priority: "high",
        due_date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }),
        created_by_type: "ai", created_by_id: null,
        ...(ctx.assigneeId ? { assignee_type: "human" as const, assignee_id: ctx.assigneeId, assign_on_merge: true } : {}),
      });
    },
    log: console,
  };
}

/**
 * Um envio posterior deu certo na conversa: a tarefa/pendência "Mensagem não enviada" criada ANTES dele já foi atendida
 * (o vendedor reenviou). Só encerra a pendência desta falha; nunca outras obrigações da tarefa consolidada. Nunca lança.
 */
async function resolveSendFailureTask(db: ReturnType<typeof getAdminClient>, data: SendMessageJobData, sentMessageCreatedAt: string | undefined) {
  if (!sentMessageCreatedAt) return;
  try {
    const conversation = await getConversationById(db, data.conversationId);
    const task = await findOpenTaskWithPendencyType(db, data.organizationId, (conversation as { contact_id: string }).contact_id, "message_send_failed");
    if (!task) return;
    await resolveAwaitingCustomerPendency(db, data.organizationId, task.id, "message_send_failed", "Mensagem reenviada com sucesso: falha de envio atendida.", 0, sentMessageCreatedAt);
  } catch (err) { console.error("send-failure task resolve failed:", (err as Error)?.message); }
}

/** Avisa vendedor/gestores da falha definitiva (opt-in). Nunca lança. */
async function alertSendFailure(db: ReturnType<typeof getAdminClient>, data: SendMessageJobData) {
  try {
    const [conversation, recorded] = await Promise.all([getConversationById(db, data.conversationId), getMessageById(db, data.messageId)]);
    let instanceName: string | null = null;
    try { instanceName = (await getInstanceById(db, data.instanceId)).instance_name ?? null; } catch { /* nome é só informativo */ }
    await notifySendFailure(realSendFailureDeps(db), {
      organizationId: data.organizationId, conversationId: data.conversationId, contactId: (conversation as { contact_id: string }).contact_id,
      messageId: data.messageId, messageCreatedAt: recorded?.created_at ?? null, senderRole: recorded?.role ?? "agent",
      contactName: (conversation as { wa_contacts?: { name?: string | null } }).wa_contacts?.name ?? null, instanceName,
      assigneeId: (conversation as { assigned_to?: string | null }).assigned_to ?? null,
    });
  } catch (err) { console.error("send-failure-alert: could not build context:", (err as Error)?.message); }
}

/**
 * Envio com registro de falha: se a última tentativa falhar, a mensagem (que já foi gravada ao enfileirar) é marcada como NÃO enviada.
 * Assim ela deixa de contar como resposta entregue (varredura de leads sem resposta, follow-ups, silêncio) e o painel pode mostrá-la.
 * Só a tentativa FINAL marca: uma falha com retry pendente pode ainda dar certo.
 */
export async function processSendMessageJob(job: SendJob) {
  try {
    return await processSendMessageJobInner(job);
  } catch (error) {
    const real = job as Partial<Job<SendMessageJobData>>;
    const attempts = real.opts?.attempts ?? 1;
    const isFinal = (real.attemptsMade ?? 0) + 1 >= attempts;
    if (isFinal && !job.data.messageId.startsWith("handoff-notify-")) {
      const reason = sanitizeEvolutionError(0, (error as Error)?.message ?? "erro desconhecido").replace(/^Evolution API send error 0: ?/, "");
      try {
        const db = getAdminClient();
        // Só alerta quando ESTA chamada marcou a falha (primeira vez): reprocessar não repete o aviso.
        if (await markMessageSendFailed(db, job.data.messageId, reason)) await alertSendFailure(db, job.data);
      } catch (markError) { console.error(`Failed to mark send failure for message ${job.data.messageId}:`, (markError as Error)?.message); }
    }
    throw error;
  }
}

async function processSendMessageJobInner(job: SendJob) {
  const { messageId, instanceId, phone, content, mediaUrl, audioBase64, caption, storedAudioRef, storedMediaRef, mediaFileName, mediaMime, mediaKind } = job.data;

  const db = getAdminClient();
  const internalNotification=messageId.startsWith("handoff-notify-");
  let recorded: Awaited<ReturnType<typeof getMessageById>> | null = null;
  if(!internalNotification){
    try{ recorded=await getMessageById(db,messageId); }
    catch(error){
      if(storedAudioRef || storedMediaRef) await markSellerAudioFailed(db,messageId,content);
      throw error;
    }
  }
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
  let response: unknown;
  let instance: Awaited<ReturnType<typeof getInstanceById>>;

  if (storedAudioRef) {
    // Seller audio: no text fallback and no retry. Any failure marks the message and fails the job.
    try {
      instance = await getInstanceById(db, instanceId);
      const ref = parseCustomerAudioRef(storedAudioRef);
      if (!ref) throw new Error(`Invalid stored audio ref: ${storedAudioRef}`);
      const { data, error } = await db.storage.from(ref.bucket).download(ref.path);
      if (error || !data) throw new Error(`Seller audio download failed: ${error?.message ?? "no data"}`);
      const base64 = Buffer.from(await data.arrayBuffer()).toString("base64");
      response = await sendEvolutionAudio(instance.instance_name, phone, base64);
    } catch (error) {
      await markSellerAudioFailed(db, messageId, recorded?.content ?? content, recorded?.metadata);
      throw error;
    }
  } else if (storedMediaRef) {
    // Seller attachment: no text fallback and no retry. Any failure marks the message and fails the job.
    try {
      instance = await getInstanceById(db, instanceId);
      const ref = parseChatMediaRef(storedMediaRef);
      if (!ref) throw new Error(`Invalid stored media ref: ${storedMediaRef}`);
      // The ref must be this very message's own path; media_url can be edited by members via RLS.
      if (
        !recorded ||
        !isChatMediaRefFor(storedMediaRef, {
          organizationId: recorded.organization_id,
          conversationId: recorded.conversation_id,
          messageId: recorded.id,
        })
      ) {
        throw new Error("Stored media ref does not belong to this message");
      }
      const { data, error } = await db.storage.from(ref.bucket).createSignedUrl(ref.path, CHAT_MEDIA_SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) throw new Error(`Seller media signing failed: ${error?.message ?? "no url"}`);
      const kind = mediaKind ?? "document";
      const extension = ref.path.slice(ref.path.lastIndexOf(".") + 1);
      const signedUrl = data.signedUrl;
      try {
        response = await sendEvolutionMedia(instance.instance_name, phone, signedUrl, caption ?? "", {
          mediatype: kind,
          ...(kind === "document" ? { fileName: mediaFileName || `arquivo.${extension}` } : {}),
          ...(mediaMime ? { mimetype: mediaMime } : {}),
        });
      } catch (sendError) {
        // A resposta da Evolution pode repetir a URL assinada (segredo): nunca vai para failedReason/logs.
        if (sendError instanceof Error && sendError.message.includes(signedUrl)) {
          throw new Error(sendError.message.split(signedUrl).join("[redacted]"));
        }
        throw sendError;
      }
    } catch (error) {
      await markSellerAudioFailed(db, messageId, recorded?.content ?? content, recorded?.metadata);
      throw error;
    }
  } else if (audioBase64) {
    instance = await getInstanceById(db, instanceId);
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
    instance = await getInstanceById(db, instanceId);
    response = await sendEvolutionMedia(instance.instance_name, phone, mediaUrl, caption || content);
  } else {
    instance = await getInstanceById(db, instanceId);
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
  // Envio aceito: encerra a tarefa "Mensagem não enviada" desta conversa criada antes desta mensagem (reenvio bem-sucedido).
  if (!internalNotification && (recorded?.role === "agent" || recorded?.role === "human_agent")) await resolveSendFailureTask(db, job.data, recorded.created_at);
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
