import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrgCache } from "./org-cache.js";

afterEach(() => vi.useRealTimers());

describe("createOrgCache", () => {
 it("reutiliza a leitura dentro do TTL e recarrega depois de expirar", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  const cache = createOrgCache<number>(20_000); const load = vi.fn(async () => load.mock.calls.length);
  expect(await cache.get("org", load)).toBe(1);
  vi.advanceTimersByTime(19_999);
  expect(await cache.get("org", load)).toBe(1);
  expect(load).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(2);
  expect(await cache.get("org", load)).toBe(2);
 });
 it("deduplica chamadas simultâneas na mesma organização", async () => {
  const cache = createOrgCache<string>(20_000); let release!: (v: string) => void;
  const load = vi.fn(() => new Promise<string>(r => { release = r; }));
  const all = Promise.all([cache.get("org", load), cache.get("org", load), cache.get("org", load)]);
  release("ok");
  expect(await all).toEqual(["ok", "ok", "ok"]);
  expect(load).toHaveBeenCalledTimes(1);
 });
 it("não mistura organizações", async () => {
  const cache = createOrgCache<string>(20_000);
  expect(await cache.get("a", async () => "dados-a")).toBe("dados-a");
  expect(await cache.get("b", async () => "dados-b")).toBe("dados-b");
  expect(await cache.get("a", async () => "novo")).toBe("dados-a");
 });
 it("não guarda erro: a próxima chamada tenta de novo", async () => {
  const cache = createOrgCache<string>(20_000);
  await expect(cache.get("org", async () => { throw new Error("falhou"); })).rejects.toThrow("falhou");
  expect(await cache.get("org", async () => "ok")).toBe("ok");
 });
 it("erro numa chamada simultânea chega a todas e nada fica guardado", async () => {
  const cache = createOrgCache<string>(20_000); let fail!: (e: Error) => void;
  const load = vi.fn(() => new Promise<string>((_, rej) => { fail = rej; }));
  const a = cache.get("org", load); const b = cache.get("org", load);
  const settled = Promise.allSettled([a, b]);
  fail(new Error("queda"));
  expect((await settled).map(r => r.status)).toEqual(["rejected", "rejected"]);
  expect(await cache.get("org", async () => "ok")).toBe("ok");
 });
 it("clear descarta tudo", async () => {
  const cache = createOrgCache<number>(20_000); let n = 0;
  await cache.get("org", async () => ++n); cache.clear();
  expect(await cache.get("org", async () => ++n)).toBe(2);
 });
});

it("invalidar durante a leitura não deixa o valor antigo em cache", async () => {
 const cache = createOrgCache<string>(20_000); let release!: (v: string) => void;
 const p = cache.get("org", () => new Promise<string>(r => { release = r; }));
 cache.invalidate("org"); release("velho");
 expect(await p).toBe("velho");
 expect(await cache.get("org", async () => "novo")).toBe("novo");
});
