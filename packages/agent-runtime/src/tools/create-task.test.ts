import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCreateTaskTool } from "./create-task.js";

const createTaskWithDedup = vi.fn();
const getOpenOpportunitiesByContact = vi.fn();

vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  createTaskWithDedup: (...args: unknown[]) => createTaskWithDedup(...args),
  getOpenOpportunitiesByContact: (...args: unknown[]) => getOpenOpportunitiesByContact(...args),
}));

const context = { contactId: "contact-1", conversationId: "conv-1", organizationId: "org-1" };

const baseInput = {
  type: "proposal_followup" as const,
  description: "Cliente pediu pra retornar amanhã",
  due_date: "2026-09-24",
  priority: "normal" as const,
  reason: "Cliente disse que ia decidir com a esposa",
};

beforeEach(() => {
  createTaskWithDedup.mockReset();
  getOpenOpportunitiesByContact.mockReset();
  createTaskWithDedup.mockResolvedValue({ task: { title: "Follow-up de proposta" }, wasUpdated: false });
});

describe("createCreateTaskTool", () => {
  // Real gap found in September's audit: createTaskWithDedup already dedupes
  // by (opportunity_id, type) when given one, but this tool never looked the
  // opportunity up — every task fell back to (contact_id, type) dedup, so a
  // contact with two open opportunities running in parallel got tasks
  // cross-linked between them.
  it("passes the contact's single open opportunity_id so dedup is scoped to that deal", async () => {
    getOpenOpportunitiesByContact.mockResolvedValue([{ id: "opp-1", waiting_on: null, waiting_on_until: null }]);

    const toolDef = createCreateTaskTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(getOpenOpportunitiesByContact).toHaveBeenCalledWith({}, "org-1", "contact-1");
    expect(createTaskWithDedup).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ opportunity_id: "opp-1" })
    );
  });

  it("does not set opportunity_id when the contact has no open opportunity (unchanged behavior)", async () => {
    getOpenOpportunitiesByContact.mockResolvedValue([]);

    const toolDef = createCreateTaskTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(createTaskWithDedup).toHaveBeenCalledWith({}, expect.objectContaining({ opportunity_id: null }));
  });

  // The instruction from the plan: "quando houver mais de uma e não for
  // possível identificar a correta, não escolher arbitrariamente" — with
  // two or more open opportunities for the same contact, which one this
  // task belongs to is ambiguous, so it must NOT guess (falls back to the
  // contact-level dedup that already existed before this change).
  it("does not guess when the contact has two or more open opportunities", async () => {
    getOpenOpportunitiesByContact.mockResolvedValue([
      { id: "opp-1", waiting_on: null, waiting_on_until: null },
      { id: "opp-2", waiting_on: null, waiting_on_until: null },
    ]);

    const toolDef = createCreateTaskTool(context);
    await toolDef.execute!(baseInput, {} as never);

    expect(createTaskWithDedup).toHaveBeenCalledWith({}, expect.objectContaining({ opportunity_id: null }));
  });

  it("still creates the task even if the opportunity lookup itself fails", async () => {
    getOpenOpportunitiesByContact.mockRejectedValue(new Error("db blip"));

    const toolDef = createCreateTaskTool(context);
    const result = await toolDef.execute!(baseInput, {} as never);

    expect(result).toContain("Tarefa criada");
    expect(createTaskWithDedup).toHaveBeenCalledWith({}, expect.objectContaining({ opportunity_id: null }));
  });
});
