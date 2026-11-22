import { beforeEach, describe, expect, it, vi } from "vitest";

const t = vi.hoisted(() => ({ createTaskWithDedup: vi.fn(), updateTask: vi.fn(), getTaskById: vi.fn(), resolveAwaitingCustomerPendency: vi.fn() }));
vi.mock("./tasks.js", () => ({ ...t, OPEN_TASK_STATUSES: ["pending", "in_progress", "rescheduled"] }));
import { createCommitmentTask, taskHasOpenPendency } from "./commitments.js";

const input = {
  organizationId: "org", contactId: "ct", conversationId: "c", opportunityId: "op", ownerId: "marina", type: "return_customer" as const,
  description: "Retornar ao cliente", reason: "Promessa", priority: "high" as const, dueDate: "2026-11-23", dueTime: "15:00",
};

beforeEach(() => { vi.clearAllMocks(); t.updateTask.mockResolvedValue({}); });

describe("createCommitmentTask: novo prazo do vendedor não deixa a tarefa vencida pela hora antiga", () => {
  it("tarefa já aberta com a hora da promessa anterior (10:30): alinha data, hora e prioridade para o novo prazo (15:00)", async () => {
    t.createTaskWithDedup.mockResolvedValue({ task: { id: "t1", type: "return_customer", due_date: "2026-11-23", due_time: "10:30:00", consolidated_pendencies: [{ type: "return_customer", due_date: "2026-11-23", due_time: "10:30" }] }, wasUpdated: true });
    await createCommitmentTask({} as any, input);
    expect(t.updateTask).toHaveBeenCalledWith({}, "t1", expect.objectContaining({ due_date: "2026-11-23", due_time: "15:00", priority: "high",
      consolidated_pendencies: [expect.objectContaining({ type: "return_customer", due_time: "15:00" })] }));
  });
  it("tarefa nova (já com o prazo certo): não grava de novo", async () => {
    t.createTaskWithDedup.mockResolvedValue({ task: { id: "t2", type: "return_customer", due_date: "2026-11-23", due_time: "15:00:00", consolidated_pendencies: [] }, wasUpdated: false });
    await createCommitmentTask({} as any, input);
    expect(t.updateTask).not.toHaveBeenCalled();
  });
  it("tarefa consolidada com outras obrigações: não mexe na hora da tarefa (a pendência da promessa foi trocada pelo agrupamento)", async () => {
    t.createTaskWithDedup.mockResolvedValue({ task: { id: "t3", type: "run_quote", due_date: "2026-11-22", due_time: null, consolidated_pendencies: [{ type: "run_quote" }, { type: "return_customer", due_time: "15:00" }] }, wasUpdated: true });
    await createCommitmentTask({} as any, input);
    expect(t.updateTask).not.toHaveBeenCalled();
  });
});

describe("taskHasOpenPendency: erro temporário do banco não pode encerrar a promessa", () => {
  it("erro de conexão/consulta: lança (a rotina registra o erro e não mexe na promessa)", async () => {
    t.getTaskById.mockRejectedValue(Object.assign(new Error("connection reset"), { code: "08006" }));
    await expect(taskHasOpenPendency({} as any, "org", "t1", "return_customer")).rejects.toThrow("connection reset");
  });
  it("tarefa realmente inexistente (PGRST116): false", async () => {
    t.getTaskById.mockRejectedValue(Object.assign(new Error("0 rows"), { code: "PGRST116" }));
    expect(await taskHasOpenPendency({} as any, "org", "t1", "return_customer")).toBe(false);
  });
  it("tarefa concluída: false; aberta com a pendência: true; de outra organização: false", async () => {
    t.getTaskById.mockResolvedValue({ id: "t1", organization_id: "org", status: "completed", type: "return_customer", consolidated_pendencies: [] });
    expect(await taskHasOpenPendency({} as any, "org", "t1", "return_customer")).toBe(false);
    t.getTaskById.mockResolvedValue({ id: "t1", organization_id: "org", status: "pending", type: "run_quote", consolidated_pendencies: [{ type: "run_quote" }, { type: "return_customer" }] });
    expect(await taskHasOpenPendency({} as any, "org", "t1", "return_customer")).toBe(true);
    t.getTaskById.mockResolvedValue({ id: "t1", organization_id: "outra", status: "pending", type: "return_customer", consolidated_pendencies: [] });
    expect(await taskHasOpenPendency({} as any, "org", "t1", "return_customer")).toBe(false);
  });
});
