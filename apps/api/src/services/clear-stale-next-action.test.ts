import { describe, expect, it } from "vitest";
import { clearStaleNextAction } from "./clear-stale-next-action.js";

function fakeDb(opps: any[], remainingTasks: any[]) {
  const updates: any[] = [];
  const db: any = {
    from: (t: string) => {
      const c: any = {
        select: () => c, eq: () => c, in: () => c, or: () => c, limit: () => Promise.resolve({ data: remainingTasks, error: null }),
        update: (v: any) => { updates.push(v); return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }; },
        then: (res: any) => res({ data: t === "opportunities" ? opps : [], error: null }),
      };
      return c;
    },
  };
  return { db, updates };
}
const task = { organization_id: "org", contact_id: "c1", opportunity_id: "o1" };
const now = new Date("2026-10-14T15:00:00Z");

describe("clearStaleNextAction", () => {
  it("limpa a data vencida quando não resta tarefa aberta", async () => {
    const { db, updates } = fakeDb([{ id: "o1", contact_id: "c1", next_action_due_date: "2026-10-01", frozen_until: null }], []);
    expect(await clearStaleNextAction(db, task, now)).toBe(true);
    expect(updates).toEqual([{ next_action_due_date: null }]);
  });
  it("limpa também quando a data é hoje", async () => {
    const { db } = fakeDb([{ id: "o1", contact_id: "c1", next_action_due_date: "2026-10-14", frozen_until: null }], []);
    expect(await clearStaleNextAction(db, task, now)).toBe(true);
  });
  it("não mexe se ainda há tarefa aberta", async () => {
    const { db, updates } = fakeDb([{ id: "o1", contact_id: "c1", next_action_due_date: "2026-10-01", frozen_until: null }], [{ id: "t2" }]);
    expect(await clearStaleNextAction(db, task, now)).toBe(false);
    expect(updates).toEqual([]);
  });
  it("não mexe em data futura nem em negócio congelado", async () => {
    expect(await clearStaleNextAction(fakeDb([{ id: "o1", contact_id: "c1", next_action_due_date: "2026-10-20", frozen_until: null }], []).db, task, now)).toBe(false);
    expect(await clearStaleNextAction(fakeDb([{ id: "o1", contact_id: "c1", next_action_due_date: "2026-10-01", frozen_until: "2026-10-30" }], []).db, task, now)).toBe(false);
  });
  it("não adivinha quando há mais de um negócio aberto para o contato", async () => {
    const { db } = fakeDb([{ id: "o1", contact_id: "c1", next_action_due_date: "2026-10-01" }, { id: "o2", contact_id: "c1", next_action_due_date: "2026-10-01" }], []);
    expect(await clearStaleNextAction(db, { ...task, opportunity_id: null }, now)).toBe(false);
  });
  it("erro no banco não quebra a operação principal", async () => {
    const db: any = { from: () => { throw new Error("boom"); } };
    expect(await clearStaleNextAction(db, task, now)).toBe(false);
  });
});
