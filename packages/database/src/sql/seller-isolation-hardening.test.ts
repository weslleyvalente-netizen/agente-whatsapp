import { beforeEach, describe, expect, it } from "vitest";
import { asUser, createRlsDb, seedWorld, visible, type World } from "./rls-harness.js";

let db: Awaited<ReturnType<typeof createRlsDb>>; let w: World;
beforeEach(async () => { db = await createRlsDb(); w = await seedWorld(db); });
const one = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0].id as string;
const contact = (org = w.org) => one("insert into public.wa_contacts(organization_id,name) values ($1,'c') returning id", [org]);
const as = <T,>(user: string | null, fn: () => Promise<T>) => asUser(db, user, fn);

describe("wa_contacts considera conversas, negócios e tarefas", () => {
  it("contato ligado só ao negócio da Marina fica oculto ao Márcio (e visível à Marina e ao gestor)", async () => {
    const c = await contact();
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3)", [w.org, c, w.users.marina]);
    expect(await visible(db, w.users.marcio, "wa_contacts")).not.toContain(c);
    expect(await visible(db, w.users.marina, "wa_contacts")).toContain(c);
    expect(await visible(db, w.users.manager, "wa_contacts")).toContain(c);
  });
  it("contato ligado só à tarefa (sem vínculos) atribuída à Marina fica oculto ao Márcio", async () => {
    const c = await contact();
    await db.query("insert into public.tasks(organization_id,contact_id,assignee_id) values ($1,$2,$3)", [w.org, c, w.users.marina]);
    expect(await visible(db, w.users.marcio, "wa_contacts")).not.toContain(c);
    expect(await visible(db, w.users.marina, "wa_contacts")).toContain(c);
  });
  it("decisão: negócio sem dono visível ao Márcio mantém visível o contato que só tem conversas da Marina", async () => {
    const c = await contact();
    await db.query("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [w.org, c, w.users.marina]);
    expect(await visible(db, w.users.marcio, "wa_contacts")).not.toContain(c);
    await db.query("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,null)", [w.org, c]);
    expect(await visible(db, w.users.marcio, "wa_contacts")).toContain(c);
  });
  it("contato sem nenhum vínculo continua visível; contato de outra organização nunca", async () => {
    const c = await contact();
    expect(await visible(db, w.users.marcio, "wa_contacts")).toContain(c);
    expect(await visible(db, w.users.marcio, "wa_contacts")).not.toContain(w.contacts.otherOrg);
  });
});

describe("anon (Realtime avalia políticas antes do JWT)", () => {
  it("não dá erro e não devolve linhas", async () => {
    await db.exec("GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon");
    await db.exec("SET ROLE anon");
    try {
      for (const t of ["conversations", "messages", "opportunities", "tasks", "wa_contacts", "handoff_events", "lead_assignments", "task_events"]) {
        expect((await db.query<any>(`select count(*)::int as n from public.${t}`)).rows[0].n).toBe(0);
      }
    } finally { await db.exec("RESET ROLE"); }
  });
});

describe("funções não vazam entre organizações", () => {
  it("usuário de outra organização recebe o valor inofensivo para a organização/contato alheios", async () => {
    const r = await as(w.users.otherOrgUser, async () => (await db.query<any>(
      `select public.seller_isolation_applies($1) a, public.seller_can_see($1,$2) b, public.contact_has_any_conversation($3) c, public.contact_has_any_link($3) d,
              (select array_agg(i) from public.seller_isolation_org_ids() i) orgs, (select count(*)::int from public.seller_hidden_owners() h where h.organization_id = $1) hidden`,
      [w.org, w.users.marina, w.contacts.marina])).rows[0]);
    expect(r.a).toBe(false); expect(r.b).toBe(true); expect(r.c).toBe(false); expect(r.d).toBe(false);
    expect(r.orgs).toEqual([w.otherOrg]); expect(r.hidden).toBe(0);
  });
});

