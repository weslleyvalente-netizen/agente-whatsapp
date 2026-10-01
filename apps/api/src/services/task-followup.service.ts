import type { SupabaseClient } from "@aula-agente/database";
import {
  hasFrozenContact,
  getAdminClient,
  getTaskById,
  getOrganizationById,
  getOpportunityById,
  getConversationById,
  findOpenConversationByContact,
  getLastFollowupSendForInstance,
  countFollowupSendsForInstanceSince,
  createTaskFollowupSend,
  addTaskEvent,
  getMessageById,
  setFollowupPendingMessage,
  countFollowupTouchEventsForConversationSince,
  getLastContactMessage,
  getRecentMessages,
} from "@aula-agente/database";
import {
  isTaskFollowupEligible,
  decideFollowupGate,
  evaluateFollowupThrottle,
  evaluateFollowupCoordination,
  toISODateInTimeZone,
  DEFAULT_TASK_FOLLOWUP_CONFIG,
  type Conversation,
  type Task,
} from "@aula-agente/shared";
import { sendPanelMessage } from "./message-send.service.js";
import { completeTask } from "./task.service.js";

export type FollowupEligibilityResult =
  | { eligible: true; conversation: Conversation }
  | { eligible: false; reason: "not_eligible_type" | "scheduled_callback_not_due" | "no_conversation" };

// D1 (eligible types + the waiting_on=scheduled_date exception) and D2 (task
// with no conversation_id falls back to the contact's open conversation).
export async function resolveTaskFollowupEligibility(
  db: SupabaseClient,
  task: Task
): Promise<FollowupEligibilityResult> {
  if (await hasFrozenContact(db,task.organization_id,task.contact_id)) return {eligible:false,reason:"scheduled_callback_not_due"};
  if (!isTaskFollowupEligible(task.type)) {
    return { eligible: false, reason: "not_eligible_type" };
  }

  if (task.opportunity_id) {
    const opportunity = await getOpportunityById(db, task.opportunity_id);
    const todayISODate = toISODateInTimeZone(new Date());
    const gate = decideFollowupGate(opportunity, todayISODate);
    if (gate === "skip_scheduled_callback") {
      return { eligible: false, reason: "scheduled_callback_not_due" };
    }
    // skip_pending_on_us (waiting_on team/bank_or_admin) doesn't apply to an
    // eligible task type here — those pendencies are internal task types
    // (run_quote/update_quote), already excluded above.
  }

  let conversation: Conversation | null = null;
  if (task.conversation_id) {
    conversation = await getConversationById(db, task.conversation_id);
  } else {
    conversation = await findOpenConversationByContact(db, task.contact_id);
  }

  if (!conversation) {
    return { eligible: false, reason: "no_conversation" };
  }

  return { eligible: true, conversation };
}

export interface FollowupTouchInfo {
  // Most recent outbound message (role agent or human_agent) since the
  // customer's last reply — null if the customer already replied, or there
  // was never a touch at all.
  lastTouchAt: string | null;
  lastTouchBy: "agent" | "human_agent" | null;
  // Count of "touches" (auto_followup_stage_1/2 + followup_sent task_events,
  // across every task tied to this conversation) since the customer's last
  // reply — see evaluateFollowupCoordination.
  touchCount: number;
}

// Point 4d: surfaced by the suggestion endpoint so the panel can show "last
// touch: X, há Yh" and the touch count before the attendant even generates
// a message, and reused by sendTaskFollowup to enforce the coordination rule.
export async function getFollowupTouchInfo(
  db: SupabaseClient,
  conversation: Conversation
): Promise<FollowupTouchInfo> {
  const [lastContact, recentMessages] = await Promise.all([
    getLastContactMessage(db, conversation.id),
    getRecentMessages(db, conversation.id, 20),
  ]);
  const anchorISO = lastContact?.created_at ?? conversation.created_at;
  const recordedTaskTouches = await countFollowupTouchEventsForConversationSince(db, conversation.id, anchorISO);
  const noTaskTouches = recentMessages.filter(m => m.role === "agent" && m.evolution_message_id && m.metadata?.low_intent_followup && new Date(m.created_at).getTime() > new Date(anchorISO).getTime()).length;
  const touchCount = recordedTaskTouches + noTaskTouches;

  const lastMessage = recentMessages.at(-1) ?? null;
  if (!lastMessage || lastMessage.role === "contact") {
    return { lastTouchAt: null, lastTouchBy: null, touchCount };
  }

  return {
    lastTouchAt: lastMessage.created_at,
    lastTouchBy: lastMessage.role as "agent" | "human_agent",
    touchCount,
  };
}

