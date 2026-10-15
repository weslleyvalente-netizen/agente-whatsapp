import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRlsDb } from "./rls-harness.js";

const MIGRATION = new URL("../../../../supabase/migrations/20261015120000_sync_owner_on_conversation_assign.sql", import.meta.url);

async function setup() {
  const db = await createRlsDb([]);
  // colunas que existem em produção e o esquema mínimo de teste não tem
  await db.exec(`
    ALTER TABLE public.opportunities ADD COLUMN owner_assigned_at timestamptz;
    ALTER TABLE public.tasks ADD COLUMN assignee_type text NOT NULL DEFAULT 'human';
    ALTER TABLE public.opportunity_events ADD COLUMN previous_value jsonb, ADD COLUMN new_value jsonb, ADD COLUMN evidence text, ADD COLUMN changed_by_type text;
  `);
  await db.exec(readFileSync(MIGRATION, "utf8"));
  const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
  const org = (await q("insert into public.organizations(settings) values ('{}') returning id"))[0].id;
  const other = (await q("insert into public.organizations(settings) values ('{}') returning id"))[0].id;
  const contact = (await q("insert into public.wa_contacts(organization_id) values ($1) returning id", [org]))[0].id;
  const contactB = (await q("insert into public.wa_contacts(organization_id) values ($1) returning id", [org]))[0].id;
  const marina = crypto.randomUUID(), marcio = crypto.randomUUID(), legacy = crypto.randomUUID();
  for (const u of [marina, marcio]) await q("insert into public.sales_reps(organization_id,user_id) values ($1,$2)", [org, u]);
  const conv = (await q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3) returning id", [org, contact, marcio]))[0].id;
  return { db, q, org, other, contact, contactB, marina, marcio, legacy, conv };
}

describe("sync_owner_on_conversation_assign", () => {
  it("passar a conversa a outro responsável leva junto o negócio aberto e as tarefas humanas abertas do cliente", async () => {
    const s = await setup();
    const opp = (await s.q("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3) returning id", [s.org, s.contact, s.legacy]))[0].id;
    const t1 = (await s.q("insert into public.tasks(organization_id,contact_id,assignee_id,status) values ($1,$2,$3,'pending') returning id", [s.org, s.contact, s.marcio]))[0].id;
    const t2 = (await s.q("insert into public.tasks(organization_id,contact_id,assignee_id,status) values ($1,$2,$3,'completed') returning id", [s.org, s.contact, s.marcio]))[0].id;
    await s.q("update public.conversations set assigned_to=$2 where id=$1", [s.conv, s.marina]);
    expect((await s.q("select owner_id, owner_assigned_at is not null as at from public.opportunities where id=$1", [opp]))[0]).toEqual({ owner_id: s.marina, at: true });
    expect((await s.q("select assignee_id from public.tasks where id=$1", [t1]))[0].assignee_id).toBe(s.marina);
    expect((await s.q("select assignee_id from public.tasks where id=$1", [t2]))[0].assignee_id).toBe(s.marcio); // concluída não muda
    const ev = await s.q("select event_type, previous_value, new_value from public.opportunity_events where opportunity_id=$1", [opp]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "owner_changed", previous_value: { owner_id: s.legacy }, new_value: { owner_id: s.marina } });
  });

  it("não mexe em negócio fechado, em negócio de outro cliente nem em tarefa da IA", async () => {
    const s = await setup();
    const won = (await s.q("insert into public.opportunities(organization_id,contact_id,owner_id,status) values ($1,$2,$3,'won') returning id", [s.org, s.contact, s.legacy]))[0].id;
    const otherClient = (await s.q("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3) returning id", [s.org, s.contactB, s.legacy]))[0].id;
    const ai = (await s.q("insert into public.tasks(organization_id,contact_id,assignee_id,assignee_type,status) values ($1,$2,null,'ai','pending') returning id", [s.org, s.contact]))[0].id;
    await s.q("update public.conversations set assigned_to=$2 where id=$1", [s.conv, s.marina]);
    expect((await s.q("select owner_id from public.opportunities where id=$1", [won]))[0].owner_id).toBe(s.legacy);
    expect((await s.q("select owner_id from public.opportunities where id=$1", [otherClient]))[0].owner_id).toBe(s.legacy);
    expect((await s.q("select assignee_type, assignee_id from public.tasks where id=$1", [ai]))[0]).toEqual({ assignee_type: "ai", assignee_id: null });
  });

  it("soltar a conversa (sem responsável) não altera o negócio, e repetir a mesma atribuição é inócuo", async () => {
    const s = await setup();
    const opp = (await s.q("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3) returning id", [s.org, s.contact, s.marcio]))[0].id;
    await s.q("update public.conversations set assigned_to=null where id=$1", [s.conv]);
    expect((await s.q("select owner_id from public.opportunities where id=$1", [opp]))[0].owner_id).toBe(s.marcio);
    await s.q("update public.conversations set assigned_to=$2 where id=$1", [s.conv, s.marcio]);
    await s.q("update public.conversations set assigned_to=$2, status='open' where id=$1", [s.conv, s.marcio]);
    expect(await s.q("select 1 from public.opportunity_events where opportunity_id=$1", [opp])).toHaveLength(0); // já era do Márcio
  });

  it("atribuir a conversa à conta compartilhada (não é vendedor) não tira o negócio de quem cuida dele", async () => {
    const s = await setup();
    const opp = (await s.q("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3) returning id", [s.org, s.contact, s.marcio]))[0].id;
    await s.q("update public.conversations set assigned_to=$2 where id=$1", [s.conv, s.legacy]);
    expect((await s.q("select owner_id from public.opportunities where id=$1", [opp]))[0].owner_id).toBe(s.marcio);
  });

  it("não atravessa organizações", async () => {
    const s = await setup();
    const c2 = (await s.q("insert into public.wa_contacts(organization_id) values ($1) returning id", [s.other]))[0].id;
    const opp2 = (await s.q("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3) returning id", [s.other, c2, s.legacy]))[0].id;
    await s.q("update public.conversations set assigned_to=$2 where id=$1", [s.conv, s.marina]);
    expect((await s.q("select owner_id from public.opportunities where id=$1", [opp2]))[0].owner_id).toBe(s.legacy);
  });
});