describe("WITH CHECK em dependentes e precedência no INSERT de tarefa", () => {
  it("o Márcio não move a mensagem dele para a conversa da Marina", async () => {
    const m = await one("insert into public.messages(organization_id,conversation_id,content) values ($1,$2,'x') returning id", [w.org, w.conv.marcio]);
    await as(w.users.marcio, async () => {
      await expect(db.query("update public.messages set conversation_id=$2 where id=$1", [m, w.conv.marina])).rejects.toThrow(/row-level security/i);
      expect((await db.query("update public.messages set content='y' where id=$1", [m])).affectedRows).toBe(1);
    });
  });
  it("INSERT de tarefa: o vínculo mais forte decide", async () => {
    const ins = (conv: string | null, opp: string | null, assignee: string | null) =>
      db.query("insert into public.tasks(organization_id,contact_id,conversation_id,opportunity_id,assignee_id) values ($1,$2,$3,$4,$5)", [w.org, w.contacts.none, conv, opp, assignee]);
    await as(w.users.marcio, async () => {
      await expect(ins(w.conv.marcio, w.opp.marina, null)).rejects.toThrow(/row-level security/i);   // negócio da Marina vence a conversa dele
      await expect(ins(w.conv.marina, null, w.users.marcio)).rejects.toThrow(/row-level security/i);  // conversa da Marina vence o responsável
      await expect(ins(null, null, w.users.marina)).rejects.toThrow(/row-level security/i);           // responsável outro vendedor
      await ins(w.conv.marina, w.opp.marcio, null);                                                    // negócio dele vence a conversa da Marina
      await ins(w.conv.marcio, null, w.users.marina);                                                  // conversa dele vence o responsável
      await ins(null, null, w.users.marcio);
    });
  });
});

describe("lead_assignments", () => {
  it("com o isolamento aplicado, o vendedor só lê as atribuições do próprio rep_id", async () => {
    const rep = async (u: string) => one("select id from public.sales_reps where user_id=$1", [u]);
    const a = (r: string | null, conv: string) => one("insert into public.lead_assignments(organization_id,contact_id,conversation_id,rep_id) values ($1,$2,$3,$4) returning id", [w.org, w.contacts.none, conv, r]);
    const forMarina = await a(await rep(w.users.marina), w.conv.marina); const forMarcio = await a(await rep(w.users.marcio), w.conv.marcio); const noRep = await a(null, w.conv.none);
    expect(await visible(db, w.users.marcio, "lead_assignments")).toEqual([forMarcio]);
    expect(await visible(db, w.users.marina, "lead_assignments")).toEqual([forMarina]);
    expect(await visible(db, w.users.support, "lead_assignments")).toEqual([]);
    expect(await visible(db, w.users.manager, "lead_assignments")).toEqual([forMarina, forMarcio, noRep].sort());
    expect(await visible(db, w.users.otherOrgUser, "lead_assignments")).toEqual([]);
  });
  it("interruptor desligado: todos veem toda a organização", async () => {
    const off = await createRlsDb(); const wo = await seedWorld(off, { isolation: false });
    await off.query("insert into public.lead_assignments(organization_id,contact_id,conversation_id,rep_id) values ($1,$2,$3,null)", [wo.org, wo.contacts.none, wo.conv.marina]);
    expect(await visible(off, wo.users.marcio, "lead_assignments")).toHaveLength(1);
  });
});

describe("plano de execução (sem função pesada por linha)", () => {
  beforeEach(async () => {
    await db.query("insert into public.conversations(organization_id, contact_id, assigned_to) select $1,$2,$3 from generate_series(1,2000)", [w.org, w.contacts.none, w.users.marina]);
  });
  it.each(["conversations", "messages", "opportunities", "tasks", "wa_contacts"])("%s: helpers entram como SubPlan/InitPlan e executam uma vez", async (t) => {
    const plan = await as(w.users.marcio, async () => (await db.query<any>(`explain analyze select * from public.${t}`)).rows.map(r => r["QUERY PLAN"]).join("\n"));
    expect(plan).toMatch(/hashed SubPlan|InitPlan/);
    expect(plan).not.toMatch(/seller_can_see|seller_isolation_applies/);
    const scans = plan.split("\n").filter(l => l.includes("Function Scan on seller_hidden_owners"));
    expect(scans.length).toBeGreaterThan(0);
    for (const l of scans) expect(l).toMatch(/loops=1\)|never executed/);
    if (t !== "wa_contacts") expect(plan).not.toMatch(/contact_has_any/);
  });
});
