// packages/database/src/sql/harness.ts
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { FIXTURE_SQL } from "./fixture.js";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

export async function createTestDb(files: string[] = [
  "20261007120000_lead_distribution_schema.sql",
  "20261007120100_lead_distribution_assign.sql",
  "20261007120200_lead_distribution_lifecycle.sql",
]) {
  const db = new PGlite();
  await db.exec(FIXTURE_SQL);
  for (const file of files) {
    let sql: string;
    try { sql = readFileSync(new URL(file, MIGRATIONS), "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; } // tasks 4 e 5 criam os demais arquivos
    await db.exec(sql);
  }
  return db;
}

type Db = Awaited<ReturnType<typeof createTestDb>>;
export const uuid = async (db: Db) => (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;

export async function seedOrg(db: Db, settings: Record<string, unknown> = { lead_distribution_enabled: true }) {
  return (await db.query<{ id: string }>("insert into public.organizations(settings) values ($1) returning id", [JSON.stringify(settings)])).rows[0].id;
}

/** Cria um vendedor: membro da organização + linha em sales_reps. rotation_order define a vez. */
export async function seedRep(db: Db, orgId: string, name: string, order: number, availability = "available", member = true) {
  const userId = await uuid(db);
  if (member) await db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,'agent')", [orgId, userId]);
  const repId = (await db.query<{ id: string }>(
    "insert into public.sales_reps(organization_id,user_id,display_name,availability,rotation_order) values ($1,$2,$3,$4,$5) returning id",
    [orgId, userId, name, availability, order])).rows[0].id;
  return { repId, userId };
}

/** Contato + conversa + evento de handoff (request_human). */
export async function seedHandoff(db: Db, orgId: string, handedAt = new Date().toISOString()) {
  const contactId = (await db.query<{ id: string }>("insert into public.wa_contacts(organization_id) values ($1) returning id", [orgId])).rows[0].id;
  const conversationId = (await db.query<{ id: string }>("insert into public.conversations(organization_id,contact_id) values ($1,$2) returning id", [orgId, contactId])).rows[0].id;
  const handoffId = (await db.query<{ id: string }>("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,$3) returning id", [orgId, conversationId, handedAt])).rows[0].id;
  return { contactId, conversationId, handoffId };
}

export const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
