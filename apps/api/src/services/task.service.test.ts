import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateTask, addTaskEvent, getOpenTaskByConversation } = vi.hoisted(() => ({
  updateTask: vi.fn(),
  addTaskEvent: vi.fn(),
  getOpenTaskByConversation: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ updateTask, addTaskEvent, getOpenTaskByConversation }));

import { autoCompleteConversationTask } from "./task.service.js";

const openTask = { id: "task-1", organization_id: "org-1", status: "pending" };
const completedTask = { ...openTask, status: "completed", completed_at: "2026-09-03T00:00:00Z" };

describe("autoCompleteConversationTask", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("does nothing and returns null when the conversation has no open task", async () => {
    getOpenTaskByConversation.mockResolvedValue(null);

    const result = await autoCompleteConversationTask({} as any, "org-1", "conv-1", "user-1");

    expect(result).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTaskEvent).not.toHaveBeenCalled();
  });

  it("completes the conversation's open task and logs an auto-complete event attributed to the human", async () => {
    getOpenTaskByConversation.mockResolvedValue(openTask);
    updateTask.mockResolvedValue(completedTask);
    addTaskEvent.mockResolvedValue({});

    const result = await autoCompleteConversationTask({} as any, "org-1", "conv-1", "user-1");

    expect(getOpenTaskByConversation).toHaveBeenCalledWith({}, "org-1", "conv-1");
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
    expect(result).toEqual(completedTask);
  });
});
