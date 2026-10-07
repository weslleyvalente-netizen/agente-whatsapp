import { describe, expect, it, vi } from "vitest";
import { safeDistribute } from "./handoff-distribution.js";

const input = { organizationId: "o", conversationId: "c", handoffEventId: "h" };

describe("safeDistribute", () => {
  it("devolve o id da atribuição", async () => {
    const distribute = vi.fn().mockResolvedValue("assign-1");
    expect(await safeDistribute(distribute, {} as any, input)).toBe("assign-1");
    expect(distribute).toHaveBeenCalledWith({}, input);
  });
  it("nunca derruba o handoff: erro do banco vira null e é registrado", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const distribute = vi.fn().mockRejectedValue(new Error("db down"));
    expect(await safeDistribute(distribute, {} as any, input)).toBeNull();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
  it("com zero vendedores a função do banco devolve a exceção e nada quebra", async () => {
    const distribute = vi.fn().mockResolvedValue("exception-row");
    expect(await safeDistribute(distribute, {} as any, input)).toBe("exception-row");
  });
});