export interface SendTaskFollowupParams {
  taskId: string;
  organizationId: string;
  message: string;
  actorUserId: string;
  regenerationsBeforeSend: number;
  // Bypasses the "already pending" re-send guard and the coordination rule
  // (point 4) — but never the anti-ban throttle (D5), which protects the
  // WhatsApp number, not the customer relationship. The caller (route/UI)
  // is responsible for surfacing the risk-of-duplicate warning before
  // setting this.
  force?: boolean;
  // Overridable only for tests — production always uses the defaults.
  confirmationTimeoutMs?: number;
  confirmationPollIntervalMs?: number;
}

export type SendTaskFollowupResult =
  | { ok: true; task: Task }
  | { ok: false; reason: "not_eligible"; detail: string }
  | { ok: false; reason: "min_interval"; retryAfterSeconds: number }
  | { ok: false; reason: "daily_limit" }
  | { ok: false; reason: "recent_touch"; hoursSinceTouch: number }
  | { ok: false; reason: "touch_limit_reached"; touchCount: number }
  | { ok: false; reason: "unconfirmed"; pendingMessageId: string }
  | { ok: false; reason: "send_failed"; detail: string };

// Confirmation = the send-message worker's own backfill of
// evolution_message_id after a successful Evolution API call (see
// apps/worker/src/workers/send-message.ts) — not waiting for the echo,
// which depends on a second, slower network hop (WhatsApp -> Evolution ->
// our webhook) that can fail independently of the send itself.
const CONFIRMATION_TIMEOUT_MS = 12_000;
const CONFIRMATION_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConfirmation(
  db: SupabaseClient,
  messageId: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = await getMessageById(db, messageId);
    if (message?.evolution_message_id) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
}

