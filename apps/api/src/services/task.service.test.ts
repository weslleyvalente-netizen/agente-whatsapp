import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateTask, addTaskEvent, getOpenTasksByConversation } = vi.hoisted(() => ({
  updateTask: vi.fn(),
  addTaskEvent: vi.fn(),
  getOpenTasksByConversation: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ updateTask, addTaskEvent, getOpenTasksByConversation }));

import { autoCompleteConversationTask } from "./task.service.js";

const openTask1 = { id: "task-1", organization_id: "org-1", status: "pending" };
const openTask2 = { id: "task-2", organization_id: "org-1", status: "pending" };
const completedTask = (id: string) => ({ id, organization_id: "org-1", status: "completed", completed_at: "2026-09-03T00:00:00Z" });

describe("autoCompleteConversationTask", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("does nothing and returns an empty list when the conversation has no open task", async () => {
    getOpenTasksByConversation.mockResolvedValue([]);

    const result = await autoCompleteConversationTask({} as any, "org-1", "conv-1", "user-1");

    expect(result).toEqual([]);
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTaskEvent).not.toHaveBeenCalled();
  });

  it("completes the conversation's open task and logs an auto-complete event attributed to the human", async () => {
    getOpenTasksByConversation.mockResolvedValue([openTask1]);
    updateTask.mockResolvedValue(completedTask("task-1"));
    addTaskEvent.mockResolvedValue({});

    const result = await autoCompleteConversationTask({} as any, "org-1", "conv-1", "user-1");

    expect(getOpenTasksByConversation).toHaveBeenCalledWith({}, "org-1", "conv-1");
    expect(updateTask).toHaveBeenCalledWith({}, "task-1", expect.objectContaining({ status: "completed" }));
    expect(addTaskEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        task_id: "task-1",
        organization_id: "org-1",
        event_type: "completed",
        note: "Concluída automaticamente — humano assumiu a conversa",
        created_by_type: "human",
        created_by_id: "user-1",
      })
    );
    expect(result).toEqual([completedTask("task-1")]);
  });

  // Regression: a conversation with two simultaneously-open tasks (e.g. a
  // financing_followup created before a vehicle_followup) used to leave the
  // older one open forever, since only the most-recently-created open task
  // was ever looked up.
  it("completes every open task, not just the most recently created one", async () => {
    getOpenTasksByConversation.mockResolvedValue([openTask2, openTask1]);
    updateTask.mockImplementation((_db: unknown, id: string) => Promise.resolve(completedTask(id)));
    addTaskEvent.mockResolvedValue({});

    const result = await autoCompleteConversationTask({} as any, "org-1", "conv-1", "user-1");

    expect(updateTask).toHaveBeenCalledWith({}, "task-1", expect.objectContaining({ status: "completed" }));
    expect(updateTask).toHaveBeenCalledWith({}, "task-2", expect.objectContaining({ status: "completed" }));
    expect(result).toEqual(expect.arrayContaining([completedTask("task-1"), completedTask("task-2")]));
  });
});
