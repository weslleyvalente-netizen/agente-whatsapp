import { describe, it, expect, vi, beforeEach } from "vitest";

const {
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
  sendPanelMessage,
  completeTask,
} = vi.hoisted(() => ({
  getTaskById: vi.fn(),
  getOrganizationById: vi.fn(),
  getOpportunityById: vi.fn(),
  getConversationById: vi.fn(),
  findOpenConversationByContact: vi.fn(),
  getLastFollowupSendForInstance: vi.fn(),
  countFollowupSendsForInstanceSince: vi.fn(),
  createTaskFollowupSend: vi.fn().mockResolvedValue({ id: "send-1" }),
  addTaskEvent: vi.fn().mockResolvedValue({ id: "event-1" }),
  getMessageById: vi.fn(),
  setFollowupPendingMessage: vi.fn().mockResolvedValue({ id: "task-1" }),
  countFollowupTouchEventsForConversationSince: vi.fn(),
  getLastContactMessage: vi.fn(),
  getRecentMessages: vi.fn(),
  sendPanelMessage: vi.fn(),
  completeTask: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
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
}));
vi.mock("./message-send.service.js", () => ({ sendPanelMessage }));
vi.mock("./task.service.js", () => ({ completeTask }));

import { resolveTaskFollowupEligibility, sendTaskFollowup, getFollowupTouchInfo } from "./task-followup.service.js";

const conversation = {
  id: "conv-1",
  organization_id: "org-1",
  is_human_takeover: false,
  evolution_instance_id: "instance-1",
  created_at: "2026-09-01T00:00:00Z",
  wa_contacts: { phone: "5511999999999" },
} as any;

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    organization_id: "org-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    opportunity_id: null,
    type: "proposal_followup",
    description: "Cliente sumiu",
    status: "pending",
    followup_suggested_message: "Oi! Ainda pensando na proposta?",
    followup_pending_message_id: null,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  getConversationById.mockResolvedValue(conversation);
  findOpenConversationByContact.mockResolvedValue(null);
  getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
  getLastFollowupSendForInstance.mockResolvedValue(null);
  countFollowupSendsForInstanceSince.mockResolvedValue(0);
  countFollowupTouchEventsForConversationSince.mockResolvedValue(0);
  getLastContactMessage.mockResolvedValue({ created_at: "2026-09-29T08:00:00Z" });
  getRecentMessages.mockResolvedValue([]);
  sendPanelMessage.mockResolvedValue({ message: { id: "msg-1" }, instanceId: "instance-1" });
  completeTask.mockResolvedValue({ id: "task-1", status: "completed" });
  setFollowupPendingMessage.mockImplementation(async (_db, taskId, messageId) => ({ id: taskId, followup_pending_message_id: messageId }));
});

describe("resolveTaskFollowupEligibility", () => {
  it("rejects a non-eligible task type", async () => {
    const result = await resolveTaskFollowupEligibility({} as any, makeTask({ type: "run_quote" }));
    expect(result).toEqual({ eligible: false, reason: "not_eligible_type" });
  });

  it("uses the task's own conversation when it has one", async () => {
    const result = await resolveTaskFollowupEligibility({} as any, makeTask());
    expect(result).toEqual({ eligible: true, conversation });
    expect(findOpenConversationByContact).not.toHaveBeenCalled();
  });

  it("falls back to the contact's open conversation when the task has none (D2)", async () => {
    findOpenConversationByContact.mockResolvedValue(conversation);
    const result = await resolveTaskFollowupEligibility({} as any, makeTask({ conversation_id: null }));
    expect(result).toEqual({ eligible: true, conversation });
    expect(findOpenConversationByContact).toHaveBeenCalledWith({}, "contact-1");
  });

  it("rejects when the task has no conversation and the contact has no open conversation either", async () => {
    const result = await resolveTaskFollowupEligibility({} as any, makeTask({ conversation_id: null }));
    expect(result).toEqual({ eligible: false, reason: "no_conversation" });
  });

  it("rejects a task linked to an opportunity with an unarrived scheduled_date (D1 exception)", async () => {
    getOpportunityById.mockResolvedValue({ waiting_on: "scheduled_date", waiting_on_until: "2099-01-01" });
    const result = await resolveTaskFollowupEligibility({} as any, makeTask({ opportunity_id: "opp-1" }));
    expect(result).toEqual({ eligible: false, reason: "scheduled_callback_not_due" });
  });

  it("allows a task linked to an opportunity once the scheduled_date has arrived", async () => {
    getOpportunityById.mockResolvedValue({ waiting_on: "scheduled_date", waiting_on_until: "2020-01-01" });
    const result = await resolveTaskFollowupEligibility({} as any, makeTask({ opportunity_id: "opp-1" }));
    expect(result.eligible).toBe(true);
  });
});

