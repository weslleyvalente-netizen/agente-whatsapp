import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import { getRedisConnection } from "./connection.js";
import type {
  ProcessMessageJobData,
  SendMessageJobData,
  ProcessDocumentJobData,
  TakeoverTimeoutJobData,
  StaleConversationFollowupJobData,
  StoreCustomerAudioJobData,
  CustomerAudioRetentionJobData,
} from "./types.js";

let processMessageQueue: Queue<ProcessMessageJobData> | null = null;
let sendMessageQueue: Queue<SendMessageJobData> | null = null;
let processDocumentQueue: Queue<ProcessDocumentJobData> | null = null;
let takeoverTimeoutQueue: Queue<TakeoverTimeoutJobData> | null = null;
let staleConversationFollowupQueue: Queue<StaleConversationFollowupJobData> | null = null;

export function getProcessMessageQueue() {
  if (!processMessageQueue) {
    processMessageQueue = new Queue<ProcessMessageJobData>(QUEUE_NAMES.PROCESS_MESSAGE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return processMessageQueue;
}

export function getSendMessageQueue() {
  if (!sendMessageQueue) {
    sendMessageQueue = new Queue<SendMessageJobData>(QUEUE_NAMES.SEND_MESSAGE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return sendMessageQueue;
}

export function getProcessDocumentQueue() {
  if (!processDocumentQueue) {
    processDocumentQueue = new Queue<ProcessDocumentJobData>(QUEUE_NAMES.PROCESS_DOCUMENT, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    });
  }
  return processDocumentQueue;
}

export function getTakeoverTimeoutQueue() {
  if (!takeoverTimeoutQueue) {
    takeoverTimeoutQueue = new Queue<TakeoverTimeoutJobData>(QUEUE_NAMES.TAKEOVER_TIMEOUT, {
      connection: getRedisConnection(),
    });
  }
  return takeoverTimeoutQueue;
}

let leadSlaQueue: Queue<{}> | undefined;
export function getLeadSlaQueue() {
  if (!leadSlaQueue) leadSlaQueue = new Queue<{}>(QUEUE_NAMES.LEAD_SLA, { connection: getRedisConnection() });
  return leadSlaQueue;
}

export function getStaleConversationFollowupQueue() {
  if (!staleConversationFollowupQueue) {
    staleConversationFollowupQueue = new Queue<StaleConversationFollowupJobData>(
      QUEUE_NAMES.STALE_CONVERSATION_FOLLOWUP,
      { connection: getRedisConnection() }
    );
  }
  return staleConversationFollowupQueue;
}

let storeCustomerAudioQueue: Queue<StoreCustomerAudioJobData> | null = null;
export function getStoreCustomerAudioQueue() {
  if (!storeCustomerAudioQueue) {
    storeCustomerAudioQueue = new Queue<StoreCustomerAudioJobData>(QUEUE_NAMES.STORE_CUSTOMER_AUDIO, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 4,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
      },
    });
  }
  return storeCustomerAudioQueue;
}

let customerAudioRetentionQueue: Queue<CustomerAudioRetentionJobData> | null = null;
export function getCustomerAudioRetentionQueue() {
  if (!customerAudioRetentionQueue) {
    customerAudioRetentionQueue = new Queue<CustomerAudioRetentionJobData>(QUEUE_NAMES.CUSTOMER_AUDIO_RETENTION, {
      connection: getRedisConnection(),
    });
  }
  return customerAudioRetentionQueue;
}
