// packages/database/src/sql/sales-call-logs.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { asUser, createRlsDb, seedWorld, visible, type World } from "./rls-harness.js";

let db: Awaited<ReturnType<typeof createRlsDb>>; let w: World;
const ins = (org: string, opp: string, contact: string, user: string) =>
  db.query<any>("insert into public.sales_call_logs(organization_id,opportunity_id,contact_id,rep_user_id,strategy,outcome) values ($1,$2,$3,$4,'call_only','answered') returning id", [org, opp, contact, user]);
let logs: Record<"marina" | "marcio" | "none" | "otherOrg", string>;
beforeEach(async () => {
  db = await createRlsDb(); w = await seedWorld(db);
  logs = {
    marina: (await ins(w.org, w.opp.marina, w.contacts.marina, w.users.marina)).rows[0].id,
    marcio: (await ins(w.org, w.opp.marcio, w.contacts.marcio, w.users.marcio)).rows[0].id,
    none: (await ins(w.org, w.opp.none, w.contacts.none, w.users.manager)).rows[0].id,
    otherOrg: (await ins(w.otherOrg, w.opp.otherOrg, w.contacts.otherOrg, w.users.otherOrgUser)).rows[0].id,
  };
});

describe("sales_call_logs", () => {
  it("o Márcio não vê ligações de leads da Marina; vê as do dele e as de lead sem dono", async () => {
    expect(await visible(db, w.users.marcio, "sales_call_logs")).toEqual([logs.marcio, logs.none].sort());
  });
  it("a Marina não vê as do Márcio", async () => {
    expect(await visible(db, w.users.marina, "sales_call_logs")).toEqual([logs.marina, logs.none].sort());
  });
  it("o gestor vê todas da organização, nunca a de outra organização", async () => {
    expect(await visible(db, w.users.manager, "sales_call_logs")).toEqual([logs.marina, logs.marcio, logs.none].sort());
    expect(await visible(db, w.users.otherOrgUser, "sales_call_logs")).toEqual([logs.otherOrg]);
  });
  it("o vendedor não registra ligação em lead de outro vendedor, mas registra no próprio", async () => {
    await asUser(db, w.users.marcio, async () => {
      await expect(ins(w.org, w.opp.marina, w.contacts.marina, w.users.marcio)).rejects.toThrow(/row-level security/i);
      await expect(ins(w.org, w.opp.marcio, w.contacts.marcio, w.users.marcio)).resolves.toBeTruthy();
    });
  });
  it("ninguém registra em outra organização", async () => {
    await asUser(db, w.users.manager, async () => {
      await expect(ins(w.otherOrg, w.opp.otherOrg, w.contacts.otherOrg, w.users.manager)).rejects.toThrow(/row-level security/i);
    });
  });
  it("o vendedor não registra ligação em nome de outro (rep_user_id deve ser ele mesmo)", async () => {
    await asUser(db, w.users.marcio, async () => {
      await expect(ins(w.org, w.opp.marcio, w.contacts.marcio, w.users.marina)).rejects.toThrow(/row-level security/i);
    });
    await asUser(db, w.users.manager, async () => {
      await expect(ins(w.org, w.opp.none, w.contacts.none, w.users.marina)).rejects.toThrow(/row-level security/i);
    });
  });
  it("negócio de outra organização no registro é recusado, mesmo para quem é membro das duas", async () => {
    await db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,'owner')", [w.otherOrg, w.users.manager]);
    await asUser(db, w.users.manager, async () => {
      await expect(ins(w.org, w.opp.otherOrg, w.contacts.otherOrg, w.users.manager)).rejects.toThrow(/row-level security/i);
      await expect(ins(w.otherOrg, w.opp.marina, w.contacts.marina, w.users.manager)).rejects.toThrow(/row-level security/i);
      await expect(ins(w.otherOrg, w.opp.otherOrg, w.contacts.otherOrg, w.users.manager)).resolves.toBeTruthy();
    });
  });
  it("sem UPDATE nem DELETE para usuários (nem o gestor)", async () => {
    await asUser(db, w.users.manager, async () => {
      expect((await db.query("update public.sales_call_logs set note='x' where id=$1", [logs.marina])).affectedRows).toBe(0);
      expect((await db.query("delete from public.sales_call_logs where id=$1", [logs.marina])).affectedRows).toBe(0);
    });
  });
  it("valores inválidos são recusados pelos CHECKs", async () => {
    await expect(db.query("insert into public.sales_call_logs(organization_id,opportunity_id,rep_user_id,strategy,outcome) values ($1,$2,$3,'x','answered')", [w.org, w.opp.marina, w.users.marina])).rejects.toThrow();
    await expect(db.query("insert into public.sales_call_logs(organization_id,opportunity_id,rep_user_id,strategy,outcome) values ($1,$2,$3,'call_only','x')", [w.org, w.opp.marina, w.users.marina])).rejects.toThrow();
  });
  it("apagar o negócio apaga as ligações (CASCADE)", async () => {
    await db.query("delete from public.opportunities where id=$1", [w.opp.marina]);
    expect((await db.query<any>("select count(*)::int n from public.sales_call_logs where id=$1", [logs.marina])).rows[0].n).toBe(0);
  });
});
