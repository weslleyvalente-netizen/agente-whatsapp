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
});
