import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequestHumanTool } from "./request-human.js";

const updateConversation = vi.fn();
const createHandoffEvent = vi.fn();
const getOrganizationById = vi.fn();
const getOpenTasksByConversation = vi.fn();
const updateTask = vi.fn();
const addTaskEvent = vi.fn();
const getOpenOpportunitiesByContact = vi.fn();
const createTaskWithDedup = vi.fn();

vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  updateConversation: (...args: unknown[]) => updateConversation(...args),
  createHandoffEvent: (...args: unknown[]) => createHandoffEvent(...args),
  getOrganizationById: (...args: unknown[]) => getOrganizationById(...args),
  getOpenTasksByConversation: (...args: unknown[]) => getOpenTasksByConversation(...args),
  updateTask: (...args: unknown[]) => updateTask(...args),
  addTaskEvent: (...args: unknown[]) => addTaskEvent(...args),
  getOpenOpportunitiesByContact: (...args: unknown[]) => getOpenOpportunitiesByContact(...args),
  createTaskWithDedup: (...args: unknown[]) => createTaskWithDedup(...args),
}));

const addToSendQueue = vi.fn();
vi.mock("@aula-agente/queue", () => ({
  getSendMessageQueue: () => ({ add: (...args: unknown[]) => addToSendQueue(...args) }),
}));

const context = {
  contactId: "contact-1",
  conversationId: "conv-1",
  organizationId: "org-1",
  instanceId: "instance-1",
  phone: "5511999990000",
  businessHoursStartHour: 8,
  businessHoursEndHour: 18,
};

const baseInput = {
  motivo: "cliente_pediu" as const,
  resumo: "Cliente quer negociar desconto na Factor 150",
  urgencia: "normal" as const,
};

const orgNoDefaults = { id: "org-1", settings: {} };

beforeEach(() => {
  vi.resetAllMocks();
  getOrganizationById.mockResolvedValue(orgNoDefaults);
  getOpenTasksByConversation.mockResolvedValue([]);
  createHandoffEvent.mockResolvedValue({ id: "handoff-1" });
  getOpenOpportunitiesByContact.mockResolvedValue([]);
  createTaskWithDedup.mockResolvedValue({ task: { id: "task-1", title: "Outro" }, wasUpdated: false });
});

