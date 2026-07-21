import { describe, it, expect } from "vitest";
import { buildDashboardSummary } from "./index.js";

describe("buildDashboardSummary", () => {
  const conversations = [
    { id: "c1", status: "open" },
    { id: "c2", status: "waiting" },
    { id: "c3", status: "resolved" },
    { id: "c4", status: "closed" },
  ];

  const windowMessages = [
    { conversation_id: "c1", role: "contact", created_at: "2026-07-20T10:00:00.000Z" },
    { conversation_id: "c1", role: "agent", created_at: "2026-07-20T10:00:30.000Z" },
    { conversation_id: "c2", role: "contact", created_at: "2026-07-20T11:00:00.000Z" },
    { conversation_id: "c2", role: "contact", created_at: "2026-07-20T11:00:10.000Z" },
    { conversation_id: "c2", role: "agent", created_at: "2026-07-20T11:01:30.000Z" },
    { conversation_id: "c2", role: "contact", created_at: "2026-07-20T11:05:00.000Z" },
    { conversation_id: "c3", role: "contact", created_at: "2026-07-20T09:00:00.000Z" },
  ];

  const takeoverConversations = [
    {
      id: "t1",
      human_takeover_at: "2026-07-19T08:00:00.000Z",
      wa_contacts: { name: null, phone: "5511999990000" },
    },
    {
      id: "t2",
      human_takeover_at: "2026-07-19T09:00:00.000Z",
      wa_contacts: { name: "Bruno", phone: "5511999991111" },
    },
  ];

  const lastMessageByConversationId = {
    t1: { role: "contact", content: "Ainda estou esperando", created_at: "2026-07-20T12:00:00.000Z" },
    t2: { role: "human_agent", content: "Já te respondi, tudo certo!", created_at: "2026-07-20T12:30:00.000Z" },
  };

  it("counts distinct conversations with activity in the window, regardless of status", () => {
    const result = buildDashboardSummary(conversations, windowMessages, [], {});
    expect(result.conversationsLast7d).toBe(3); // c1, c2, c3 — c4 has no messages in the window
  });

  it("counts only open/waiting conversations as in progress", () => {
    const result = buildDashboardSummary(conversations, windowMessages, [], {});
    expect(result.inProgress).toBe(2); // c1 (open), c2 (waiting) — not c3 (resolved) or c4 (closed)
  });

  it("averages response time between a contact message and the next agent reply, ignoring unanswered contact messages", () => {
    const result = buildDashboardSummary(conversations, windowMessages, [], {});
    // c1: 30s. c2: the contact message at 11:00:00 pairs with the agent
    // reply at 11:01:30 (90s) — the contact message at 11:00:10 is ignored
    // because a reply was already pending, and the contact message at
    // 11:05:00 has no following agent reply so it's excluded entirely.
    expect(result.avgResponseSeconds).toBe(60); // (30 + 90) / 2
  });

  it("returns null response time when there are no answered pairs in the window", () => {
    const result = buildDashboardSummary(conversations, [], [], {});
    expect(result.avgResponseSeconds).toBeNull();
  });

  it("only surfaces takeover conversations whose last message is still from the contact", () => {
    const result = buildDashboardSummary(conversations, [], takeoverConversations, lastMessageByConversationId);

    expect(result.needsAttention).toBe(1);
    expect(result.urgentConversations).toEqual([
      {
        conversationId: "t1",
        contactName: null,
        contactPhone: "5511999990000",
        lastMessagePreview: "Ainda estou esperando",
        lastMessageAt: "2026-07-20T12:00:00.000Z",
      },
    ]);
  });
});
