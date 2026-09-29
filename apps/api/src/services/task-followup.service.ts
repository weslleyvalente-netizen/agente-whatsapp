import type { SupabaseClient } from "@aula-agente/database";
import {
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
} from "@aula-agente/database";
import {
  isTaskFollowupEligible,
  decideFollowupGate,
  evaluateFollowupThrottle,
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

export interface SendTaskFollowupParams {
  taskId: string;
  organizationId: string;
  message: string;
  actorUserId: string;
  regenerationsBeforeSend: number;
}

export type SendTaskFollowupResult =
  | { ok: true; task: Task }
  | { ok: false; reason: "not_eligible"; detail: string }
  | { ok: false; reason: "min_interval"; retryAfterSeconds: number }
  | { ok: false; reason: "daily_limit" }
  | { ok: false; reason: "send_failed"; detail: string };

// Orchestrates a follow-up send from a Task: eligibility (D1/D2) -> per-
// instance anti-ban throttle (D5) -> send (reusing sendPanelMessage,
// activateTakeover per D3) -> audit/metrics row (D4/D7) -> complete the
// task. Only writes the send record and completes the task once the send
// itself has actually succeeded — any earlier rejection or a send failure
// leaves the task open and writes nothing.
export async function sendTaskFollowup(params: SendTaskFollowupParams): Promise<SendTaskFollowupResult> {
  const db = getAdminClient();
  const task = await getTaskById(db, params.taskId);
  const organization = await getOrganizationById(db, params.organizationId);

  const eligibility = await resolveTaskFollowupEligibility(db, task);
  if (!eligibility.eligible) {
    return { ok: false, reason: "not_eligible", detail: eligibility.reason };
  }
  const { conversation } = eligibility;
  const instanceId = conversation.evolution_instance_id;

  const settings = organization.settings ?? {};
  const minIntervalSeconds = settings.task_followup_min_interval_seconds ?? DEFAULT_TASK_FOLLOWUP_CONFIG.min_interval_seconds;
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
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown_error";
    return { ok: false, reason: "send_failed", detail };
  }

  const suggestionStatus: "original" | "edited" =
    params.message.trim() === (task.followup_suggested_message ?? "").trim() ? "original" : "edited";

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
