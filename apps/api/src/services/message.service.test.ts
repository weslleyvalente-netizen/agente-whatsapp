import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAdminClient, createMessage, messageExistsByEvolutionId, updateConversation } = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})),
  createMessage: vi.fn(),
  messageExistsByEvolutionId: vi.fn(),
  updateConversation: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getAdminClient,
  createMessage,
  messageExistsByEvolutionId,
  updateConversation,
}));

import { saveMessage } from "./message.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  createMessage.mockResolvedValue({ id: "msg-new" });
  updateConversation.mockResolvedValue(undefined);
});

describe("saveMessage — echo idempotency", () => {
  // The bug this closes: /messages/send used to save with
  // evolutionMessageId: null, so a message's own echo (arriving later with
  // the real Evolution id, once the worker backfills it — see
  // apps/worker/src/workers/send-message.ts) never matched here and got
  // duplicated. This proves the idempotency check itself is correct once
  // there's something to match against; the fix that makes there be
  // something to match against lives in the worker.
  it("returns null and never inserts when evolutionMessageId already exists (the echo case)", async () => {
    messageExistsByEvolutionId.mockResolvedValue(true);

    const result = await saveMessage({
      conversationId: "conv-1",
      organizationId: "org-1",
      evolutionMessageId: "EVO-123",
      role: "human_agent",
      content: "Já te respondo!",
    });

    expect(result).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
    expect(updateConversation).not.toHaveBeenCalled();
  });

  it("inserts normally when evolutionMessageId is new", async () => {
    messageExistsByEvolutionId.mockResolvedValue(false);

    const result = await saveMessage({
      conversationId: "conv-1",
      organizationId: "org-1",
      evolutionMessageId: "EVO-456",
      role: "human_agent",
      content: "Oi!",
    });

    expect(result).toEqual({ id: "msg-new" });
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  // Documents the pre-fix shape of the gap: when evolutionMessageId is null
  // (what /messages/send used to always pass), the idempotency check is
  // skipped entirely because there's nothing to match against — this is
  // expected/correct for a message with no Evolution id yet, and is exactly
  // why the worker backfilling the real id (Tarefa 2) is the actual fix,
  // not a change to this function.
  it("skips the idempotency check and always inserts when evolutionMessageId is null", async () => {
    const result = await saveMessage({
      conversationId: "conv-1",
      organizationId: "org-1",
      evolutionMessageId: null,
      role: "human_agent",
      content: "Oi!",
    });

    expect(messageExistsByEvolutionId).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "msg-new" });
  });
});
