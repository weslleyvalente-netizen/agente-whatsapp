// packages/database/src/sql/seller-isolation-baseline.test.ts
import { describe, expect, it } from "vitest";
import { createRlsDb, seedWorld, visible } from "./rls-harness.js";

describe("baseline: sem as migrations de isolamento (comportamento de hoje)", () => {
  it("todo membro vê tudo da própria organização e nada de outra", async () => {
    const db = await createRlsDb([]); // nenhuma migration de isolamento
    const w = await seedWorld(db, { isolation: true });
    for (const user of [w.users.manager, w.users.marina, w.users.marcio, w.users.legacy]) {
      const convs = await visible(db, user, "conversations");
      expect(convs).toContain(w.conv.marcio); expect(convs).toContain(w.conv.marina); expect(convs).not.toContain(w.conv.otherOrg);
      expect(await visible(db, user, "opportunities")).toContain(w.opp.marina);
      expect(await visible(db, user, "tasks")).toContain(w.task.onMarinaOpp);
    }
    expect(await visible(db, w.users.otherOrgUser, "conversations")).toEqual([w.conv.otherOrg]);
    expect(await visible(db, null, "conversations")).toEqual([]);
  });
});
