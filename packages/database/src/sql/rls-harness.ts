// packages/database/src/sql/rls-harness.ts
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { RLS_FIXTURE_SQL } from "./rls-fixture.js";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);
export const RLS_MIGRATIONS = [
  "20261008120000_seller_isolation_functions.sql",
  "20261008120100_seller_isolation_conversations.sql",
  "20261008120200_seller_isolation_opportunities.sql",
];

export async function createRlsDb(files: string[] = RLS_MIGRATIONS) {
  const db = new PGlite();
  await db.exec(RLS_FIXTURE_SQL);
  for (const file of files) {
    let sql: string;
    try { sql = readFileSync(new URL(file, MIGRATIONS), "utf8"); }
    catch (err: any) { if (err?.code === "ENOENT") continue; throw err; } // as próximas tasks criam os arquivos
    await db.exec(sql);
  }
  await db.exec("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, anon, service_role;");
  return db;
}
type Db = Awaited<ReturnType<typeof createRlsDb>>;

/** Executa fn como o papel `authenticated` com auth.uid() = userId (null = sem login). */
export async function asUser<T>(db: Db, userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec("SET ROLE authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  try { return await fn(); }
  finally { await db.exec("RESET ROLE"); await db.query("select set_config('request.jwt.claim.sub', '', false)"); }
}

export async function visible(db: Db, userId: string | null, table: string, column = "id"): Promise<string[]> {
  return asUser(db, userId, async () => (await db.query<any>(`select ${column} as id from public.${table} order by ${column}`)).rows.map(r => r.id as string));
}

const id = () => crypto.randomUUID();
const q = async (db: Db, sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0].id as string;

export interface World {
  org: string; otherOrg: string;
  users: { manager: string; marina: string; marcio: string; legacy: string; support: string; otherOrgUser: string };
  contacts: { marina: string; marcio: string; none: string; legacy: string; orphan: string; both: string; otherOrg: string };
  conv: { marina: string; marcio: string; none: string; legacy: string; both1: string; both2: string; otherOrg: string };
  opp: { marina: string; marcio: string; none: string; legacy: string; otherOrg: string };
  task: { onMarinaOpp: string; onMarcioConv: string; assigneeMarcio: string; free: string; conflict: string; otherOrg: string };
  msg: { marina: string; marcio: string; none: string; legacy: string };
}

/**
 * Mundo de teste: 1 organização com gestor (owner), Marina e Márcio (vendedores, em sales_reps),
 * "legacy" (conta compartilhada: membro que NÃO é vendedor) e "support" (agent que NÃO é vendedor);
 * mais uma 2ª organização isolada. opts.isolation liga o interruptor; opts.withReps=false não cadastra vendedores.
 */
export async function seedWorld(db: Db, opts: { isolation?: boolean; withReps?: boolean } = {}): Promise<World> {
  const isolation = opts.isolation ?? true; const withReps = opts.withReps ?? true;
  const org = await q(db, "insert into public.organizations(settings) values ($1) returning id", [JSON.stringify(isolation ? { seller_isolation_enabled: true } : {})]);
  const otherOrg = await q(db, "insert into public.organizations(settings) values ($1) returning id", [JSON.stringify({ seller_isolation_enabled: true })]);
  const users = { manager: id(), marina: id(), marcio: id(), legacy: id(), support: id(), otherOrgUser: id() };
  const member = (o: string, u: string, role: string) => db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,$3)", [o, u, role]);
  await member(org, users.manager, "owner"); await member(org, users.marina, "agent"); await member(org, users.marcio, "agent");
  await member(org, users.legacy, "agent"); await member(org, users.support, "agent"); await member(otherOrg, users.otherOrgUser, "agent");
  if (withReps) for (const [i, u] of [users.marina, users.marcio].entries()) await db.query("insert into public.sales_reps(organization_id,user_id,rotation_order) values ($1,$2,$3)", [org, u, i + 1]);
  await db.query("insert into public.sales_reps(organization_id,user_id) values ($1,$2)", [otherOrg, users.otherOrgUser]);

  const contact = (o: string) => q(db, "insert into public.wa_contacts(organization_id) values ($1) returning id", [o]);
  const contacts = { marina: await contact(org), marcio: await contact(org), none: await contact(org), legacy: await contact(org), orphan: await contact(org), both: await contact(org), otherOrg: await contact(otherOrg) };
  const conversation = (o: string, c: string, assigned: string | null) => q(db, "insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3) returning id", [o, c, assigned]);
  const conv = {
    marina: await conversation(org, contacts.marina, users.marina), marcio: await conversation(org, contacts.marcio, users.marcio),
    none: await conversation(org, contacts.none, null), legacy: await conversation(org, contacts.legacy, users.legacy),
    // "both": contato com duas conversas de vendedores diferentes (só visível a quem vê alguma delas).
    both1: await conversation(org, contacts.both, users.marina), both2: await conversation(org, contacts.both, users.marcio),
    otherOrg: await conversation(otherOrg, contacts.otherOrg, users.otherOrgUser),
  };
  const message = (o: string, c: string) => q(db, "insert into public.messages(organization_id,conversation_id,content) values ($1,$2,'oi') returning id", [o, c]);
  const msg = { marina: await message(org, conv.marina), marcio: await message(org, conv.marcio), none: await message(org, conv.none), legacy: await message(org, conv.legacy) };
  const opportunity = (o: string, c: string, owner: string | null) => q(db, "insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3) returning id", [o, c, owner]);
  const opp = { marina: await opportunity(org, contacts.marina, users.marina), marcio: await opportunity(org, contacts.marcio, users.marcio), none: await opportunity(org, contacts.none, null), legacy: await opportunity(org, contacts.legacy, users.legacy), otherOrg: await opportunity(otherOrg, contacts.otherOrg, users.otherOrgUser) };
  const t = (o: string, c: string, conversationId: string | null, opportunityId: string | null, assignee: string | null) =>
    q(db, "insert into public.tasks(organization_id,contact_id,conversation_id,opportunity_id,assignee_id) values ($1,$2,$3,$4,$5) returning id", [o, c, conversationId, opportunityId, assignee]);
  const task = {
    onMarinaOpp: await t(org, contacts.marina, null, opp.marina, users.legacy),
    onMarcioConv: await t(org, contacts.marcio, conv.marcio, null, users.legacy),
    assigneeMarcio: await t(org, contacts.none, null, null, users.marcio),
    free: await t(org, contacts.none, null, null, null),
    // vínculos conflitantes: negócio da Marina + conversa do Márcio → o negócio decide.
    conflict: await t(org, contacts.marina, conv.marcio, opp.marina, null),
    otherOrg: await t(otherOrg, contacts.otherOrg, conv.otherOrg, opp.otherOrg, users.otherOrgUser),
  };
  return { org, otherOrg, users, contacts, conv, opp, task, msg };
}
