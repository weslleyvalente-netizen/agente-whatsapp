import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachContactState, resetContactStateCacheForTests } from "./sales-workspace.service.js";

function fakeDb(conversations: any[], calls: any[]) {
  let hits = 0;
  const chain = (rows: any[]) => { const c: any = { select: () => c, eq: () => c, order: () => c, limit: () => c, range: (a: number) => { hits++; return Promise.resolve({ data: a === 0 ? rows : [], error: null }); } }; return c; };
  return { db: { from: (t: string) => chain(t === "conversations" ? conversations : calls) } as any, hits: () => hits };
}

describe("attachContactState", () => {
  beforeEach(() => { resetContactStateCacheForTests(); vi.useRealTimers(); });
  it("combina mensagem humana e ligação e respeita a data de atribuição", async () => {
    const { db } = fakeDb([{ contact_id: "c1", messages: [{ created_at: "2026-10-10T10:00:00Z" }] }, { contact_id: "c2", messages: [] }], [{ opportunity_id: "o2", called_at: "2026-10-12T12:00:00Z" }]);
    const out: any[] = await attachContactState(db, "org", [
      { id: "o1", contact_id: "c1", owner_assigned_at: "2026-10-11T00:00:00Z" },
      { id: "o2", contact_id: "c2", owner_assigned_at: "2026-10-11T00:00:00Z" },
      { id: "o3", contact_id: "c3", owner_assigned_at: null },
    ] as any);
    expect(out[0].contact_state.contactedSinceAssigned).toBe(false); // contato anterior à chegada
    expect(out[1].contact_state.contactedSinceAssigned).toBe(true);  // ligação depois
    expect(out[2].contact_state.lastContactAt).toBeNull();
  });
  it("usa cache de 60 s por organização", async () => {
    const f = fakeDb([], []);
    await attachContactState(f.db, "org", [{ id: "o1", contact_id: "c1" }] as any);
    const first = f.hits();
    await attachContactState(f.db, "org", [{ id: "o1", contact_id: "c1" }] as any);
    expect(f.hits()).toBe(first);
  });
});
