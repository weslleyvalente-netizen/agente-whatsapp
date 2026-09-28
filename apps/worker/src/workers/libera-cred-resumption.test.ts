import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  getOpenLiberaCredPlanPresentedOpportunities,
  getOpenTaskByOpportunityAndType,
  getTaskEvents,
  countTaskEventsSince,
  createTaskWithDedup,
  updateTask,
  addTaskEvent,
  resolveApiKey,
  generateLiberaCredResumptionSuggestion,
} = vi.hoisted(() => ({
  getOpenLiberaCredPlanPresentedOpportunities: vi.fn(),
  getOpenTaskByOpportunityAndType: vi.fn(),
  getTaskEvents: vi.fn(),
  countTaskEventsSince: vi.fn(),
  createTaskWithDedup: vi.fn(),
  updateTask: vi.fn(),
  addTaskEvent: vi.fn(),
  resolveApiKey: vi.fn(),
  generateLiberaCredResumptionSuggestion: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getOpenLiberaCredPlanPresentedOpportunities,
  getOpenTaskByOpportunityAndType,
  getTaskEvents,
  countTaskEventsSince,
  createTaskWithDedup,
  updateTask,
  addTaskEvent,
}));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey }));
vi.mock("../lib/libera-cred-resumption-message.js", () => ({ generateLiberaCredResumptionSuggestion }));

import { runLiberaCredResumptionCheck } from "./libera-cred-resumption.js";

const org = {
  id: "org-1",
  name: "Org",
  slug: "org",
  plan: "pro" as const,
  settings: { max_documents: 100, max_agents: 5, max_instances: 3, libera_cred_resumption_enabled: true },
  created_at: "",
  updated_at: "",
};

const agent = { id: "agent-1", provider: "anthropic" as const, model: "claude-sonnet-5" };

