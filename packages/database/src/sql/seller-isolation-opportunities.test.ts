// packages/database/src/sql/seller-isolation-opportunities.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { asUser, createRlsDb, seedWorld, visible, type World } from "./rls-harness.js";

let db: Awaited<ReturnType<typeof createRlsDb>>; let w: World;
beforeEach(async () => {
  db = await createRlsDb(); w = await seedWorld(db);
  for (const o of [w.opp.marina, w.opp.marcio, w.opp.none, w.opp.legacy]) await db.query("insert into public.opportunity_events(organization_id,opportunity_id) values ($1,$2)", [w.org, o]);
  for (const t of [w.task.onMarinaOpp, w.task.onMarcioConv, w.task.assigneeMarcio, w.task.free, w.task.conflict]) await db.query("insert into public.task_events(organization_id,task_id) values ($1,$2)", [w.org, t]);
});

describe("opportunities", () => {
  it("o Márcio não vê os negócios da Marina; vê o dele, o sem dono e o legado", async () => {
    expect(await visible(db, w.users.marcio, "opportunities")).toEqual([w.opp.marcio, w.opp.none, w.opp.legacy].sort());
  });
  it("a Marina não vê o do Márcio; o gestor vê todos", async () => {
    expect(await visible(db, w.users.marina, "opportunities")).toEqual([w.opp.marina, w.opp.none, w.opp.legacy].sort());
    expect(await visible(db, w.users.manager, "opportunities")).toEqual([w.opp.marina, w.opp.marcio, w.opp.none, w.opp.legacy].sort());
  });
  it("o vendedor não altera negócio que não vê, não o passa a outro vendedor, mas pega um sem dono", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.opportunities set status='lost' where id=$1", [w.opp.marina])).affectedRows).toBe(0);
      await expect(db.query("update public.opportunities set owner_id=$2 where id=$1", [w.opp.marcio, w.users.marina])).rejects.toThrow(/row-level security/i);
      expect((await db.query("update public.opportunities set owner_id=$2 where id=$1", [w.opp.none, w.users.marcio])).affectedRows).toBe(1);
    });
  });
  it("o gestor transfere negócio entre vendedores", async () => {
    await asUser(db, w.users.manager, async () => {
      expect((await db.query("update public.opportunities set owner_id=$2 where id=$1", [w.opp.marina, w.users.marcio])).affectedRows).toBe(1);
    });
  });
});

describe("opportunity_events", () => {
  it("seguem a visibilidade do negócio", async () => {
    const n = (u: string) => asUser(db, u, async () => (await db.query<any>("select count(*)::int as n from public.opportunity_events")).rows[0].n);
    expect(await n(w.users.marcio)).toBe(3); expect(await n(w.users.manager)).toBe(4);
  });
});

describe("tasks (o vínculo mais forte decide)", () => {
  it("o Márcio: tarefa do negócio da Marina fica invisível mesmo com responsável legado", async () => {
    const ids = await visible(db, w.users.marcio, "tasks");
    expect(ids).not.toContain(w.task.onMarinaOpp);
  });
  it("o Márcio vê a tarefa da própria conversa, a atribuída a ele e a livre", async () => {
    const ids = await visible(db, w.users.marcio, "tasks");
    expect(ids).toEqual([w.task.onMarcioConv, w.task.assigneeMarcio, w.task.free].sort());
  });
  it("vínculos conflitantes: negócio da Marina + conversa do Márcio → o negócio decide (Márcio não vê; Marina vê)", async () => {
    expect(await visible(db, w.users.marcio, "tasks")).not.toContain(w.task.conflict);
    expect(await visible(db, w.users.marina, "tasks")).toContain(w.task.conflict);
  });
  it("a Marina não vê a tarefa atribuída ao Márcio nem a da conversa dele; vê a do negócio dela e a livre", async () => {
    const ids = await visible(db, w.users.marina, "tasks");
    expect(ids).toEqual([w.task.onMarinaOpp, w.task.free, w.task.conflict].sort());
  });
  it("o gestor vê todas da organização", async () => {
    const ids = await visible(db, w.users.manager, "tasks");
    expect(ids).toEqual([w.task.onMarinaOpp, w.task.onMarcioConv, w.task.assigneeMarcio, w.task.free, w.task.conflict].sort());
  });
  it("o vendedor não altera tarefa que não vê", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.tasks set status='completed' where id=$1", [w.task.onMarinaOpp])).affectedRows).toBe(0);
    });
  });
  it("task_events seguem a tarefa", async () => {
    const n = (u: string) => asUser(db, u, async () => (await db.query<any>("select count(*)::int as n from public.task_events")).rows[0].n);
    expect(await n(w.users.marcio)).toBe(3); expect(await n(w.users.manager)).toBe(5);
  });
});

describe("wa_contacts (a armadilha do contato)", () => {
  it("contato só com conversa de outro vendedor NÃO vaza; sem conversa, sem dono e legado são visíveis", async () => {
    const ids = await visible(db, w.users.marcio, "wa_contacts");
    expect(ids).not.toContain(w.contacts.marina);          // só conversa da Marina
    expect(ids).toContain(w.contacts.marcio);
    expect(ids).toContain(w.contacts.none);
    expect(ids).toContain(w.contacts.legacy);
    expect(ids).toContain(w.contacts.orphan);              // sem nenhuma conversa
    expect(ids).toContain(w.contacts.both);                // tem uma conversa dele
  });
  it("contato com conversas de dois vendedores é visível a ambos", async () => {
    expect(await visible(db, w.users.marina, "wa_contacts")).toContain(w.contacts.both);
    expect(await visible(db, w.users.marcio, "wa_contacts")).toContain(w.contacts.both);
  });
  it("o gestor vê todos; ninguém vê contato de outra organização", async () => {
    const all = await visible(db, w.users.manager, "wa_contacts");
    expect(all).toContain(w.contacts.marina); expect(all).not.toContain(w.contacts.otherOrg);
    expect(await visible(db, w.users.marcio, "wa_contacts")).not.toContain(w.contacts.otherOrg);
  });
  it("o vendedor não altera contato que não vê", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.wa_contacts set name='x' where id=$1", [w.contacts.marina])).affectedRows).toBe(0);
    });
  });
});
