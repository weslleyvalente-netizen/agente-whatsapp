// packages/database/src/sql/seller-isolation-regression.test.ts
import { describe, expect, it } from "vitest";
import { asUser, createRlsDb, seedWorld, visible } from "./rls-harness.js";

const TABLES = ["conversations", "messages", "opportunities", "tasks", "wa_contacts", "handoff_events", "conversation_notes"] as const;

describe("interruptor desligado = comportamento de hoje", () => {
  it("todo membro vê tudo da organização em todas as tabelas, e nada de outra", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db, { isolation: false });
    await db.query("insert into public.handoff_events(organization_id,conversation_id) values ($1,$2)", [w.org, w.conv.marina]);
    await db.query("insert into public.conversation_notes(organization_id,conversation_id,user_id) values ($1,$2,$3)", [w.org, w.conv.marina, w.users.manager]);
    const baseline = await createRlsDb([]); const wb = await seedWorld(baseline, { isolation: false });
    await baseline.query("insert into public.handoff_events(organization_id,conversation_id) values ($1,$2)", [wb.org, wb.conv.marina]);
    await baseline.query("insert into public.conversation_notes(organization_id,conversation_id,user_id) values ($1,$2,$3)", [wb.org, wb.conv.marina, wb.users.manager]);
    for (const t of TABLES) {
      const count = async (d: typeof db, u: string) => (await asUser(d, u, async () => (await d.query<any>(`select count(*)::int as n from public.${t}`)).rows[0].n));
      for (const user of ["marina", "marcio", "legacy", "support", "manager"] as const) expect(await count(db, w.users[user])).toBe(await count(baseline, wb.users[user]));
    }
  });
});

describe("organização sem vendedores", () => {
  it("ninguém é restringido mesmo com o interruptor ligado", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db, { isolation: true, withReps: false });
    expect(await visible(db, w.users.marcio, "conversations")).toContain(w.conv.marina);
    expect(await visible(db, w.users.marcio, "opportunities")).toContain(w.opp.marina);
    expect(await visible(db, w.users.marcio, "wa_contacts")).toContain(w.contacts.marina);
  });
});

describe("outra organização", () => {
  it("nenhum usuário vê dados de outra organização em nenhuma tabela, com o interruptor ligado", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    for (const t of TABLES) {
      for (const user of [w.users.manager, w.users.marina, w.users.marcio, w.users.legacy]) {
        const rows = await asUser(db, user, async () => (await db.query<any>(`select organization_id as o from public.${t}`)).rows.map(r => r.o));
        expect(rows).not.toContain(w.otherOrg);
      }
    }
    expect(await visible(db, w.users.otherOrgUser, "conversations")).toEqual([w.conv.otherOrg]);
  });
  it("o isolamento de uma organização não afeta a outra: a 2ª organização tem o interruptor ligado e vendedores próprios", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db, { isolation: false });
    // org principal desligada: Márcio vê tudo dela; outra organização continua isolada dele
    expect(await visible(db, w.users.marcio, "conversations")).toContain(w.conv.marina);
    expect(await visible(db, w.users.marcio, "conversations")).not.toContain(w.conv.otherOrg);
  });
});

describe("desempenho (não degradar de forma patológica)", () => {
  it("lê 40 mil mensagens como vendedor em tempo razoável e a política só mostra as do próprio", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    // 2.000 conversas (metade da Marina, metade do Márcio) × 20 mensagens
    await db.query(`
      with c as (
        insert into public.conversations(organization_id, contact_id, assigned_to)
        select $1, $2, case when g % 2 = 0 then $3::uuid else $4::uuid end from generate_series(1, 2000) g
        returning id)
      insert into public.messages(organization_id, conversation_id, content)
      select $1, c.id, 'm' from c, generate_series(1, 20)`, [w.org, w.contacts.none, w.users.marina, w.users.marcio]);
    const t0 = Date.now();
    const rows = await asUser(db, w.users.marcio, async () => (await db.query<any>("select count(*)::int as n from public.messages")).rows[0].n);
    const elapsed = Date.now() - t0;
    expect(rows).toBeGreaterThanOrEqual(20_000); // as 1.000 conversas dele × 20 (+ as seeds)
    expect(rows).toBeLessThan(25_000);           // e nenhuma das da Marina
    expect(elapsed).toBeLessThan(8_000);          // limite folgado: pega regressão grosseira (função por linha sem índice), não microvariação
    const one = Date.now();
    await asUser(db, w.users.marcio, async () => db.query("select * from public.messages where conversation_id = $1", [w.conv.marcio]));
    expect(Date.now() - one).toBeLessThan(1_000);
  });
});
