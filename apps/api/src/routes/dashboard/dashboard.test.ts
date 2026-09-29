import { describe, it, expect } from "vitest";
import { buildDashboardSummary, buildPendingHandoffs, buildTodayPriorityList } from "./index.js";
import { DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS } from "@aula-agente/shared";
import type { OpenTaskWithScoreInputs } from "@aula-agente/database";

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

  it("clears the pending contact timestamp on a human_agent reply without counting it as an answer", () => {
    const humanTakeoverMessages = [
      // Answered by a human — should be excluded from the average entirely,
      // and must not stay "pending" to be incorrectly paired with a later bot reply.
      { conversation_id: "c5", role: "contact", created_at: "2026-07-20T13:00:00.000Z" },
      { conversation_id: "c5", role: "human_agent", created_at: "2026-07-20T13:00:20.000Z" },
      // A separate, unrelated contact message later answered by the bot — this is the
      // only pair that should contribute to the average (40s).
      { conversation_id: "c5", role: "contact", created_at: "2026-07-20T13:05:00.000Z" },
      { conversation_id: "c5", role: "agent", created_at: "2026-07-20T13:05:40.000Z" },
    ];
    const result = buildDashboardSummary(conversations, humanTakeoverMessages, [], {});
    expect(result.avgResponseSeconds).toBe(40);
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

describe("buildPendingHandoffs (card \"Handoffs aguardando\" — Fase 1)", () => {
  const now = new Date("2026-09-28T12:00:00.000Z").getTime();

  const rowMinutesAgo = (minutesAgo: number, overrides: Record<string, unknown> = {}) => ({
    id: `handoff-${minutesAgo}`,
    conversation_id: `conv-${minutesAgo}`,
    handed_at: new Date(now - minutesAgo * 60_000).toISOString(),
    motivo: "cliente_pediu",
    resumo: "Cliente quer negociar",
    urgencia: "normal",
    conversations: { wa_contacts: { name: "Ana", phone: "5511999990000" } },
    ...overrides,
  });

  it("computes minutes waited for each pending handoff", () => {
    const result = buildPendingHandoffs([rowMinutesAgo(10)], now, 15);
    expect(result[0].waitMinutes).toBe(10);
  });

  it("flags a handoff as unanswered once it crosses the configured alert threshold", () => {
    const result = buildPendingHandoffs([rowMinutesAgo(20), rowMinutesAgo(5)], now, 15);
    expect(result.find((r) => r.waitMinutes === 20)?.unanswered).toBe(true);
    expect(result.find((r) => r.waitMinutes === 5)?.unanswered).toBe(false);
  });

  it("sorts by longest wait first", () => {
    const result = buildPendingHandoffs([rowMinutesAgo(5), rowMinutesAgo(30), rowMinutesAgo(15)], now, 15);
    expect(result.map((r) => r.waitMinutes)).toEqual([30, 15, 5]);
  });

  it("carries the contact name/phone and the handoff's own fields through", () => {
    const result = buildPendingHandoffs([rowMinutesAgo(10)], now, 15);
    expect(result[0]).toMatchObject({
      contactName: "Ana",
      contactPhone: "5511999990000",
      motivo: "cliente_pediu",
      resumo: "Cliente quer negociar",
      urgencia: "normal",
    });
  });

  it("falls back to null/empty contact fields when wa_contacts is missing", () => {
    const result = buildPendingHandoffs([rowMinutesAgo(10, { conversations: null })], now, 15);
    expect(result[0].contactName).toBeNull();
    expect(result[0].contactPhone).toBe("");
  });
});

describe("buildTodayPriorityList (visão \"Hoje\" — Fase 2, item 4)", () => {
  const today = "2026-09-28";

  function row(overrides: Partial<OpenTaskWithScoreInputs> = {}): OpenTaskWithScoreInputs {
    return {
      task: {
        id: "task-1",
        organization_id: "org-1",
        contact_id: "contact-1",
        conversation_id: "conv-1",
        opportunity_id: null,
        assignee_type: null,
        assignee_id: null,
        type: "run_quote",
        title: "Fazer simulação",
        description: "desc",
        ai_summary: null,
        reason: null,
        priority: "normal",
        status: "pending",
        due_date: "2026-09-28",
        due_time: null,
        created_by_type: "ai",
        created_by_id: null,
        completed_at: null,
        created_at: "2026-09-20T00:00:00Z",
        updated_at: "2026-09-20T00:00:00Z",
        consolidated_pendencies: [],
        followup_suggested_message: null,
        followup_suggestion_generated_at: null,
        followup_regeneration_count: 0,
        followup_pending_message_id: null,
      },
      contactName: "Ana",
      contactPhone: "5511999990000",
      opportunity: null,
      qualificationUrgency: null,
      ...overrides,
    };
  }

  it("scores a plain task with no opportunity using only priority/due-date/waiting_on-null", () => {
    const result = buildTodayPriorityList([row()], new Set(), today, DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS, 10);
    // normal(0) + today(8) + waiting_on-null baseline(5) = 13
    expect(result[0].score).toBe(13);
  });

  it("ranks an urgent, unanswered-handoff task above a routine one", () => {
    const routine = row({ task: { ...row().task, id: "task-routine", priority: "low" } });
    const hot = row({
      task: { ...row().task, id: "task-hot", conversation_id: "conv-hot", priority: "urgent" },
    });
    const result = buildTodayPriorityList(
      [routine, hot],
      new Set(["conv-hot"]),
      today,
      DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS,
      10
    );
    expect(result[0].taskId).toBe("task-hot");
  });

  it("factors in the linked opportunity's value, stage, and staleness", () => {
    const withOpp = row({
      task: { ...row().task, id: "task-opp", opportunity_id: "opp-1" },
      opportunity: {
        operation: "libera_cred",
        stage: "plan_term_presented",
        credit_amount: 50_000,
        sale_amount: null,
        bid_amount: null,
        waiting_on: null,
        waiting_on_until: null,
        last_progress_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        last_interaction_at: null,
        created_at: "2026-09-01T00:00:00Z",
      },
    });
    const withoutOpp = row({ task: { ...row().task, id: "task-bare" } });

    const result = buildTodayPriorityList(
      [withoutOpp, withOpp],
      new Set(),
      today,
      DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS,
      10
    );
    expect(result[0].taskId).toBe("task-opp");
  });

  it("respects an organization's custom score weights", () => {
    const customWeights = { ...DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS, priority: { ...DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS.priority, low: 1000 } };
    const result = buildTodayPriorityList(
      [row({ task: { ...row().task, priority: "low" } })],
      new Set(),
      today,
      customWeights,
      10
    );
    expect(result[0].score).toBeGreaterThan(1000);
  });

  it("limits the result to the requested count, highest score first", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      row({ task: { ...row().task, id: `task-${i}`, priority: i === 7 ? "urgent" : "low" } })
    );
    const result = buildTodayPriorityList(rows, new Set(), today, DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS, 10);
    expect(result).toHaveLength(10);
    expect(result[0].taskId).toBe("task-7");
  });
});