describe("getFollowupTouchInfo", () => {
  it("reports no touch when the customer replied last", async () => {
    getRecentMessages.mockResolvedValue([{ role: "contact", created_at: "2026-09-29T09:00:00Z" }]);
    const info = await getFollowupTouchInfo({} as any, conversation);
    expect(info.lastTouchAt).toBeNull();
    expect(info.lastTouchBy).toBeNull();
  });

  it("reports the last outbound touch when Helena's own message is latest", async () => {
    getRecentMessages.mockResolvedValue([{ role: "agent", created_at: "2026-09-29T09:00:00Z" }]);
    const info = await getFollowupTouchInfo({} as any, conversation);
    expect(info.lastTouchAt).toBe("2026-09-29T09:00:00Z");
    expect(info.lastTouchBy).toBe("agent");
  });

  it("reports the last outbound touch when a human/task follow-up is latest", async () => {
    getRecentMessages.mockResolvedValue([{ role: "human_agent", created_at: "2026-09-29T09:30:00Z" }]);
    const info = await getFollowupTouchInfo({} as any, conversation);
    expect(info.lastTouchBy).toBe("human_agent");
  });

  it("includes the touch count since the customer's last reply", async () => {
    countFollowupTouchEventsForConversationSince.mockResolvedValue(2);
    const info = await getFollowupTouchInfo({} as any, conversation);
    expect(info.touchCount).toBe(2);
  });
});

