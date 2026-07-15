import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import { getRedisConnection } from "./connection.js";
import type {
  ProcessMessageJobData,
  SendMessageJobData,
  ProcessDocumentJobData,
  TakeoverTimeoutJobData,
} from "./types.js";

let processMessageQueue: Queue<ProcessMessageJobData> | null = null;
let sendMessageQueue: Queue<SendMessageJobData> | null = null;
let processDocumentQueue: Queue<ProcessDocumentJobData> | null = null;
let takeoverTimeoutQueue: Queue<TakeoverTimeoutJobData> | null = null;

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
