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

  it("na falha registra a exceção distribution_error (best-effort) com a mensagem do erro", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const distribute = vi.fn().mockRejectedValue(new Error("deadlock detected"));
    const recordError = vi.fn().mockResolvedValue("exc-1");
    expect(await safeDistribute(distribute, {} as any, input, recordError)).toBeNull();
    expect(recordError).toHaveBeenCalledWith({}, { ...input, message: "deadlock detected" });
    log.mockRestore();
  });
  it("falha ao registrar o erro também é engolida (o handoff nunca falha)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const distribute = vi.fn().mockRejectedValue({ message: "rpc down" });
    const recordError = vi.fn().mockRejectedValue(new Error("db totally down"));
    expect(await safeDistribute(distribute, {} as any, input, recordError)).toBeNull();
    expect(recordError).toHaveBeenCalledWith({}, { ...input, message: "rpc down" });
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
  it("sucesso não registra erro", async () => {
    const recordError = vi.fn();
    expect(await safeDistribute(vi.fn().mockResolvedValue("a"), {} as any, input, recordError)).toBe("a");
    expect(recordError).not.toHaveBeenCalled();
  });
});
