// packages/database/src/sql/seller-isolation-functions.test.ts
import { describe, expect, it } from "vitest";
import { asUser, createRlsDb, seedWorld } from "./rls-harness.js";

const call = async (db: any, user: string | null, sql: string, params: unknown[] = []) => asUser(db, user, async () => (await db.query(sql, params)).rows[0].r);

describe("seller_isolation_applies", () => {
  it("só se aplica a vendedor, com o interruptor ligado e vendedores cadastrados", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    expect(await call(db, w.users.marcio, "select public.seller_isolation_applies($1) as r", [w.org])).toBe(true);
    expect(await call(db, w.users.support, "select public.seller_isolation_applies($1) as r", [w.org])).toBe(true); // agent fora de sales_reps também é restringido
    expect(await call(db, w.users.manager, "select public.seller_isolation_applies($1) as r", [w.org])).toBe(false); // gestor
  });
  it("não se aplica com o interruptor desligado nem sem vendedores", async () => {
    const off = await createRlsDb(); const wOff = await seedWorld(off, { isolation: false });
    expect(await call(off, wOff.users.marcio, "select public.seller_isolation_applies($1) as r", [wOff.org])).toBe(false);
    const none = await createRlsDb(); const wNone = await seedWorld(none, { withReps: false });
    expect(await call(none, wNone.users.marcio, "select public.seller_isolation_applies($1) as r", [wNone.org])).toBe(false);
  });
  it("organização inexistente ou ausente nunca restringe", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    expect(await call(db, w.users.marcio, "select public.seller_isolation_applies($1) as r", [crypto.randomUUID()])).toBe(false);
  });
});

describe("seller_can_see", () => {
  it("vendedor vê o próprio, o sem dono e o de dono legado; não vê o de outro vendedor", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    const can = (user: string, owner: string | null) => call(db, user, "select public.seller_can_see($1,$2) as r", [w.org, owner]);
    expect(await can(w.users.marcio, w.users.marcio)).toBe(true);
    expect(await can(w.users.marcio, null)).toBe(true);
    expect(await can(w.users.marcio, w.users.legacy)).toBe(true);
    expect(await can(w.users.marcio, w.users.marina)).toBe(false);
    expect(await can(w.users.marina, w.users.marcio)).toBe(false);
  });
  it("agent que não é vendedor (suporte) vê sem dono e legado, não o de vendedores", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    const can = (owner: string | null) => call(db, w.users.support, "select public.seller_can_see($1,$2) as r", [w.org, owner]);
    expect(await can(null)).toBe(true); expect(await can(w.users.legacy)).toBe(true);
    expect(await can(w.users.marina)).toBe(false); expect(await can(w.users.marcio)).toBe(false);
  });
  it("gestor vê tudo; com o interruptor desligado todos veem tudo", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    expect(await call(db, w.users.manager, "select public.seller_can_see($1,$2) as r", [w.org, w.users.marina])).toBe(true);
    const off = await createRlsDb(); const wo = await seedWorld(off, { isolation: false });
    expect(await call(off, wo.users.marcio, "select public.seller_can_see($1,$2) as r", [wo.org, wo.users.marina])).toBe(true);
  });
});

describe("contact_has_any_conversation", () => {
  it("enxerga conversas que o vendedor não vê (ignora RLS), e é falso para contato sem conversa", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    expect(await call(db, w.users.marcio, "select public.contact_has_any_conversation($1) as r", [w.contacts.marina])).toBe(true);
    expect(await call(db, w.users.marcio, "select public.contact_has_any_conversation($1) as r", [w.contacts.orphan])).toBe(false);
  });
});

describe("índices", () => {
  it("cria os índices usados pelas políticas", async () => {
    const db = await createRlsDb();
    const names = (await db.query<any>("select indexname from pg_indexes where schemaname='public'")).rows.map(r => r.indexname);
    for (const n of ["idx_conversations_assigned_to", "idx_conversations_contact", "idx_opportunities_owner", "idx_tasks_assignee"]) expect(names).toContain(n);
  });
});
