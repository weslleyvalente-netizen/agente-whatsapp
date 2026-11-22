// adopt_lid_contact no PostgreSQL REAL (pglite), com o corpo da função lido da migração de produção.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ORG = "00000000-0000-4000-8000-000000000001";
let pg: PGlite;

function functionDdl(): string {
  const sql = readFileSync(new URL("../../../../supabase/migrations/20261122120000_commitments_followup.sql", import.meta.url), "utf8");
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.adopt_lid_contact");
  const end = sql.indexOf("END $$;", start) + "END $$;".length;
  return sql.slice(start, end);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.wa_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, phone text NOT NULL, name text,
      metadata jsonb, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id, phone));
    CREATE TABLE public.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id) ON DELETE CASCADE, assigned_to text);
    CREATE TABLE public.opportunities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id));
    CREATE TABLE public.one_per_contact (id serial PRIMARY KEY, contact_id uuid NOT NULL UNIQUE REFERENCES public.wa_contacts(id));
  `);
  await pg.exec(functionDdl());
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => { await pg.exec("TRUNCATE public.one_per_contact, public.opportunities, public.conversations, public.wa_contacts CASCADE"); });

const adopt = async (lid: string, real: string, variants = [real]) =>
  (await pg.query<{ r: string }>("select public.adopt_lid_contact($1,$2,$3,$4) as r", [ORG, lid, real, variants])).rows[0].r;
const contact = async (phone: string) => (await pg.query<{ id: string }>("insert into public.wa_contacts(organization_id,phone,name) values ($1,$2,'Cliente') returning id", [ORG, phone])).rows[0].id;

describe("migração 20261122120000 inteira", () => {
  it("aplica duas vezes (idempotente) e aceita o novo trigger_type", async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE public.organizations (id uuid PRIMARY KEY);
      CREATE TABLE public.wa_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, phone text, metadata jsonb, updated_at timestamptz DEFAULT now());
      CREATE TABLE public.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.opportunities (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.handoff_events (id serial PRIMARY KEY, conversation_id uuid, trigger_type text NOT NULL CHECK (trigger_type IN ('request_human','painel_manual','fromMe_real','fromMe_greeting_filtered')));
      CREATE FUNCTION public.get_user_org_ids() RETURNS SETOF uuid LANGUAGE sql AS $$ SELECT NULL::uuid WHERE false $$;
    `);
    const sql = readFileSync(new URL("../../../../supabase/migrations/20261122120000_commitments_followup.sql", import.meta.url), "utf8");
    await db.exec(`BEGIN; ${sql} COMMIT;`);
    await db.exec(`BEGIN; ${sql} COMMIT;`);
    await db.query("insert into public.handoff_events(trigger_type) values ('sistema_sem_resposta')");
    await expect(db.query("insert into public.handoff_events(trigger_type) values ('qualquer')")).rejects.toThrow();
    await db.close();
  });
});

describe("adopt_lid_contact", () => {
  it("sem contato real: o @lid assume o número e mantém conversa e vendedor", async () => {
    const lid = await contact("88683172618347@lid");
    await pg.query("insert into public.conversations(contact_id,assigned_to) values ($1,'marina')", [lid]);
    expect(await adopt("88683172618347@lid", "5562999991234")).toBe("renamed");
    const row = (await pg.query<{ phone: string; metadata: any }>("select phone, metadata from public.wa_contacts where id=$1", [lid])).rows[0];
    expect(row.phone).toBe("5562999991234");
    expect(row.metadata.lid).toBe("88683172618347@lid");
    expect((await pg.query<{ assigned_to: string }>("select assigned_to from public.conversations where contact_id=$1", [lid])).rows[0].assigned_to).toBe("marina");
  });

  it("com contato real: move conversas e negócios do @lid para o real e marca o @lid como juntado", async () => {
    const lid = await contact("111@lid");
    const real = await contact("5562988887777");
    await pg.query("insert into public.conversations(contact_id) values ($1)", [lid]);
    await pg.query("insert into public.opportunities(contact_id) values ($1)", [lid]);
    expect(await adopt("111@lid", "5562988887777")).toBe("merged");
    expect((await pg.query("select 1 from public.conversations where contact_id=$1", [real])).rows).toHaveLength(1);
    expect((await pg.query("select 1 from public.opportunities where contact_id=$1", [real])).rows).toHaveLength(1);
    const old = (await pg.query<{ phone: string; metadata: any }>("select phone, metadata from public.wa_contacts where id=$1", [lid])).rows[0];
    expect(old.phone).toBe("111@lid#merged");
    expect(old.metadata.merged_into).toBe(real);
  });

  it("conflito (unicidade por contato): desfaz tudo e devolve conflict", async () => {
    const lid = await contact("222@lid");
    const real = await contact("5562977776666");
    await pg.query("insert into public.conversations(contact_id) values ($1)", [lid]);
    await pg.query("insert into public.one_per_contact(contact_id) values ($1), ($2)", [lid, real]);
    expect(await adopt("222@lid", "5562977776666")).toBe("conflict");
    // Nada mudou: a conversa continua no @lid e o @lid continua com o identificador.
    expect((await pg.query("select 1 from public.conversations where contact_id=$1", [lid])).rows).toHaveLength(1);
    expect((await pg.query<{ phone: string }>("select phone from public.wa_contacts where id=$1", [lid])).rows[0].phone).toBe("222@lid");
  });

  it("encontra o contato real por variante do 9º dígito", async () => {
    await contact("333@lid");
    const real = await contact("556288887777");
    expect(await adopt("333@lid", "5562988887777", ["5562988887777", "556288887777"])).toBe("merged");
    expect((await pg.query<{ metadata: any }>("select metadata from public.wa_contacts where id=$1", [real])).rows[0].metadata.lid).toBe("333@lid");
  });

  it("entradas inválidas e @lid inexistente não mexem em nada", async () => {
    expect(await adopt("5562@s.whatsapp.net", "5562999991234")).toBe("invalid");
    expect(await adopt("444@lid", "abc")).toBe("invalid");
    expect(await adopt("555@lid", "5562999991234")).toBe("none");
  });
});