function opportunity(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-09-28T12:00:00.000Z");
  return {
    id: "opp-1",
    contact_id: "contact-1",
    credit_amount: 30_000,
    sale_amount: null,
    bid_amount: null,
    waiting_on: null,
    waiting_on_until: null,
    last_progress_at: new Date(now.getTime() - 3 * 86_400_000).toISOString(), // 3 days stalled
    last_interaction_at: new Date(now.getTime() - 1 * 86_400_000).toISOString(),
    created_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
});

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("runLiberaCredResumptionCheck", () => {
  it("does nothing when the org hasn't enabled the flag", async () => {
    const result = await runLiberaCredResumptionCheck(
      {} as never,
      { ...org, settings: { ...org.settings, libera_cred_resumption_enabled: false } },
      agent as never
    );
    expect(result).toEqual({ created: 0, escalated: 0, suggestedLost: 0 });
    expect(getOpenLiberaCredPlanPresentedOpportunities).not.toHaveBeenCalled();
  });

  it("creates a resumption task for a stalled opportunity with no task open yet", async () => {
    getOpenLiberaCredPlanPresentedOpportunities.mockResolvedValue([opportunity()]);
    getOpenTaskByOpportunityAndType.mockResolvedValue(null);
    countTaskEventsSince.mockResolvedValue(0);
    resolveApiKey.mockResolvedValue("key");
    generateLiberaCredResumptionSuggestion.mockResolvedValue({ description: "Oi, tudo bem?", outdated: false });
    createTaskWithDedup.mockResolvedValue({ task: { id: "task-1" }, wasUpdated: false });

    const result = await runLiberaCredResumptionCheck({} as never, org as never, agent as never);

    expect(result.created).toBe(1);
    expect(createTaskWithDedup).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ type: "libera_cred_resumption", opportunity_id: "opp-1" })
    );
    expect(addTaskEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ task_id: "task-1", event_type: "libera_cred_resumption_created" })
    );
  });

  it("does not create a task before day 2 stalled", async () => {
    getOpenLiberaCredPlanPresentedOpportunities.mockResolvedValue([
      opportunity({ last_progress_at: new Date("2026-09-28T00:00:00.000Z").toISOString() }),
    ]);
    getOpenTaskByOpportunityAndType.mockResolvedValue(null);

    const result = await runLiberaCredResumptionCheck({} as never, org as never, agent as never);

    expect(result.created).toBe(0);
    expect(createTaskWithDedup).not.toHaveBeenCalled();
  });

  it("skips opportunities waiting on the team or bank/administradora — not the customer's move", async () => {
    getOpenLiberaCredPlanPresentedOpportunities.mockResolvedValue([opportunity({ waiting_on: "bank_or_admin" })]);

    const result = await runLiberaCredResumptionCheck({} as never, org as never, agent as never);

    expect(result.created).toBe(0);
    expect(getOpenTaskByOpportunityAndType).not.toHaveBeenCalled();
  });

  it("skips opportunities whose contact hasn't interacted within the configured window", async () => {
    getOpenLiberaCredPlanPresentedOpportunities.mockResolvedValue([
      opportunity({ last_interaction_at: new Date("2026-08-01T00:00:00.000Z").toISOString() }),
    ]);

    const result = await runLiberaCredResumptionCheck({} as never, org as never, agent as never);

    expect(result.created).toBe(0);
    expect(getOpenTaskByOpportunityAndType).not.toHaveBeenCalled();
  });

  it("respects the daily creation limit, even with several candidates", async () => {
    getOpenLiberaCredPlanPresentedOpportunities.mockResolvedValue([
      opportunity({ id: "opp-1" }),
      opportunity({ id: "opp-2" }),
    ]);
    getOpenTaskByOpportunityAndType.mockResolvedValue(null);
    countTaskEventsSince.mockResolvedValue(0);
    resolveApiKey.mockResolvedValue("key");
    generateLiberaCredResumptionSuggestion.mockResolvedValue({ description: "msg", outdated: false });
    createTaskWithDedup.mockResolvedValue({ task: { id: "task-x" }, wasUpdated: false });

    const orgWithLimit = { ...org, settings: { ...org.settings, libera_cred_resumption_daily_limit: 1 } };
    const result = await runLiberaCredResumptionCheck({} as never, orgWithLimit as never, agent as never);

    expect(result.created).toBe(1);
    expect(createTaskWithDedup).toHaveBeenCalledTimes(1);
  });

  it("escalates an existing task at day 7 and bumps its priority", async () => {
    getOpenLiberaCredPlanPresentedOpportunities.mockResolvedValue([
      opportunity({ last_progress_at: new Date("2026-09-21T12:00:00.000Z").toISOString() }), // 7 days
    ]);
    getOpenTaskByOpportunityAndType.mockResolvedValue({ id: "task-1", description: "old" });
    getTaskEvents.mockResolvedValue([]);
    resolveApiKey.mockResolvedValue("key");
    generateLiberaCredResumptionSuggestion.mockResolvedValue({ description: "nova msg", outdated: false });

    const result = await runLiberaCredResumptionCheck({} as never, org as never, agent as never);

    expect(result.escalated).toBe(1);
    expect(updateTask).toHaveBeenCalledWith(
      {},
      "task-1",
      expect.objectContaining({ priority: "urgent", description: "nova msg" })
    );
    expect(addTaskEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ event_type: "libera_cred_resumption_escalated" })
    );
  });

  it("suggests marking as lost past day 7 without touching opportunity/task status", async () => {
    getOpenLiberaCredPlanPresentedOpportunities.mockResolvedValue([
      opportunity({ last_progress_at: new Date("2026-09-19T12:00:00.000Z").toISOString() }), // 9 days
    ]);
    getOpenTaskByOpportunityAndType.mockResolvedValue({ id: "task-1", description: "old desc" });
    getTaskEvents.mockResolvedValue([{ event_type: "libera_cred_resumption_escalated" }]);

    const result = await runLiberaCredResumptionCheck({} as never, org as never, agent as never);

    expect(result.suggestedLost).toBe(1);
    expect(addTaskEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ event_type: "libera_cred_resumption_suggest_lost" })
    );
    // Never auto-marks the opportunity itself as lost — only appends a suggestion.
    expect(updateTask).toHaveBeenCalledWith({}, "task-1", expect.objectContaining({ description: expect.stringContaining("sem_resposta") }));
  });

  it("does not re-suggest lost once already logged", async () => {
    getOpenLiberaCredPlanPresentedOpportunities.mockResolvedValue([
      opportunity({ last_progress_at: new Date("2026-09-10T12:00:00.000Z").toISOString() }),
    ]);
    getOpenTaskByOpportunityAndType.mockResolvedValue({ id: "task-1", description: "old" });
    getTaskEvents.mockResolvedValue([
      { event_type: "libera_cred_resumption_escalated" },
      { event_type: "libera_cred_resumption_suggest_lost" },
    ]);

    const result = await runLiberaCredResumptionCheck({} as never, org as never, agent as never);

    expect(result).toEqual({ created: 0, escalated: 0, suggestedLost: 0 });
    expect(addTaskEvent).not.toHaveBeenCalled();
  });
});
