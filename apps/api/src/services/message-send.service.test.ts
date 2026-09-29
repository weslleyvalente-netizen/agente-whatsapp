import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  saveMessage,
  updateConversation,
  getInstanceById,
  createHandoffEvent,
  getOpenHandoffEvent,
  markFirstHumanReply,
  handleConversationTakeover,
  enqueueSendMessage,
} = vi.hoisted(() => ({
  saveMessage: vi.fn(),
  updateConversation: vi.fn().mockResolvedValue(undefined),
  getInstanceById: vi.fn(),
  createHandoffEvent: vi.fn().mockResolvedValue({ id: "handoff-1" }),
  getOpenHandoffEvent: vi.fn().mockResolvedValue(null),
  markFirstHumanReply: vi.fn().mockResolvedValue(undefined),
  handleConversationTakeover: vi.fn().mockResolvedValue(undefined),
  enqueueSendMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./message.service.js", () => ({ saveMessage }));
vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  updateConversation,
  getInstanceById,
  createHandoffEvent,
  getOpenHandoffEvent,
  markFirstHumanReply,
}));
vi.mock("./task.service.js", () => ({ handleConversationTakeover }));
vi.mock("../lib/queue.js", () => ({ enqueueSendMessage }));

import { sendPanelMessage } from "./message-send.service.js";

const baseConversation = {
  id: "conv-1",
  organization_id: "org-1",
  is_human_takeover: false,
  evolution_instance_id: "evo-inst-1",
  wa_contacts: { phone: "5511999999999" },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  saveMessage.mockResolvedValue({ id: "msg-1" });
  getInstanceById.mockResolvedValue({ id: "instance-1", instance_name: "loja-1" });
  getOpenHandoffEvent.mockResolvedValue(null);
});

describe("sendPanelMessage", () => {
  it("activates takeover on first send (default), reassigns task, and logs painel_manual", async () => {
    const result = await sendPanelMessage({
      conversation: baseConversation,
      content: "Oi!",
      actorUserId: "user-1",
    });

    expect(result.message.id).toBe("msg-1");
    expect(updateConversation).toHaveBeenCalledWith(
      {},
      "conv-1",
      expect.objectContaining({ is_human_takeover: true, assigned_to: "user-1" })
    );
    expect(handleConversationTakeover).toHaveBeenCalledWith({}, "org-1", "conv-1", "user-1");
    expect(createHandoffEvent).toHaveBeenCalledWith({}, expect.objectContaining({ trigger_type: "painel_manual" }));
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", messageId: "msg-1", instanceId: "instance-1" })
    );
  });

  it("does not set assigned_to or re-reassign when takeover was already active", async () => {
    await sendPanelMessage({
      conversation: { ...baseConversation, is_human_takeover: true },
      content: "Oi de novo",
      actorUserId: "user-1",
    });

    expect(updateConversation).toHaveBeenCalledWith(
      {},
      "conv-1",
      expect.not.objectContaining({ assigned_to: expect.anything() })
    );
    expect(handleConversationTakeover).not.toHaveBeenCalled();
    expect(createHandoffEvent).not.toHaveBeenCalled();
  });

  it("skips all takeover/handoff bookkeeping when activateTakeover is false (follow-up-from-task default)", async () => {
    await sendPanelMessage({
      conversation: baseConversation,
      content: "Follow-up sugerido",
      actorUserId: "user-1",
      activateTakeover: false,
    });

    expect(updateConversation).not.toHaveBeenCalled();
    expect(handleConversationTakeover).not.toHaveBeenCalled();
    expect(createHandoffEvent).not.toHaveBeenCalled();
    expect(enqueueSendMessage).toHaveBeenCalled();
  });

  it("still closes an existing open requestHuman handoff loop even when activateTakeover is false", async () => {
    getOpenHandoffEvent.mockResolvedValue({ id: "open-handoff-1" });

    await sendPanelMessage({
      conversation: baseConversation,
      content: "Follow-up",
      actorUserId: "user-1",
      activateTakeover: false,
    });

    expect(markFirstHumanReply).toHaveBeenCalledWith({}, "open-handoff-1", expect.any(String));
  });

  it("passes metadata through to saveMessage", async () => {
    await sendPanelMessage({
      conversation: baseConversation,
      content: "Follow-up",
      actorUserId: "user-1",
      activateTakeover: false,
      metadata: { source: "task_followup", task_id: "task-1" },
    });

    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { source: "task_followup", task_id: "task-1" } })
    );
  });

  it("throws when saveMessage returns null (echo/duplicate)", async () => {
    saveMessage.mockResolvedValue(null);

    await expect(
      sendPanelMessage({ conversation: baseConversation, content: "Oi", actorUserId: "user-1" })
    ).rejects.toThrow();

    expect(enqueueSendMessage).not.toHaveBeenCalled();
  });
});
