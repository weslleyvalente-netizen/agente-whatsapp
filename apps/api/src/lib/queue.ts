import { getProcessMessageQueue, getSendMessageQueue } from "@aula-agente/queue";

export function enqueueProcessMessage(data: {
  conversationId: string;
  messageId: string;
  agentId: string;
  organizationId: string;
}) {
  const queue = getProcessMessageQueue();
  return queue.add("process-message", data);
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
