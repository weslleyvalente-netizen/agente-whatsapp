import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithTimeout } from "./with-timeout.js";

describe("runWithTimeout", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("devolve o valor quando termina dentro do limite", async () => {
    const p = runWithTimeout(async () => { await new Promise((r) => setTimeout(r, 50)); return 7; }, 2000);
    await vi.advanceTimersByTimeAsync(60);
    expect(await p).toEqual({ status: "ok", value: 7 });
  });

  it("estourou o limite: devolve timeout no tempo certo e aborta o sinal", async () => {
    let signal!: AbortSignal;
    const p = runWithTimeout((s) => { signal = s; return new Promise<never>(() => {}); }, 2000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toEqual({ status: "timeout" });
    expect(signal.aborted).toBe(true);
  });

  it("falha dentro do limite vira status error, sem lançar", async () => {
    const boom = new Error("boom");
    expect(await runWithTimeout(async () => { throw boom; }, 2000)).toEqual({ status: "error", error: boom });
  });

  it("erro síncrono ao iniciar também vira status error", async () => {
    expect(await runWithTimeout(() => { throw new Error("sync"); }, 2000)).toMatchObject({ status: "error" });
  });

  it("rejeição tardia depois do timeout não gera 'unhandled rejection'", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let reject!: (e: Error) => void;
      const p = runWithTimeout(() => new Promise<never>((_, rej) => { reject = rej; }), 100);
      await vi.advanceTimersByTimeAsync(150);
      expect(await p).toEqual({ status: "timeout" });
      reject(new Error("tardio"));
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("não deixa timer pendente quando termina antes do limite", async () => {
    await runWithTimeout(async () => 1, 2000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
