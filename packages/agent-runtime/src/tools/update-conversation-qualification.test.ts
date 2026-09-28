import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUpdateConversationQualificationTool } from "./update-conversation-qualification.js";

const upsertConversationQualification = vi.fn();
const getQualificationByConversationId = vi.fn();
const getOrganizationById = vi.fn();
const getLastContactMessage = vi.fn();
const findOpenTaskWithPendencyType = vi.fn();
const resolveAwaitingCustomerPendency = vi.fn();

vi.mock("@aula-agente/database", () => ({
  getAdminClient: () => ({}),
  upsertConversationQualification: (...args: unknown[]) => upsertConversationQualification(...args),
  getQualificationByConversationId: (...args: unknown[]) => getQualificationByConversationId(...args),
  getOrganizationById: (...args: unknown[]) => getOrganizationById(...args),
  getLastContactMessage: (...args: unknown[]) => getLastContactMessage(...args),
  findOpenTaskWithPendencyType: (...args: unknown[]) => findOpenTaskWithPendencyType(...args),
  resolveAwaitingCustomerPendency: (...args: unknown[]) => resolveAwaitingCustomerPendency(...args),
}));

const context = {
  contactId: "contact-1",
  conversationId: "conv-1",
  organizationId: "org-1",
};

const openTask = { id: "task-1", created_at: "2026-09-26T12:00:00Z" };

beforeEach(() => {
  vi.resetAllMocks();
  getOrganizationById.mockResolvedValue({ id: "org-1", settings: { task_auto_close_awaiting_customer_enabled: true } });
  getQualificationByConversationId.mockResolvedValue(null); // "before" snapshot
  upsertConversationQualification.mockResolvedValue({ id: "qual-1" });
  getLastContactMessage.mockResolvedValue({ created_at: "2026-09-28T12:00:00Z" }); // after the task
  findOpenTaskWithPendencyType.mockResolvedValue(openTask);
  resolveAwaitingCustomerPendency.mockResolvedValue({ taskCompleted: true });
});

describe("createUpdateConversationQualificationTool", () => {
  it("still updates the qualification and returns success even with the auto-close flag off", async () => {
    getOrganizationById.mockResolvedValue({ id: "org-1", settings: {} });
    const tool = createUpdateConversationQualificationTool(context);
    const result = await tool.execute!({ cpf: "12345678901" }, {} as never);

    expect(upsertConversationQualification).toHaveBeenCalled();
    expect(resolveAwaitingCustomerPendency).not.toHaveBeenCalled();
    expect(result).toBe("Dados de qualificação atualizados.");
  });

  it("auto-closes an open awaiting_customer_cpf task when the CPF is newly set and the customer replied since", async () => {
    getQualificationByConversationId
      .mockResolvedValueOnce(null) // before
      .mockResolvedValueOnce({ cpf_hash: "hash-1" }); // after, read back by the tool itself

    const tool = createUpdateConversationQualificationTool(context);
    await tool.execute!({ cpf: "12345678901" }, {} as never);

    expect(findOpenTaskWithPendencyType).toHaveBeenCalledWith({}, "org-1", "contact-1", "awaiting_customer_cpf");
    expect(resolveAwaitingCustomerPendency).toHaveBeenCalledWith(
      {},
      "org-1",
      "task-1",
      "awaiting_customer_cpf",
      expect.any(String)
    );
  });

  it("does not auto-close when the field didn't actually change (before and after are the same)", async () => {
    getQualificationByConversationId.mockResolvedValue({ cpf_hash: "hash-1" }); // same before and after

    const tool = createUpdateConversationQualificationTool(context);
    await tool.execute!({ cpf: "12345678901" }, {} as never);

    expect(resolveAwaitingCustomerPendency).not.toHaveBeenCalled();
  });

  it("does not auto-close when there is no customer message after the task was created", async () => {
    getQualificationByConversationId.mockResolvedValueOnce(null).mockResolvedValueOnce({ cpf_hash: "hash-1" });
    getLastContactMessage.mockResolvedValue({ created_at: "2026-09-20T00:00:00Z" }); // before the task

    const tool = createUpdateConversationQualificationTool(context);
    await tool.execute!({ cpf: "12345678901" }, {} as never);

    expect(resolveAwaitingCustomerPendency).not.toHaveBeenCalled();
  });

  it("does not auto-close when there is no customer message at all", async () => {
    getQualificationByConversationId.mockResolvedValueOnce(null).mockResolvedValueOnce({ cpf_hash: "hash-1" });
    getLastContactMessage.mockResolvedValue(null);

    const tool = createUpdateConversationQualificationTool(context);
    await tool.execute!({ cpf: "12345678901" }, {} as never);

    expect(resolveAwaitingCustomerPendency).not.toHaveBeenCalled();
  });

  it("does not auto-close awaiting_customer_decision — no structural signal for it", async () => {
    findOpenTaskWithPendencyType.mockImplementation(async (_db: unknown, _org: unknown, _contact: unknown, type: string) =>
      type === "awaiting_customer_decision" ? { id: "task-decision", created_at: "2026-09-26T00:00:00Z" } : null
    );
    getQualificationByConversationId.mockResolvedValueOnce(null).mockResolvedValueOnce({ cpf_hash: "hash-1" });

    const tool = createUpdateConversationQualificationTool(context);
    await tool.execute!({ cpf: "12345678901" }, {} as never);

    expect(resolveAwaitingCustomerPendency).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "task-decision",
      expect.anything(),
      expect.anything()
    );
  });

  it("never fails the tool call when the auto-close step throws", async () => {
    getQualificationByConversationId.mockResolvedValueOnce(null).mockResolvedValueOnce({ cpf_hash: "hash-1" });
    resolveAwaitingCustomerPendency.mockRejectedValue(new Error("db blip"));

    const tool = createUpdateConversationQualificationTool(context);
    const result = await tool.execute!({ cpf: "12345678901" }, {} as never);

    expect(result).toBe("Dados de qualificação atualizados.");
  });

  it("still returns the failure message when the qualification write itself throws", async () => {
    upsertConversationQualification.mockRejectedValue(new Error("db down"));

    const tool = createUpdateConversationQualificationTool(context);
    const result = await tool.execute!({ product_model: "Factor 150" }, {} as never);

    expect(result).toBe("Não foi possível atualizar os dados de qualificação agora.");
  });
});
