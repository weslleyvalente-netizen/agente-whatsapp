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
  recordHumanMessage,
} = vi.hoisted(() => ({
  recordHumanMessage: vi.fn().mockResolvedValue("assign-1"),
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
  recordHumanMessage,
}));
// Espião sobre a implementação real: verifica a chamada e também o filtro de origem humana de verdade.
vi.mock("./lead-human-message.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lead-human-message.js")>();
  return { trackFirstHumanMessage: vi.fn(actual.trackFirstHumanMessage) };
});
import { trackFirstHumanMessage } from "./lead-human-message.js";
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
      expect.objectContaining({ conversationId: "conv-1", messageId: "msg-1", instanceId: "instance-1" }),
      undefined
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

  // Point 2: follow-up-from-task opts out of BullMQ's own retry so an
  // ambiguous timeout can never resolve into a silent second send — the
  // confirmation flow is the only path allowed to send again, and only
  // with an explicit force.
  it("passes attempts: 1 to the queue when noAutoRetry is set", async () => {
    await sendPanelMessage({
      conversation: baseConversation,
      content: "Follow-up",
      actorUserId: "user-1",
      activateTakeover: false,
      noAutoRetry: true,
    });

    expect(enqueueSendMessage).toHaveBeenCalledWith(expect.anything(), { attempts: 1 });
  });

  it("does not override the queue's default retry behavior when noAutoRetry is not set", async () => {
    await sendPanelMessage({ conversation: baseConversation, content: "Oi", actorUserId: "user-1" });

    expect(enqueueSendMessage).toHaveBeenCalledWith(expect.anything(), undefined);
  });
});

describe("sendPanelMessage — primeira mensagem humana (distribuição de leads)", () => {
  // saveMessage devolve a linha gravada (role incluso); o papel vem dela.
  beforeEach(() => { saveMessage.mockResolvedValue({ id: "msg-1", role: "human_agent" }); });

  it("chama trackFirstHumanMessage com papel, autor e metadata, e o aceite vai como 'panel' do autor", async () => {
    await sendPanelMessage({ conversation: baseConversation, content: "Oi, sou a Marina", actorUserId: "user-1" });
    expect(trackFirstHumanMessage).toHaveBeenCalledWith({}, expect.objectContaining({
      organizationId: "org-1", conversationId: "conv-1", role: "human_agent", source: "panel", actorUserId: "user-1", metadata: null,
    }));
    expect(recordHumanMessage).toHaveBeenCalledWith({}, expect.objectContaining({ organizationId: "org-1", conversationId: "conv-1", authorUserId: "user-1", via: "panel" }));
  });

  it("mensagem de follow-up de tarefa (metadata source=task_followup) ainda conta como humana", async () => {
    await sendPanelMessage({ conversation: baseConversation, content: "Passando para lembrar", actorUserId: "user-1", metadata: { source: "task_followup" } });
    expect(trackFirstHumanMessage).toHaveBeenCalledWith({}, expect.objectContaining({ metadata: { source: "task_followup" }, actorUserId: "user-1" }));
    expect(recordHumanMessage).toHaveBeenCalledWith({}, expect.objectContaining({ authorUserId: "user-1", via: "panel" }));
  });

  it("falha ao registrar não derruba o envio", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    recordHumanMessage.mockRejectedValueOnce(new Error("rpc down"));
    const result = await sendPanelMessage({ conversation: baseConversation, content: "Oi", actorUserId: "user-1" });
    expect(result.message.id).toBe("msg-1");
    expect(enqueueSendMessage).toHaveBeenCalled();
    log.mockRestore();
  });
});