describe("sendTaskFollowup", () => {
  const baseParams = {
    taskId: "task-1",
    organizationId: "org-1",
    message: "Oi! Ainda pensando na proposta?",
    actorUserId: "user-1",
    regenerationsBeforeSend: 0,
  };

  beforeEach(() => {
    getTaskById.mockResolvedValue(makeTask());
  });

  it("sends, confirms immediately, marks original, and completes the task on the happy path", async () => {
    getMessageById.mockResolvedValue({ id: "msg-1", evolution_message_id: "EVO-1" }); // confirmed on first poll

    const result = await sendTaskFollowup(baseParams);

    expect(result).toEqual({ ok: true, task: { id: "task-1", status: "completed" } });
    expect(sendPanelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversation, content: baseParams.message, activateTakeover: false, noAutoRetry: true })
    );
    expect(createTaskFollowupSend).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ suggestion_status: "original", instance_id: "instance-1" })
    );
    expect(setFollowupPendingMessage).toHaveBeenCalledWith({}, "task-1", "msg-1");
    expect(setFollowupPendingMessage).toHaveBeenCalledWith({}, "task-1", null);
    expect(addTaskEvent).toHaveBeenCalledWith({}, expect.objectContaining({ event_type: "followup_sent" }));
    expect(completeTask).toHaveBeenCalled();
  });

  it("marks the send as edited when the sent text differs from the stored suggestion", async () => {
    getMessageById.mockResolvedValue({ id: "msg-1", evolution_message_id: "EVO-1" });

    await sendTaskFollowup({ ...baseParams, message: "Texto totalmente diferente" });

    expect(createTaskFollowupSend).toHaveBeenCalledWith({}, expect.objectContaining({ suggestion_status: "edited" }));
  });

  it("respects task_followup_takeover_on_send when the org opted in", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { task_followup_takeover_on_send: true } });
    getMessageById.mockResolvedValue({ id: "msg-1", evolution_message_id: "EVO-1" });

    await sendTaskFollowup(baseParams);

    expect(sendPanelMessage).toHaveBeenCalledWith(expect.objectContaining({ activateTakeover: true }));
  });

  it("returns not_eligible and sends nothing when the task type is not eligible", async () => {
    getTaskById.mockResolvedValue(makeTask({ type: "run_quote" }));

    const result = await sendTaskFollowup(baseParams);

    expect(result).toEqual({ ok: false, reason: "not_eligible", detail: "not_eligible_type" });
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("blocks on min_interval throttle and sends nothing", async () => {
    getLastFollowupSendForInstance.mockResolvedValue({ sent_at: new Date().toISOString() });
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { task_followup_min_interval_seconds: 45 } });

    const result = await sendTaskFollowup(baseParams);

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("min_interval");
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("blocks on daily_limit throttle and sends nothing", async () => {
    countFollowupSendsForInstanceSince.mockResolvedValue(40);
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { task_followup_daily_limit: 40 } });

    const result = await sendTaskFollowup(baseParams);

    expect(result).toEqual({ ok: false, reason: "daily_limit" });
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("leaves the task open and writes nothing when the send itself fails", async () => {
    sendPanelMessage.mockRejectedValue(new Error("Evolution API down"));

    const result = await sendTaskFollowup(baseParams);

    expect(result).toEqual({ ok: false, reason: "send_failed", detail: "Evolution API down" });
    expect(createTaskFollowupSend).not.toHaveBeenCalled();
    expect(addTaskEvent).not.toHaveBeenCalled();
    expect(completeTask).not.toHaveBeenCalled();
  });

  // Point 4a/4b: coordination with the automatic 1h/23h cadence.
  it("blocks with recent_touch when Helena or a human touched the conversation too recently", async () => {
    getRecentMessages.mockResolvedValue([{ role: "agent", created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }]);
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { task_followup_min_hours_since_last_touch: 4 } });

    const result = await sendTaskFollowup(baseParams);

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("recent_touch");
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("blocks with touch_limit_reached when the max touches without reply was hit", async () => {
    countFollowupTouchEventsForConversationSince.mockResolvedValue(3);
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { task_followup_max_touches_without_reply: 3 } });

    const result = await sendTaskFollowup(baseParams);

    expect(result).toEqual({ ok: false, reason: "touch_limit_reached", touchCount: 3 });
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("does not block on coordination when the customer replied last (no pending touch)", async () => {
    getRecentMessages.mockResolvedValue([{ role: "contact", created_at: new Date().toISOString() }]);
    getMessageById.mockResolvedValue({ id: "msg-1", evolution_message_id: "EVO-1" });

    const result = await sendTaskFollowup(baseParams);

    expect(result.ok).toBe(true);
  });

  it("force bypasses coordination blocks but still enforces the anti-ban throttle", async () => {
    getRecentMessages.mockResolvedValue([{ role: "agent", created_at: new Date().toISOString() }]);
    countFollowupTouchEventsForConversationSince.mockResolvedValue(5);
    getLastFollowupSendForInstance.mockResolvedValue({ sent_at: new Date().toISOString() });
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { task_followup_min_interval_seconds: 45 } });

    const result = await sendTaskFollowup({ ...baseParams, force: true });

    // Coordination bypassed, but the instance-level anti-ban throttle is NOT
    // bypassed by force — it protects the number, not the customer relationship.
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("min_interval");
  });

  // Point 2: confirmation flow.
  it("returns unconfirmed and leaves the task open when the send never confirms within the timeout", async () => {
    getMessageById.mockResolvedValue({ id: "msg-1", evolution_message_id: null }); // never confirms

    const result = await sendTaskFollowup({ ...baseParams, confirmationTimeoutMs: 5, confirmationPollIntervalMs: 1 });

    expect(result).toEqual({ ok: false, reason: "unconfirmed", pendingMessageId: "msg-1" });
    expect(setFollowupPendingMessage).toHaveBeenCalledWith({}, "task-1", "msg-1");
    expect(completeTask).not.toHaveBeenCalled();
    // The throttle/audit row is recorded at attempt time regardless of
    // confirmation, so the anti-ban protection holds across retries.
    expect(createTaskFollowupSend).toHaveBeenCalled();
    expect(addTaskEvent).not.toHaveBeenCalled();
  });

  it("re-checks an existing pending send (double-click) instead of sending a new message", async () => {
    getTaskById.mockResolvedValue(makeTask({ followup_pending_message_id: "msg-pending-1" }));
    getMessageById.mockResolvedValue({ id: "msg-pending-1", evolution_message_id: null }); // still unconfirmed

    const result = await sendTaskFollowup({ ...baseParams, confirmationTimeoutMs: 5, confirmationPollIntervalMs: 1 });

    expect(result).toEqual({ ok: false, reason: "unconfirmed", pendingMessageId: "msg-pending-1" });
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("completes the task without resending when a pending send confirms on re-check", async () => {
    getTaskById.mockResolvedValue(makeTask({ followup_pending_message_id: "msg-pending-1" }));
    getMessageById.mockResolvedValue({ id: "msg-pending-1", evolution_message_id: "EVO-CONFIRMED" });

    const result = await sendTaskFollowup(baseParams);

    expect(result).toEqual({ ok: true, task: { id: "task-1", status: "completed" } });
    expect(sendPanelMessage).not.toHaveBeenCalled();
    expect(setFollowupPendingMessage).toHaveBeenCalledWith({}, "task-1", null);
  });

  it("is idempotent when the task is already completed (late duplicate request)", async () => {
    getTaskById.mockResolvedValue(makeTask({ status: "completed" }));

    const result = await sendTaskFollowup(baseParams);

    expect(result).toEqual({ ok: true, task: makeTask({ status: "completed" }) });
    expect(sendPanelMessage).not.toHaveBeenCalled();
  });

  it("force sends a brand-new message even when a prior send is still unconfirmed", async () => {
    getTaskById.mockResolvedValue(makeTask({ followup_pending_message_id: "msg-old-pending" }));
    getMessageById.mockResolvedValue({ id: "msg-1", evolution_message_id: "EVO-1" });

    const result = await sendTaskFollowup({ ...baseParams, force: true });

    expect(sendPanelMessage).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

it("counts confirmed no-task automatic touches when coordinating a later seller followup",async()=>{
 getLastContactMessage.mockResolvedValue({created_at:"2026-10-01T10:00:00Z"});
 getRecentMessages.mockResolvedValue([{role:"agent",created_at:"2026-10-01T11:00:00Z",evolution_message_id:"sent",metadata:{low_intent_followup:{anchor:"2026-10-01T10:00:00Z",stage:1}}},{role:"agent",created_at:"2026-10-02T09:00:00Z",evolution_message_id:"sent2",metadata:{low_intent_followup:{anchor:"2026-10-01T10:00:00Z",stage:2}}}]);
 countFollowupTouchEventsForConversationSince.mockResolvedValue(0);
 const result=await getFollowupTouchInfo({} as any,conversation);expect(result.touchCount).toBe(2);expect(result.lastTouchAt).toBe("2026-10-02T09:00:00Z");
});
