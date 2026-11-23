import { beforeEach, describe, expect, it, vi } from "vitest";

const t = vi.hoisted(() => ({ createTask: vi.fn(), addTaskEvent: vi.fn(), updateTask: vi.fn(), getTaskById: vi.fn(), resolveAwaitingCustomerPendency: vi.fn() }));
vi.mock("./tasks.js", () => ({ ...t, OPEN_TASK_STATUSES: ["pending", "in_progress", "rescheduled"] }));
import { taskHasOpenPendency } from "./commitments.js";


beforeEach(() => { vi.clearAllMocks(); t.updateTask.mockResolvedValue({}); });

// createCommitmentTask (tarefa independente, prazo próprio, reaproveitamento na mesma conversa): commitment-task-independent.test.ts

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
