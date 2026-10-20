import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRlsDb } from "./rls-harness.js";

const M = (f: string) => new URL(`../../../../supabase/migrations/${f}`, import.meta.url);
const OWNER_OPEN = M("20261020120000_owner_on_opportunity_create.sql");
const SYNC_OWNER = M("20261015120000_sync_owner_on_conversation_assign.sql");
const MIGRATION = M("20261021120000_human_task_opens_opportunity.sql");

async function setup(settings: object = { sales_auto_pipeline_enabled: true }, { apply = true } = {}) {
  const db = await createRlsDb([]);
  // colunas/tabelas de produção que o esquema mínimo de teste não tem
  await db.exec(`
    ALTER TABLE public.opportunities ADD COLUMN owner_assigned_at timestamptz, ADD COLUMN operation text NOT NULL DEFAULT 'vehicle_sale',
      ADD COLUMN stage text NOT NULL DEFAULT 'interest_received', ADD COLUMN initial_operation text NOT NULL DEFAULT 'vehicle_sale',
      ADD COLUMN last_progress_at timestamptz, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE public.tasks ADD COLUMN assignee_type text, ADD COLUMN type text NOT NULL DEFAULT 'return_customer';
    ALTER TABLE public.wa_contacts ADD COLUMN phone text;
    ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS last_message_at timestamptz; ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE public.opportunity_events ADD COLUMN previous_value jsonb, ADD COLUMN new_value jsonb, ADD COLUMN evidence text, ADD COLUMN changed_by_type text, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
    CREATE TABLE public.organization_ignored_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), phone text NOT NULL);
  `);
  await db.exec(readFileSync(OWNER_OPEN, "utf8"));
  await db.exec(readFileSync(SYNC_OWNER, "utf8"));
  if (apply) await db.exec(readFileSync(MIGRATION, "utf8"));
  const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
  const org = (await q("insert into public.organizations(settings) values ($1) returning id", [JSON.stringify(settings)]))[0].id;
  const other = (await q("insert into public.organizations(settings) values ($1) returning id", [JSON.stringify(settings)]))[0].id;
  const contact = (await q("insert into public.wa_contacts(organization_id,phone) values ($1,'5511999990001') returning id", [org]))[0].id;
  const marina = crypto.randomUUID(), shared = crypto.randomUUID();
  await q("insert into public.sales_reps(organization_id,user_id) values ($1,$2)", [org, marina]);
  const task = async (o: string, c: string, type: "human" | "ai", assignee: string | null, status = "pending") =>
    (await q("insert into public.tasks(organization_id,contact_id,assignee_type,assignee_id,status) values ($1,$2,$3,$4,$5) returning id", [o, c, type, assignee, status]))[0].id as string;
  const opps = (o: string, c: string) => q("select * from public.opportunities where organization_id=$1 and contact_id=$2 order by created_at", [o, c]);
  return { db, q, org, other, contact, marina, shared, task, opps };
}

