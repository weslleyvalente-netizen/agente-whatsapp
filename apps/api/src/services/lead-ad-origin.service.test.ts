import { describe, expect, it } from "vitest";
import { getAdOriginForContact } from "./lead-ad-origin.service.js";

function db(rows: Array<{ id: string; touched_at: string }>, error: unknown = null) {
  const chain: Record<string, any> = {};
  for (const op of ["select", "eq", "order"]) chain[op] = () => chain;
  chain.limit = async () => ({ data: rows, error });
  return { from: () => chain } as never;
}
const rows = [{ id: "c", touched_at: "2026-11-12T10:00:00Z" }, { id: "b", touched_at: "2026-11-10T10:00:00Z" }, { id: "a", touched_at: "2026-11-01T10:00:00Z" }];

describe("getAdOriginForContact", () => {
  it("sem oportunidade: só o histórico", async () => {
    expect(await getAdOriginForContact(db(rows), "o", "c")).toMatchObject({ attributed_touch_id: null, touches: rows });
  });
  it("com oportunidade: marca o toque mais recente até a criação, preservando os demais no histórico", async () => {
    const r = await getAdOriginForContact(db(rows), "o", "c", "2026-11-11T00:00:00Z");
    expect(r.attributed_touch_id).toBe("b");
    expect(r.touches).toHaveLength(3);
  });
  it("oportunidade criada antes de qualquer toque: sem atribuição", async () => {
    expect((await getAdOriginForContact(db(rows), "o", "c", "2026-10-01T00:00:00Z")).attributed_touch_id).toBeNull();
  });
  it("erro do banco sobe", async () => {
    await expect(getAdOriginForContact(db([], { message: "x" }), "o", "c")).rejects.toBeTruthy();
  });
});