describe("createRequestHumanTool", () => {
  it("activates is_human_takeover on the conversation", async () => {
    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(updateConversation).toHaveBeenCalledWith(
      {},
      "conv-1",
      expect.objectContaining({ is_human_takeover: true })
    );
  });

  it("records a handoff_events row with trigger_type=request_human and the tool's own fields", async () => {
    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(createHandoffEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        organization_id: "org-1",
        conversation_id: "conv-1",
        trigger_type: "request_human",
        motivo: "cliente_pediu",
        resumo: baseInput.resumo,
        urgencia: "normal",
        criado_por: "ia",
      })
    );
  });

  it("assigns the conversation to the organization's default handoff assignee when configured", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { default_handoff_assignee_id: "user-42" } });

    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(updateConversation).toHaveBeenCalledWith(
      {},
      "conv-1",
      expect.objectContaining({ assigned_to: "user-42" })
    );
  });

  it("does not set assigned_to when no default handoff assignee is configured", async () => {
    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    const call = updateConversation.mock.calls[0][2];
    expect(call).not.toHaveProperty("assigned_to");
  });

  it("reassigns open tasks for the conversation to the default assignee", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: { default_handoff_assignee_id: "user-42" } });
    getOpenTasksByConversation.mockResolvedValue([{ id: "task-1", organization_id: "org-1", status: "pending" }]);
    updateTask.mockResolvedValue({ id: "task-1" });

    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(updateTask).toHaveBeenCalledWith(
      {},
      "task-1",
      expect.objectContaining({ assignee_type: "human", assignee_id: "user-42", status: "in_progress" })
    );
  });

  it("tells the model to mention the current attendant is continuing, during business hours", async () => {
    const toolDef = createRequestHumanTool(context);
    const result = await toolDef.execute!(baseInput, {} as never);

    expect(result).toContain("consultor");
  });

  it("still returns successfully and logs the handoff even if the internal notification isn't configured", async () => {
    const toolDef = createRequestHumanTool(context);
    const result = await toolDef.execute!(baseInput, {} as never);

    expect(addToSendQueue).not.toHaveBeenCalled();
    expect(result).not.toContain("Não foi possível");
  });

  it("enqueues an internal WhatsApp notification when the org configured a notification phone", async () => {
    getOrganizationById.mockResolvedValue({
      id: "org-1",
      settings: { handoff_notification_phone: "5511888880000" },
    });

    const toolDef = createRequestHumanTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(addToSendQueue).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ phone: "5511888880000", instanceId: "instance-1" })
    );
  });

  it("does not fail the whole tool call when creating the handoff event throws", async () => {
    createHandoffEvent.mockRejectedValue(new Error("db blip"));

    const toolDef = createRequestHumanTool(context);
    const result = await toolDef.execute!(baseInput, {} as never);

    expect(result).toContain("Não foi possível");
  });

  // Regression for the 2026-09-28 production incident: org cf01d00d had
  // neither default_handoff_assignee_id nor handoff_notification_phone
  // configured, so the handoff was recorded but nobody — and nothing —
  // ever surfaced it. requestHuman now falls back to creating a task (same
  // opportunity-linking as createTask) whenever neither route exists, so
  // the handoff is at least visible somewhere in the panel.
  describe("fallback task when no assignee/phone is configured", () => {
    it("creates a fallback task when neither a default assignee nor a notification phone is configured", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });

      const toolDef = createRequestHumanTool(context);
      await toolDef.execute!(baseInput, {} as never);

      expect(createTaskWithDedup).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ organization_id: "org-1", contact_id: "contact-1", conversation_id: "conv-1" })
      );
    });

    it("does not create a fallback task when a default assignee is configured", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: { default_handoff_assignee_id: "user-42" } });

      const toolDef = createRequestHumanTool(context);
      await toolDef.execute!(baseInput, {} as never);

      expect(createTaskWithDedup).not.toHaveBeenCalled();
    });

    it("does not create a fallback task when a notification phone is configured", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: { handoff_notification_phone: "5511888880000" } });

      const toolDef = createRequestHumanTool(context);
      await toolDef.execute!(baseInput, {} as never);

      expect(createTaskWithDedup).not.toHaveBeenCalled();
    });

    it("links the fallback task to the contact's sole open opportunity, same as createTask", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
      getOpenOpportunitiesByContact.mockResolvedValue([{ id: "opp-1" }]);

      const toolDef = createRequestHumanTool(context);
      await toolDef.execute!(baseInput, {} as never);

      expect(createTaskWithDedup).toHaveBeenCalledWith({}, expect.objectContaining({ opportunity_id: "opp-1" }));
    });

    it("leaves opportunity_id null when the contact has zero or several open opportunities", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
      getOpenOpportunitiesByContact.mockResolvedValue([{ id: "opp-1" }, { id: "opp-2" }]);

      const toolDef = createRequestHumanTool(context);
      await toolDef.execute!(baseInput, {} as never);

      expect(createTaskWithDedup).toHaveBeenCalledWith({}, expect.objectContaining({ opportunity_id: null }));
    });

    it("still succeeds the handoff even if the fallback task creation throws", async () => {
      getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
      createTaskWithDedup.mockRejectedValue(new Error("db blip"));

      const toolDef = createRequestHumanTool(context);
      const result = await toolDef.execute!(baseInput, {} as never);

      expect(result).not.toContain("Não foi possível");
      expect(createHandoffEvent).toHaveBeenCalled();
    });
  });
});