describe("human_task_opens_opportunity", () => {
  it("tarefa humana sem negócio cria negócio aberto na etapa inicial, vinculado à tarefa e com o dono da tarefa", async () => {
    const s = await setup();
    const t = await s.task(s.org, s.contact, "human", s.marina);
    const [o, ...rest] = await s.opps(s.org, s.contact);
    expect(rest).toHaveLength(0);
    expect(o).toMatchObject({ status: "open", operation: "vehicle_sale", initial_operation: "vehicle_sale", stage: "interest_received", owner_id: s.marina });
    expect(o.owner_assigned_at).not.toBeNull();
    expect((await s.q("select opportunity_id from public.tasks where id=$1", [t]))[0].opportunity_id).toBe(o.id);
    const ev = await s.q("select event_type, changed_by_type, evidence, new_value from public.opportunity_events where opportunity_id=$1", [o.id]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "created", changed_by_type: "system", evidence: "Negócio criado porque o vendedor recebeu uma tarefa sem negócio" });
  });

  it("responsável que não é vendedor cadastrado: negócio sem dono", async () => {
    const s = await setup();
    await s.task(s.org, s.contact, "human", s.shared);
    const [o] = await s.opps(s.org, s.contact);
    expect(o.owner_id).toBeNull();
  });

  it("responsável não vendedor + conversa de vendedor: gatilho trg_owner_on_opportunity_open herda a conversa", async () => {
    const s = await setup();
    await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [s.org, s.contact, s.marina]);
    await s.task(s.org, s.contact, "human", s.shared);
    expect((await s.opps(s.org, s.contact))[0].owner_id).toBe(s.marina);
  });

  it("dono da tarefa prevalece sobre o da conversa e o sync de atribuição da conversa convive sem duplicar", async () => {
    const s = await setup();
    const marcio = crypto.randomUUID();
    await s.q("insert into public.sales_reps(organization_id,user_id) values ($1,$2)", [s.org, marcio]);
    const conv = (await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3) returning id", [s.org, s.contact, marcio]))[0].id;
    await s.task(s.org, s.contact, "human", s.marina);
    expect((await s.opps(s.org, s.contact))[0].owner_id).toBe(s.marina);
    await s.q("update public.conversations set assigned_to=$2 where id=$1", [conv, s.marina]);
    expect(await s.opps(s.org, s.contact)).toHaveLength(1);
  });

  it("não cria para tarefa da IA, nem para concluída/cancelada", async () => {
    const s = await setup();
    await s.task(s.org, s.contact, "ai", null);
    await s.task(s.org, s.contact, "human", s.marina, "completed");
    await s.task(s.org, s.contact, "human", s.marina, "cancelled");
    expect(await s.opps(s.org, s.contact)).toHaveLength(0);
  });

  it("não cria se já há negócio aberto (mesmo de outro dono) e não mexe nele", async () => {
    const s = await setup();
    const opp = (await s.q("insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3) returning id", [s.org, s.contact, s.shared]))[0].id;
    const t = await s.task(s.org, s.contact, "human", s.marina);
    const all = await s.opps(s.org, s.contact);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: opp, owner_id: s.shared });
    expect((await s.q("select opportunity_id from public.tasks where id=$1", [t]))[0].opportunity_id).toBeNull();
  });

  it("negócio só fechado (ganho/perdido) não conta: abre novo, herdando a operação do último", async () => {
    const s = await setup();
    await s.q("insert into public.opportunities(organization_id,contact_id,status,operation,initial_operation) values ($1,$2,'lost','financing','financing')", [s.org, s.contact]);
    await s.task(s.org, s.contact, "human", s.marina);
    const all = await s.opps(s.org, s.contact);
    expect(all).toHaveLength(2);
    expect(all.filter(o => o.status === "open")).toHaveLength(1);
    expect(all.find(o => o.status === "open")).toMatchObject({ operation: "financing", initial_operation: "financing", stage: "interest_received" });
  });

  it("idempotente: duas tarefas humanas do mesmo contato geram 1 negócio (só a que abriu fica vinculada)", async () => {
    const s = await setup();
    const t1 = await s.task(s.org, s.contact, "human", s.marina);
    const t2 = await s.task(s.org, s.contact, "human", s.marina);
    const all = await s.opps(s.org, s.contact);
    expect(all).toHaveLength(1);
    const links = await s.q("select opportunity_id from public.tasks where id in ($1,$2)", [t1, t2]);
    expect(links.map(l => l.opportunity_id).sort()).toEqual([all[0].id, null].sort());
    expect(await s.q("select 1 from public.opportunity_events where opportunity_id=$1", [all[0].id])).toHaveLength(1);
  });

  it("respeita a flag: desligada ou ausente não cria", async () => {
    for (const settings of [{}, { sales_auto_pipeline_enabled: false }, { sales_auto_pipeline_enabled: "true" }]) {
      const s = await setup(settings);
      await s.task(s.org, s.contact, "human", s.marina);
      expect(await s.opps(s.org, s.contact)).toHaveLength(0);
    }
  });

  it("não atravessa organizações: negócio aberto de outra org não impede; tarefa não cria na outra", async () => {
    const s = await setup();
    const c2 = (await s.q("insert into public.wa_contacts(organization_id,phone) values ($1,'5511999990002') returning id", [s.other]))[0].id;
    await s.q("insert into public.opportunities(organization_id,contact_id) values ($1,$2)", [s.other, c2]);
    await s.task(s.org, s.contact, "human", s.marina);
    expect(await s.opps(s.org, s.contact)).toHaveLength(1);
    expect(await s.opps(s.other, c2)).toHaveLength(1);
  });

  it("tarefa que muda de IA para humano depois dispara; mudar de status para aberto também", async () => {
    const s = await setup();
    const t = await s.task(s.org, s.contact, "ai", null);
    expect(await s.opps(s.org, s.contact)).toHaveLength(0);
    await s.q("update public.tasks set assignee_type='human', assignee_id=$2 where id=$1", [t, s.marina]);
    const [o] = await s.opps(s.org, s.contact);
    expect(o).toMatchObject({ owner_id: s.marina, status: "open" });
    expect((await s.q("select opportunity_id from public.tasks where id=$1", [t]))[0].opportunity_id).toBe(o.id);

    const c2 = (await s.q("insert into public.wa_contacts(organization_id) values ($1) returning id", [s.org]))[0].id;
    const t2 = await s.task(s.org, c2, "human", s.marina, "completed");
    expect(await s.opps(s.org, c2)).toHaveLength(0);
    await s.q("update public.tasks set status='rescheduled' where id=$1", [t2]);
    expect(await s.opps(s.org, c2)).toHaveLength(1);
  });

  it("não sobrescreve vínculo existente da tarefa com outro negócio", async () => {
    const s = await setup();
    const closed = (await s.q("insert into public.opportunities(organization_id,contact_id,status) values ($1,$2,'won') returning id", [s.org, s.contact]))[0].id;
    const t = (await s.q("insert into public.tasks(organization_id,contact_id,assignee_type,assignee_id,opportunity_id) values ($1,$2,'human',$3,$4) returning id", [s.org, s.contact, s.marina, closed]))[0].id;
    expect((await s.q("select opportunity_id from public.tasks where id=$1", [t]))[0].opportunity_id).toBe(closed);
    expect((await s.opps(s.org, s.contact)).filter(o => o.status === "open")).toHaveLength(1);
  });

  it("contato na lista de ignorados da organização não ganha negócio", async () => {
    const s = await setup();
    await s.q("insert into public.organization_ignored_contacts(organization_id,phone) values ($1,'5511999990001')", [s.org]);
    await s.task(s.org, s.contact, "human", s.marina);
    expect(await s.opps(s.org, s.contact)).toHaveLength(0);
  });

  it("migration é idempotente (pode rodar duas vezes) e continua funcionando", async () => {
    const s = await setup();
    await s.db.exec(readFileSync(MIGRATION, "utf8"));
    await s.task(s.org, s.contact, "human", s.marina);
    expect(await s.opps(s.org, s.contact)).toHaveLength(1);
  });
});
