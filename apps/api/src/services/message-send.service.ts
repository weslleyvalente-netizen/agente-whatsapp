import {
  getAdminClient,
  updateConversation,
  getInstanceById,
  createHandoffEvent,
  getOpenHandoffEvent,
  markFirstHumanReply,
} from "@aula-agente/database";
import type { Conversation, Message } from "@aula-agente/shared";
import { saveMessage } from "./message.service.js";
import { handleConversationTakeover } from "./task.service.js";
import { enqueueSendMessage } from "../lib/queue.js";
import { trackFirstHumanMessage } from "./lead-human-message.js";

export interface SendPanelMessageParams {
  conversation: Conversation;
  content: string;
  actorUserId: string;
  // Manual sends from the inbox always activate takeover (default true).
  // Follow-up-from-task passes false by default (D3) so the AI keeps
  // answering the conversation normally after a one-off follow-up.
  activateTakeover?: boolean;
  metadata?: Record<string, unknown> | null;
  // Point 2: when true, the send-message job gets attempts: 1 — BullMQ's
  // default retry (3 attempts) must never fire for a follow-up-from-task
  // send, since a job whose HTTP response to us got lost after Evolution
  // already delivered the message would otherwise resend it for real.
  noAutoRetry?: boolean;
}

export interface SendPanelMessageResult {
  message: Message;
  instanceId: string;
}

// Extracted from routes/messages/send.ts so the same send+takeover+handoff
// orchestration is shared by the manual inbox send and the
// follow-up-from-task flow (task-followup.service.ts) instead of duplicated.
export async function sendPanelMessage(params: SendPanelMessageParams): Promise<SendPanelMessageResult> {
  const { conversation, content, actorUserId, metadata } = params;
  const activateTakeover = params.activateTakeover ?? true;
  const db = getAdminClient();

  const message = await saveMessage({
    conversationId: conversation.id,
    organizationId: conversation.organization_id,
    evolutionMessageId: null,
    role: "human_agent",
    content,
    metadata: metadata ?? null,
  });

  if (!message) {
    throw new Error(`Failed to save message for conversation ${conversation.id}`);
  }

  const isFirstTakeover = !conversation.is_human_takeover;

  if (activateTakeover) {
    await updateConversation(db, conversation.id, {
      is_human_takeover: true,
      human_takeover_at: new Date().toISOString(),
      ...(isFirstTakeover ? { assigned_to: actorUserId } : {}),
    });

    if (isFirstTakeover) {
      try {
        await handleConversationTakeover(db, conversation.organization_id, conversation.id, actorUserId);
      } catch (err) {
        console.error(`Failed to reassign task on takeover for conversation ${conversation.id}:`, err);
      }
      try {
        await createHandoffEvent(db, {
          organization_id: conversation.organization_id,
          conversation_id: conversation.id,
          trigger_type: "painel_manual",
          criado_por: "humano",
        });
      } catch (err) {
        console.error(`Failed to record painel_manual handoff event for conversation ${conversation.id}:`, err);
      }
    }
  }

  // Closes an existing requestHuman handoff loop's "tempo até a primeira
  // resposta" metric regardless of activateTakeover — this reply answers a
  // pending handoff either way. Best-effort, never blocks the send.
  try {
    const openHandoff = await getOpenHandoffEvent(db, conversation.id);
    if (openHandoff) {
      await markFirstHumanReply(db, openHandoff.id, new Date().toISOString());
    }
  } catch (err) {
    console.error(`Failed to mark first human reply for conversation ${conversation.id}:`, err);
  }

  // Rodízio: a primeira mensagem humana do vendedor atribuído assume o lead e marca a primeira resposta.
  await trackFirstHumanMessage(db, {
    organizationId: conversation.organization_id,
    conversationId: conversation.id,
    role: message.role,
    source: "panel",
    actorUserId,
    metadata: metadata ?? null,
  });

  const instance = await getInstanceById(db, conversation.evolution_instance_id);
  const contact = (conversation as unknown as { wa_contacts: { phone: string } }).wa_contacts;

  await enqueueSendMessage(
    {
      conversationId: conversation.id,
      messageId: message.id,
      instanceId: instance.id,
      phone: contact.phone,
      content,
      organizationId: conversation.organization_id,
    },
    params.noAutoRetry ? { attempts: 1 } : undefined
  );

  return { message, instanceId: instance.id };
}