// Orchestrates a follow-up send from a Task:
// 1. Already-pending guard (point 2, double-click/duplicate protection): if
//    this task has an unconfirmed send in flight, re-check it instead of
//    sending again (unless force).
// 2. Eligibility (D1/D2).
// 3. Coordination with Helena's automatic 1h/23h cadence (point 4) — skipped
//    when force.
// 4. Per-instance anti-ban throttle (D5) — NEVER skipped, even with force.
// 5. Send (sendPanelMessage, activateTakeover per D3, noAutoRetry so BullMQ
//    never silently resends).
// 6. Bounded wait for confirmation (point 2) — confirmed completes the task;
//    not confirmed in time leaves it "unconfirmed", nothing else written.
export async function sendTaskFollowup(params: SendTaskFollowupParams): Promise<SendTaskFollowupResult> {
  const db = getAdminClient();
  const task = await getTaskById(db, params.taskId);
  const confirmationTimeoutMs = params.confirmationTimeoutMs ?? CONFIRMATION_TIMEOUT_MS;
  const confirmationPollIntervalMs = params.confirmationPollIntervalMs ?? CONFIRMATION_POLL_INTERVAL_MS;

  if (task.status === "completed") {
    return { ok: true, task };
  }

  if (task.followup_pending_message_id && !params.force) {
    const confirmed = await waitForConfirmation(
      db,
      task.followup_pending_message_id,
      confirmationTimeoutMs,
      confirmationPollIntervalMs
    );
    if (!confirmed) {
      return { ok: false, reason: "unconfirmed", pendingMessageId: task.followup_pending_message_id };
    }
    await setFollowupPendingMessage(db, task.id, null);
    const completedTask = await completeTask(
      db,
      task.id,
      { type: "human", id: params.actorUserId },
      "Follow-up enviado (confirmado)"
    );
    return { ok: true, task: completedTask };
  }

  const organization = await getOrganizationById(db, params.organizationId);
  const settings = organization.settings ?? {};

  const eligibility = await resolveTaskFollowupEligibility(db, task);
  if (!eligibility.eligible) {
    return { ok: false, reason: "not_eligible", detail: eligibility.reason };
  }
  const { conversation } = eligibility;
  const instanceId = conversation.evolution_instance_id;

  if (!params.force) {
    const touchInfo = await getFollowupTouchInfo(db, conversation);
    const coordination = evaluateFollowupCoordination(
      touchInfo,
      {
        minHoursSinceLastTouch:
          settings.task_followup_min_hours_since_last_touch ?? DEFAULT_TASK_FOLLOWUP_CONFIG.min_hours_since_last_touch,
        maxTouchesWithoutReply:
          settings.task_followup_max_touches_without_reply ?? DEFAULT_TASK_FOLLOWUP_CONFIG.max_touches_without_reply,
      },
      new Date()
    );
    if (!coordination.allowed) {
      return coordination.reason === "recent_touch"
        ? { ok: false, reason: "recent_touch", hoursSinceTouch: coordination.hoursSinceTouch }
        : { ok: false, reason: "touch_limit_reached", touchCount: coordination.touchCount };
    }
  }

  const minIntervalSeconds =
    settings.task_followup_min_interval_seconds ?? DEFAULT_TASK_FOLLOWUP_CONFIG.min_interval_seconds;
  const dailyLimit = settings.task_followup_daily_limit ?? DEFAULT_TASK_FOLLOWUP_CONFIG.daily_limit;
  const takeoverOnSend = settings.task_followup_takeover_on_send ?? DEFAULT_TASK_FOLLOWUP_CONFIG.takeover_on_send;

  const now = new Date();
  const startOfTodayISO = `${toISODateInTimeZone(now)}T00:00:00.000Z`;
  const [lastSend, sentTodayCount] = await Promise.all([
    getLastFollowupSendForInstance(db, instanceId),
    countFollowupSendsForInstanceSince(db, instanceId, startOfTodayISO),
  ]);

  const throttle = evaluateFollowupThrottle({
    lastSentAt: lastSend?.sent_at ?? null,
    sentTodayCount,
    minIntervalSeconds,
    dailyLimit,
    now,
  });
  if (!throttle.allowed) {
    return throttle.reason === "min_interval"
      ? { ok: false, reason: "min_interval", retryAfterSeconds: throttle.retryAfterSeconds }
      : { ok: false, reason: "daily_limit" };
  }

  let sendResult;
  try {
    sendResult = await sendPanelMessage({
      conversation,
      content: params.message,
      actorUserId: params.actorUserId,
      activateTakeover: takeoverOnSend,
      metadata: { source: "task_followup", task_id: task.id },
      noAutoRetry: true,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown_error";
    return { ok: false, reason: "send_failed", detail };
  }

  const suggestionStatus: "original" | "edited" =
    params.message.trim() === (task.followup_suggested_message ?? "").trim() ? "original" : "edited";

  // Recorded at attempt time, not confirmation time: the anti-ban throttle
  // must hold even if this exact attempt ends up unconfirmed and gets
  // retried later.
  await createTaskFollowupSend(db, {
    organization_id: task.organization_id,
    instance_id: instanceId,
    task_id: task.id,
    conversation_id: conversation.id,
    message_id: sendResult.message.id,
    suggestion_status: suggestionStatus,
    regenerations_before_send: params.regenerationsBeforeSend,
    sent_by_type: "human",
    sent_by_id: params.actorUserId,
  });

  await setFollowupPendingMessage(db, task.id, sendResult.message.id);

  const confirmed = await waitForConfirmation(
    db,
    sendResult.message.id,
    confirmationTimeoutMs,
    confirmationPollIntervalMs
  );
  if (!confirmed) {
    return { ok: false, reason: "unconfirmed", pendingMessageId: sendResult.message.id };
  }

  await setFollowupPendingMessage(db, task.id, null);

  await addTaskEvent(db, {
    task_id: task.id,
    organization_id: task.organization_id,
    event_type: "followup_sent",
    note: suggestionStatus === "original" ? "Follow-up enviado (texto original)." : "Follow-up enviado (editado).",
    created_by_type: "human",
    created_by_id: params.actorUserId,
  });

  const completedTask = await completeTask(db, task.id, { type: "human", id: params.actorUserId }, "Follow-up enviado");

  return { ok: true, task: completedTask };
}
