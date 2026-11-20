// P0a, segurança: um vendedor (JWT do navegador) NÃO pode ler nem escrever nas tabelas novas, e o teste fixa o achado da auditoria:
// qualquer membro da organização lê organizations.settings inteiro, por isso os destinatários dos alertas NÃO ficam em settings.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { asUser, createRlsDb, RLS_MIGRATIONS, seedWorld, type World } from "./rls-harness.js";

type Db = Awaited<ReturnType<typeof createRlsDb>>;
let db: Db;
let w: World;
beforeEach(async () => {
  db = await createRlsDb([...RLS_MIGRATIONS]);
  await db.exec(readFileSync(new URL("../../../../supabase/migrations/20261116120000_exception_triage_alerts.sql", import.meta.url), "utf8"));
  // O harness concede ALL ao authenticated depois das migrações (o Supabase real concede por padrão ao criar a tabela); a RLS sem policy é a 2ª barreira.
  await db.exec("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated");
  w = await seedWorld(db, { isolation: true });
  const aid = crypto.randomUUID();
  await db.query("insert into public.exception_alert_recipients(organization_id,user_id) values ($1,$2)", [w.org, w.users.manager]);
  await db.query("insert into public.exception_events(organization_id,assignment_id,kind,actor_user_id,note) values ($1,$2,'acknowledged',$3,'x')", [w.org, aid, w.users.manager]);
  await db.query("insert into public.exception_alert_ledger(organization_id,assignment_id,stage,channel,recipient_user_id,mode) values ($1,$2,0,'push',$3,'on')", [w.org, aid, w.users.manager]);
});

const TABLES = ["exception_events", "exception_alert_ledger", "exception_alert_recipients"];

describe("tabelas novas: vendedor e gestor pelo navegador não leem nada (só service role)", () => {
  it.each(["marina", "marcio", "manager", "legacy"] as const)("%s vê 0 linhas em cada tabela", async who => {
    for (const t of TABLES) {
      const rows = await asUser(db, w.users[who], async () => (await db.query<any>(`select * from public.${t}`)).rows);
      expect(rows, `${who} ${t}`).toEqual([]);
    }
  });
  it.each(["marina", "marcio", "legacy"] as const)("%s não consegue inserir, atualizar nem apagar", async who => {
    await asUser(db, w.users[who], async () => {
      await expect(db.query("insert into public.exception_alert_recipients(organization_id,user_id) values ($1,$2)", [w.org, w.users[who]])).rejects.toThrow(/row-level security/i);
      await expect(db.query("insert into public.exception_events(organization_id,assignment_id,kind,actor_user_id) values ($1,$2,'acknowledged',$3)", [w.org, crypto.randomUUID(), w.users[who]])).rejects.toThrow(/row-level security/i);
      const upd = await db.query("update public.exception_alert_recipients set created_by = $1 returning user_id", [w.users[who]]);
      const del = await db.query("delete from public.exception_alert_recipients returning user_id");
      expect(upd.rows).toEqual([]);
      expect(del.rows).toEqual([]);
    });
    expect((await db.query<any>("select count(*)::int n from public.exception_alert_recipients")).rows[0].n).toBe(1);
  });
});

describe("achado da auditoria: settings é legível por qualquer membro", () => {
  it("o vendedor lê organizations.settings da própria organização (por isso destinatários/chaves NÃO podem morar lá)", async () => {
    await db.query("update public.organizations set settings = settings || '{\"health_alert_phone\":\"5562000000000\"}'::jsonb where id=$1", [w.org]);
    const s = await asUser(db, w.users.marina, async () => (await db.query<any>("select settings from public.organizations where id=$1", [w.org])).rows[0]?.settings);
    expect(s?.health_alert_phone).toBe("5562000000000");
  });
  it("mas não lê a organização de outro cliente", async () => {
    const rows = await asUser(db, w.users.marina, async () => (await db.query<any>("select id from public.organizations where id=$1", [w.otherOrg])).rows);
    expect(rows).toEqual([]);
  });
});
