import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRlsDb } from "./rls-harness.js";

const MIGRATION = new URL("../../../../supabase/migrations/20261020120000_owner_on_opportunity_create.sql", import.meta.url);

async function setup() {
  const db = await createRlsDb([]);
  // colunas que existem em produção e o esquema mínimo de teste não tem
  await db.exec(`ALTER TABLE public.opportunities ADD COLUMN owner_assigned_at timestamptz; ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS last_message_at timestamptz; ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();`);
  await db.exec(readFileSync(MIGRATION, "utf8"));
  const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
  const org = (await q("insert into public.organizations(settings) values ('{}') returning id"))[0].id;
  const other = (await q("insert into public.organizations(settings) values ('{}') returning id"))[0].id;
  const contact = (await q("insert into public.wa_contacts(organization_id) values ($1) returning id", [org]))[0].id;
  const marina = crypto.randomUUID(), shared = crypto.randomUUID();
  await q("insert into public.sales_reps(organization_id,user_id) values ($1,$2)", [org, marina]);
  return { q, org, other, contact, marina, shared };
}

describe("owner_on_opportunity_open", () => {
  it("negócio novo sem dono herda o vendedor da conversa", async () => {
    const s = await setup();
    await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [s.org, s.contact, s.marina]);
    const o = (await s.q("insert into public.opportunities(organization_id,contact_id) values ($1,$2) returning owner_id, owner_assigned_at is not null as at", [s.org, s.contact]))[0];
    expect(o).toEqual({ owner_id: s.marina, at: true });
  });

  it("conversa na conta compartilhada (não é vendedor) mantém o negócio sem dono", async () => {
    const s = await setup();
    await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [s.org, s.contact, s.shared]);
    expect((await s.q("insert into public.opportunities(organization_id,contact_id) values ($1,$2) returning owner_id", [s.org, s.contact]))[0].owner_id).toBeNull();
  });

  it("não sobrescreve dono já informado e não mexe em negócio que nasce fechado", async () => {
    const s = await setup();
    const other = crypto.randomUUID();
    await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [s.org, s.contact, s.marina]);
    expect((await s.q("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3) returning owner_id", [s.org, s.contact, other]))[0].owner_id).toBe(other);
    expect((await s.q("insert into public.opportunities(organization_id,contact_id,status) values ($1,$2,'won') returning owner_id", [s.org, s.contact]))[0].owner_id).toBeNull();
  });

  it("reabrir um negócio sem dono também herda o vendedor da conversa", async () => {
    const s = await setup();
    await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [s.org, s.contact, s.marina]);
    const id = (await s.q("insert into public.opportunities(organization_id,contact_id,status) values ($1,$2,'lost') returning id", [s.org, s.contact]))[0].id;
    await s.q("update public.opportunities set status='open' where id=$1", [id]);
    expect((await s.q("select owner_id from public.opportunities where id=$1", [id]))[0].owner_id).toBe(s.marina);
  });

  it("não atravessa organizações: conversa de outra organização não dá dono", async () => {
    const s = await setup();
    const c2 = (await s.q("insert into public.wa_contacts(organization_id) values ($1) returning id", [s.other]))[0].id;
    await s.q("insert into public.sales_reps(organization_id,user_id) values ($1,$2)", [s.other, s.marina]);
    await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [s.other, c2, s.marina]);
    expect((await s.q("insert into public.opportunities(organization_id,contact_id) values ($1,$2) returning owner_id", [s.org, s.contact]))[0].owner_id).toBeNull();
  });
});
