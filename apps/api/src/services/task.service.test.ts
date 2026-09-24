import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateTask, addTaskEvent, getOpenTasksByConversation } = vi.hoisted(() => ({
  updateTask: vi.fn(),
  addTaskEvent: vi.fn(),
  getOpenTasksByConversation: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ updateTask, addTaskEvent, getOpenTasksByConversation }));

import { handleConversationTakeover } from "./task.service.js";

const pendingTask1 = { id: "task-1", organization_id: "org-1", status: "pending" };
const pendingTask2 = { id: "task-2", organization_id: "org-1", status: "pending" };
const inProgressTask = { id: "task-3", organization_id: "org-1", status: "in_progress" };
const reassignedTask = (id: string, status = "in_progress") => ({
  id,
  organization_id: "org-1",
  status,
  assignee_type: "human",
  assignee_id: "user-1",
});

describe("handleConversationTakeover", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("does nothing and returns an empty list when the conversation has no open task", async () => {
    getOpenTasksByConversation.mockResolvedValue([]);

    const result = await handleConversationTakeover({} as any, "org-1", "conv-1", "user-1");

    expect(result).toEqual([]);
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTaskEvent).not.toHaveBeenCalled();
  });

  it("reassigns a pending task to the human and moves it to in_progress, WITHOUT completing it", async () => {
    getOpenTasksByConversation.mockResolvedValue([pendingTask1]);
    updateTask.mockResolvedValue(reassignedTask("task-1"));
    addTaskEvent.mockResolvedValue({});

    const result = await handleConversationTakeover({} as any, "org-1", "conv-1", "user-1");

    expect(getOpenTasksByConversation).toHaveBeenCalledWith({}, "org-1", "conv-1");
    expect(updateTask).toHaveBeenCalledWith(
      {},
      "task-1",
      expect.objectContaining({ assignee_type: "human", assignee_id: "user-1", status: "in_progress" })
    );
    // The bug this replaces: no call should ever set status to "completed" here.
    expect(updateTask).not.toHaveBeenCalledWith({}, "task-1", expect.objectContaining({ status: "completed" }));
    expect(addTaskEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        task_id: "task-1",
        organization_id: "org-1",
        event_type: "assigned",
        created_by_type: "human",
        created_by_id: "user-1",
      })
    );
    expect(result).toEqual([reassignedTask("task-1")]);
  });

  it("leaves an already in_progress task's status alone (does not bounce it back from further-along states)", async () => {
    getOpenTasksByConversation.mockResolvedValue([inProgressTask]);
    updateTask.mockResolvedValue(reassignedTask("task-3", "in_progress"));
    addTaskEvent.mockResolvedValue({});

    await handleConversationTakeover({} as any, "org-1", "conv-1", "user-1");

    expect(updateTask).toHaveBeenCalledWith(
      {},
      "task-3",
      expect.objectContaining({ assignee_type: "human", assignee_id: "user-1", status: "in_progress" })
    );
  });

  // The fromMe path (human replies from their own phone, not the dashboard)
  // has no dashboard session, so actorId is null. The tasks.assignee
  // consistency check rejects assignee_type='human' with a null
  // assignee_id, so we must skip assignee fields entirely in that case —
  // not send a doomed update.
  it("does not set assignee fields when actorId is null (fromMe takeover, no dashboard session)", async () => {
    getOpenTasksByConversation.mockResolvedValue([pendingTask1]);
    updateTask.mockResolvedValue({ ...pendingTask1, status: "in_progress" });
    addTaskEvent.mockResolvedValue({});

    await handleConversationTakeover({} as any, "org-1", "conv-1", null);

    expect(updateTask).toHaveBeenCalledWith({}, "task-1", { status: "in_progress" });
    expect(addTaskEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ created_by_type: "human", created_by_id: null })
    );
  });

  // Regression: a conversation with two simultaneously-open tasks (e.g. a
  // financing_followup created before a vehicle_followup) used to leave the
  // older one open forever, since only the most-recently-created open task
  // was ever looked up. Both must be handled independently — not merged
  // into one action.
  it("reassigns every open task independently, not just the most recently created one", async () => {
    getOpenTasksByConversation.mockResolvedValue([pendingTask2, pendingTask1]);
    updateTask.mockImplementation((_db: unknown, id: string) => Promise.resolve(reassignedTask(id)));
    addTaskEvent.mockResolvedValue({});

    const result = await handleConversationTakeover({} as any, "org-1", "conv-1", "user-1");

    expect(updateTask).toHaveBeenCalledWith({}, "task-1", expect.objectContaining({ status: "in_progress" }));
    expect(updateTask).toHaveBeenCalledWith({}, "task-2", expect.objectContaining({ status: "in_progress" }));
    expect(result).toEqual(expect.arrayContaining([reassignedTask("task-1"), reassignedTask("task-2")]));
  });

  // Regression fixtures shaped after real September conversations (no real
  // customer data — only the task-type/status shape that exposed the bug).
  // Source: docs/superpowers/plans/investigation/03-tasks-funil-historical-cases.md
  describe("regressão: casos reais de setembro (task ficava completed, deveria ficar in_progress)", () => {
    const scenarios: Array<{ name: string; taskType: string }> = [
      { name: "Eder Reis — stalled_negotiation fechada 3s depois de 'Boa tarde' do humano", taskType: "stalled_negotiation" },
      { name: "Rogerio — proposal_followup + customer_unresponsive fechadas no instante do 'Boa tarde', negociação real (troca FZ25→FZ15) continuou depois", taskType: "proposal_followup" },
      { name: "Izabela — consortium_followup fechada 11s depois do takeover, cliente ainda mudaria de modalidade", taskType: "consortium_followup" },
      { name: "mikaelkawz — financing_followup/run_quote fechadas ANTES da resposta de recusa do banco chegar", taskType: "financing_followup" },
      { name: "Josemario — vehicle_followup: caso de controle, data já estava certa; aqui só confirma que reassign não quebra esse fluxo", taskType: "vehicle_followup" },
    ];

    it.each(scenarios)("$name", async ({ taskType }) => {
      const task = { id: "task-x", organization_id: "org-1", status: "pending", type: taskType };
      getOpenTasksByConversation.mockResolvedValue([task]);
      updateTask.mockResolvedValue({ ...task, status: "in_progress", assignee_type: "human", assignee_id: "user-1" });
      addTaskEvent.mockResolvedValue({});

      await handleConversationTakeover({} as any, "org-1", "conv-1", "user-1");

      // The bug: this call used to be { status: "completed", completed_at: ... }
      // the instant a human sent literally anything ("Bom dia"/"Boa tarde").
      expect(updateTask).toHaveBeenCalledWith(
        {},
        "task-x",
        expect.objectContaining({ status: "in_progress" })
      );
      expect(updateTask).not.toHaveBeenCalledWith({}, "task-x", expect.objectContaining({ status: "completed" }));
    });
  });
});
