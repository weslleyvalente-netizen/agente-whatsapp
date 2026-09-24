import { describe, it, expect, vi, beforeEach } from "vitest";

const { add } = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock("@aula-agente/queue", () => ({
  getProcessMessageQueue: () => ({ add }),
  getSendMessageQueue: () => ({ add: vi.fn() }),
}));

import { enqueueProcessMessage } from "./queue.js";

describe("enqueueProcessMessage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // This delay + deduplication pair is the whole mechanism behind grouping
  // consecutive customer messages into one agent turn (see
  // apps/worker/src/workers/process-message.ts) — a regression here would
  // silently bring back one-reply-per-message duplication.
  it("delays the job and dedupes by conversation so rapid consecutive messages collapse into one job", async () => {
    await enqueueProcessMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      agentId: "agent-1",
      organizationId: "org-1",
    });

    expect(add).toHaveBeenCalledWith(
      "process-message",
      { conversationId: "conv-1", messageId: "msg-1", agentId: "agent-1", organizationId: "org-1" },
      expect.objectContaining({
        delay: expect.any(Number),
        deduplication: { id: "conv-1", replace: true },
      })
    );
  });

  it("dedupes by conversationId, not messageId, so two different conversations never collide", async () => {
    await enqueueProcessMessage({ conversationId: "conv-a", messageId: "msg-1", agentId: "agent-1", organizationId: "org-1" });
    await enqueueProcessMessage({ conversationId: "conv-b", messageId: "msg-2", agentId: "agent-1", organizationId: "org-1" });

    expect(add.mock.calls[0][2].deduplication).toEqual({ id: "conv-a", replace: true });
    expect(add.mock.calls[1][2].deduplication).toEqual({ id: "conv-b", replace: true });
  });
});
