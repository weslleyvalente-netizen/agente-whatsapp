import { describe, expect, it, vi } from "vitest";
import { createProfilePictureResolver } from "./profile-pictures";

function setup(fetchImpl?: (ids: string[]) => Promise<Record<string, string>>) {
  let t = 0;
  const fetchBatch = vi.fn(fetchImpl ?? (async (ids: string[]) => Object.fromEntries(ids.map((i) => [i, `url-${i}`]))));
  const r = createProfilePictureResolver(fetchBatch, { now: () => t, ttlMs: 1000, batchDelayMs: 5 });
  return { r, fetchBatch, advance: (ms: number) => { t += ms; } };
}

describe("createProfilePictureResolver", () => {
  it("junta pedidos do mesmo tick em uma chamada", async () => {
    const { r, fetchBatch } = setup();
    const res = await Promise.all([r.request("a"), r.request("b"), r.request("c")]);
    expect(res).toEqual(["url-a", "url-b", "url-c"]);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    expect(fetchBatch.mock.calls[0][0].sort()).toEqual(["a", "b", "c"]);
  });

  it("não repete id em voo", async () => {
    const { r, fetchBatch } = setup();
    await Promise.all([r.request("a"), r.request("a")]);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    expect(fetchBatch.mock.calls[0][0]).toEqual(["a"]);
  });

  it("usa cache dentro do TTL e busca de novo depois", async () => {
    const { r, fetchBatch, advance } = setup();
    await r.request("a");
    advance(999);
    expect(await r.request("a")).toBe("url-a");
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    advance(2);
    await r.request("a");
    expect(fetchBatch).toHaveBeenCalledTimes(2);
  });

  it("id ausente na resposta vira null e fica em cache", async () => {
    const { r, fetchBatch } = setup(async () => ({}));
    expect(await r.request("a")).toBeNull();
    expect(await r.request("a")).toBeNull();
    expect(fetchBatch).toHaveBeenCalledTimes(1);
  });

  it("fetchBatch lançando: todos null e sem cache", async () => {
    let fail = true;
    const { r, fetchBatch } = setup(async (ids) => {
      if (fail) throw new Error("boom");
      return Object.fromEntries(ids.map((i) => [i, `url-${i}`]));
    });
    expect(await Promise.all([r.request("a"), r.request("b")])).toEqual([null, null]);
    fail = false;
    expect(await r.request("a")).toBe("url-a");
    expect(fetchBatch).toHaveBeenCalledTimes(2);
  });

  it("compartilha a promessa de id em voo (depois do flush, antes de resolver)", async () => {
    let release!: (v: Record<string, string>) => void;
    const { r, fetchBatch } = setup(() => new Promise((res) => { release = res; }));
    const first = r.request("a");
    await new Promise((res) => setTimeout(res, 20));
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    const second = r.request("a");
    release({ a: "url-a" });
    expect(await Promise.all([first, second])).toEqual(["url-a", "url-a"]);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
  });

  it("divide mais de 100 ids em lotes de até 100", async () => {
    const { r, fetchBatch } = setup();
    const ids = Array.from({ length: 101 }, (_, i) => `c${i}`);
    const res = await Promise.all(ids.map((i) => r.request(i)));
    expect(res[100]).toBe("url-c100");
    expect(fetchBatch).toHaveBeenCalledTimes(2);
    expect(fetchBatch.mock.calls.map((c) => c[0].length).sort((a, b) => a - b)).toEqual([1, 100]);
  });

  it("lote que falha não afeta o outro", async () => {
    const { r } = setup(async (ids) => {
      if (ids.length === 1) throw new Error("boom");
      return Object.fromEntries(ids.map((i) => [i, `url-${i}`]));
    });
    const ids = Array.from({ length: 101 }, (_, i) => `c${i}`);
    const res = await Promise.all(ids.map((i) => r.request(i)));
    expect(res.filter((x) => x === null)).toHaveLength(1);
    expect(res.filter((x) => x !== null)).toHaveLength(100);
  });
});
