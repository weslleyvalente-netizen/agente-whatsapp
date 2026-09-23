import { getProcessMessageQueue, getSendMessageQueue } from "@aula-agente/queue";

// How long to wait after a customer's message before actually processing
// it. Rapid consecutive bubbles (someone typing "oi" / "tudo bem?" / "quero
// saber sobre a fazer 250" as 3 separate messages) each call this function,
// but `deduplication` + `replace: true` below collapses them into a single
// delayed job whose delay keeps resetting to this value on every new
// message — so the job only actually runs ~6s after the customer stops
// sending messages, by which point the worker (see
// apps/worker/src/workers/process-message.ts) reads every pending message
// for the conversation and answers them together, instead of firing one
// LLM call and one reply per bubble.
const MESSAGE_GROUPING_DELAY_MS = 6000;

export function enqueueProcessMessage(data: {
  conversationId: string;
  messageId: string;
  agentId: string;
  organizationId: string;
}) {
  const queue = getProcessMessageQueue();
  return queue.add("process-message", data, {
    delay: MESSAGE_GROUPING_DELAY_MS,
    // One process-message job per conversation at a time: a new message
    // arriving while one is still delayed replaces its data/timer instead
    // of queuing a second one. The worker doesn't trust job.data.messageId
    // as "the" message to process anyway — it re-reads every pending
    // contact message from the DB — so replacing is safe even though only
    // the latest message's data survives here.
    deduplication: { id: data.conversationId, replace: true },
  });
}

export function enqueueSendMessage(data: {
  conversationId: string;
  messageId: string;
  instanceId: string;
  phone: string;
  content: string;
  organizationId: string;
}) {
  const queue = getSendMessageQueue();
  return queue.add("send-message", data);
}
