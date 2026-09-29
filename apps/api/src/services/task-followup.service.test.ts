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
}));
vi.mock("./message-send.service.js", () => ({ sendPanelMessage }));
vi.mock("./task.service.js", () => ({ completeTask }));

import { resolveTaskFollowupEligibility, sendTaskFollowup } from "./task-followup.service.js";

const conversation = {
  id: "conv-1",
  organization_id: "org-1",
  is_human_takeover: false,
  evolution_instance_id: "instance-1",
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
    followup_suggested_message: "Oi! Ainda pensando na proposta?",
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
  sendPanelMessage.mockResolvedValue({ message: { id: "msg-1" }, instanceId: "instance-1" });
  completeTask.mockResolvedValue({ id: "task-1", status: "completed" });
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

  it("sends, marks the send as original, and completes the task on the happy path", async () => {
    const result = await sendTaskFollowup(baseParams);

    expect(result).toEqual({ ok: true, task: { id: "task-1", status: "completed" } });
    expect(sendPanelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversation, content: baseParams.message, activateTakeover: false })
    );
    expect(createTaskFollowupSend).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ suggestion_status: "original", instance_id: "instance-1" })
    );
    expect(addTaskEvent).toHaveBeenCalledWith({}, expect.objectContaining({ event_type: "followup_sent" }));
    expect(completeTask).toHaveBeenCalled();
  });

  it("marks the send as edited when the sent text differs from the stored suggestion", async () => {
    await sendTaskFollowup({ ...baseParams, message: "Texto totalmente diferente" });

    expect(createTaskFollowupSend).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ suggestion_status: "edited" })
    );
  });

  it("respects task_followup_takeover_on_send when the org opted in", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { task_followup_takeover_on_send: true } });

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
});
