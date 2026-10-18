// packages/database/src/sql/manager-only-config-writes.test.ts
import { describe, expect, it } from "vitest";
import { createRlsDb, seedWorld, asUser } from "./rls-harness.js";

const MIG = "20261019120000_manager_only_config_writes.sql";
const TABLES = ["agents", "evolution_instances", "knowledge_documents", "knowledge_chunks", "knowledge_faqs", "agent_configs", "agent_playground_sessions", "agent_playground_messages", "agent_trainer_sessions", "agent_trainer_messages"];

async function setup(files: string[] = [MIG]) {
  const db = await createRlsDb(files);
  const w = await seedWorld(db, { isolation: false });
  const rows: Record<string, string> = {};
  for (const t of [...TABLES, "agent_versions"]) {
    rows[t] = (await db.query<any>(`insert into public.${t}(organization_id) values ($1) returning id`, [w.org])).rows[0].id;
  }
  return { db, w, rows };
}
type Db = Awaited<ReturnType<typeof createRlsDb>>;
const run = async (db: Db, user: string, sql: string, params: unknown[] = []) => {
  try { return { ok: true as const, count: (await asUser(db, user, () => db.query<any>(sql, params))).rows.length }; }
  catch (e: any) { return { ok: false as const, error: String(e.message) }; }
};

describe("sem a migration (comportamento de hoje)", () => {
  it("vendedor consegue apagar agente", async () => {
    const { db, w, rows } = await setup([]);
    expect(await run(db, w.users.marina, "delete from public.agents where id = $1 returning id", [rows.agents])).toMatchObject({ ok: true, count: 1 });
  });
});

describe.each(TABLES)("%s", (table) => {
  it("vendedor lê, mas não altera nem apaga nem cria", async () => {
    const { db, w, rows } = await setup();
    const seller = w.users.marina;
    expect((await run(db, seller, `select id from public.${table}`)).count).toBe(1);
    expect((await run(db, seller, `update public.${table} set organization_id = organization_id where id = $1 returning id`, [rows[table]])).count).toBe(0);
    expect((await run(db, seller, `delete from public.${table} where id = $1 returning id`, [rows[table]])).count).toBe(0);
    expect((await run(db, seller, `insert into public.${table}(organization_id) values ($1) returning id`, [w.org])).ok).toBe(false);
    expect((await run(db, w.users.support, `select id from public.${table}`)).count).toBe(1);
  });
  it("dono escreve; outra organização não enxerga", async () => {
    const { db, w, rows } = await setup();
    expect((await run(db, w.users.manager, `insert into public.${table}(organization_id) values ($1) returning id`, [w.org])).ok).toBe(true);
    expect((await run(db, w.users.manager, `update public.${table} set organization_id = organization_id where id = $1 returning id`, [rows[table]])).count).toBe(1);
    expect((await run(db, w.users.manager, `delete from public.${table} where id = $1 returning id`, [rows[table]])).count).toBe(1);
    expect((await run(db, w.users.otherOrgUser, `select id from public.${table}`)).count).toBe(0);
  });
  it("admin também escreve", async () => {
    const { db, w, rows } = await setup();
    const admin = crypto.randomUUID();
    await db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,'admin')", [w.org, admin]);
    expect((await run(db, admin, `update public.${table} set organization_id = organization_id where id = $1 returning id`, [rows[table]])).count).toBe(1);
  });
});

describe("agent_versions (append-only)", () => {
  it("vendedor lê, mas não publica versão; gestor publica", async () => {
    const { db, w } = await setup();
    expect((await run(db, w.users.marina, "select id from public.agent_versions")).count).toBe(1);
    expect((await run(db, w.users.marina, "insert into public.agent_versions(organization_id) values ($1) returning id", [w.org])).ok).toBe(false);
    expect((await run(db, w.users.manager, "insert into public.agent_versions(organization_id) values ($1) returning id", [w.org])).ok).toBe(true);
  });
});

describe("tabelas do dia a dia do vendedor não mudam", () => {
  it("vendedor segue escrevendo em conversas, notas e tarefas", async () => {
    const { db, w } = await setup();
    expect((await run(db, w.users.marina, "update public.conversations set status = 'open' where id = $1 returning id", [w.conv.marina])).count).toBe(1);
    expect((await run(db, w.users.marina, "insert into public.conversation_notes(organization_id,conversation_id,user_id) values ($1,$2,$3) returning id", [w.org, w.conv.marina, w.users.marina])).ok).toBe(true);
    expect((await run(db, w.users.marina, "update public.tasks set status = 'done' where id = $1 returning id", [w.task.onMarinaOpp])).count).toBe(1);
  });
});

describe("idempotência", () => {
  it("rodar a migration duas vezes não falha", async () => {
    const db = await createRlsDb([MIG, MIG]);
    expect(db).toBeTruthy();
  });
});
