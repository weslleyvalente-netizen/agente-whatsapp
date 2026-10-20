import { readFileSync } from "node:fs";
import { classifySalesQueue } from "@aula-agente/shared";
import { describe, expect, it } from "vitest";
import { createRlsDb } from "./rls-harness.js";

const M = (f: string) => new URL(`../../../../supabase/migrations/${f}`, import.meta.url);
const OWNER_OPEN = M("20261020120000_owner_on_opportunity_create.sql");
const SYNC_OWNER = M("20261015120000_sync_owner_on_conversation_assign.sql");
const BACKFILL = M("../backfills/20261020_open_opportunities_for_human_tasks.sql");
const MIGRATION = M("20261021120000_human_task_opens_opportunity.sql");

// Colunas/constraints de produção (00010, 00024, 00027) que o esquema mínimo do rls-fixture não tem.
export const REALISTIC_SCHEMA = `
  ALTER TABLE public.opportunities ADD COLUMN owner_assigned_at timestamptz, ADD COLUMN operation text NOT NULL, ADD COLUMN stage text NOT NULL,
    ADD COLUMN initial_operation text NOT NULL, ADD COLUMN last_progress_at timestamptz, ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD CONSTRAINT opp_operation_chk CHECK (operation IN ('vehicle_sale','consortium','financing','libera_cred','contemplated_letter')),
    ADD CONSTRAINT opp_status_chk CHECK (status IN ('open','won','lost'));
  ALTER TABLE public.tasks ADD COLUMN assignee_type text CHECK (assignee_type IN ('human','ai')), ADD COLUMN type text NOT NULL DEFAULT 'other',
    ADD COLUMN due_date date NOT NULL DEFAULT current_date, ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD CONSTRAINT tasks_status_chk CHECK (status IN ('pending','in_progress','completed','cancelled','rescheduled')),
    ADD CONSTRAINT tasks_assignee_consistency CHECK ((assignee_type IS NULL AND assignee_id IS NULL) OR (assignee_type = 'ai' AND assignee_id IS NULL) OR (assignee_type = 'human' AND assignee_id IS NOT NULL));
  ALTER TABLE public.task_events ADD COLUMN note text, ADD COLUMN created_by_type text NOT NULL CHECK (created_by_type IN ('ai','human'));
  ALTER TABLE public.wa_contacts ADD COLUMN phone text;
  ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS last_message_at timestamptz; ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE public.opportunity_events ADD COLUMN previous_value jsonb, ADD COLUMN new_value jsonb, ADD COLUMN evidence text NOT NULL, ADD COLUMN changed_by_type text NOT NULL,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD CONSTRAINT oe_type_chk CHECK (event_type IN ('created','stage_changed','operation_changed','won','lost','reopened','owner_changed','next_action_updated','waiting_on_changed')),
    ADD CONSTRAINT oe_by_chk CHECK (changed_by_type IN ('ai','human','system'));
  CREATE TABLE public.organization_ignored_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), phone text NOT NULL, UNIQUE (organization_id, phone));
  ALTER TABLE public.lead_assignments ADD COLUMN opportunity_id uuid REFERENCES public.opportunities(id);
  CREATE TABLE public.sales_call_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), opportunity_id uuid NOT NULL REFERENCES public.opportunities(id) ON DELETE CASCADE);
`;

async function setup(settings: object = { sales_auto_pipeline_enabled: true }, { apply = true } = {}) {
  const db = await createRlsDb([]);
  await db.exec(REALISTIC_SCHEMA);
  await db.exec(readFileSync(OWNER_OPEN, "utf8"));
  await db.exec(readFileSync(SYNC_OWNER, "utf8"));
  if (apply) await db.exec(readFileSync(MIGRATION, "utf8"));
  const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
  const org = (await q("insert into public.organizations(settings) values ($1) returning id", [JSON.stringify(settings)]))[0].id;
  const other = (await q("insert into public.organizations(settings) values ($1) returning id", [JSON.stringify(settings)]))[0].id;
  const contact = (await q("insert into public.wa_contacts(organization_id,phone) values ($1,'5511999990001') returning id", [org]))[0].id;
  const marina = crypto.randomUUID(), shared = crypto.randomUUID();
  await q("insert into public.sales_reps(organization_id,user_id) values ($1,$2)", [org, marina]);
  let n = 0;
  const task = async (o: string, c: string, kind: "human" | "ai", assignee: string | null, opts: { status?: string; type?: string; opportunityId?: string | null; dueDate?: string } = {}) =>
    (await q("insert into public.tasks(organization_id,contact_id,assignee_type,assignee_id,status,type,opportunity_id,due_date,created_at) values ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date,current_date),now() + ($9 || ' seconds')::interval) returning id",
      [o, c, kind, assignee, opts.status ?? "pending", opts.type ?? "consortium_followup", opts.opportunityId ?? null, opts.dueDate ?? null, String(n++)]))[0].id as string;
  const opp = async (o: string, c: string, status = "open", operation = "vehicle_sale", owner: string | null = null) =>
    (await q("insert into public.opportunities(organization_id,contact_id,status,operation,initial_operation,stage,owner_id) values ($1,$2,$3,$4,$4,'interest_received',$5) returning id", [o, c, status, operation, owner]))[0].id as string;
  const opps = (o: string, c: string) => q("select * from public.opportunities where organization_id=$1 and contact_id=$2 order by created_at", [o, c]);
  const linkOf = async (t: string) => (await q("select opportunity_id from public.tasks where id=$1", [t]))[0].opportunity_id;
  return { db, q, org, other, contact, marina, shared, task, opp, opps, linkOf };
}

describe("human_task_opens_opportunity", () => {
  it("tarefa humana sem histórico cria negócio com operação do tipo, etapa inicial, dono, vínculo, evento e task_event", async () => {
    const s = await setup();
    const t = await s.task(s.org, s.contact, "human", s.marina);
    const [o, ...rest] = await s.opps(s.org, s.contact);
    expect(rest).toHaveLength(0);
    expect(o).toMatchObject({ status: "open", operation: "consortium", initial_operation: "consortium", stage: "interest_received", owner_id: s.marina });
    expect(o.owner_assigned_at).not.toBeNull();
    expect(await s.linkOf(t)).toBe(o.id);
    const ev = await s.q("select event_type, changed_by_type, evidence, new_value from public.opportunity_events where opportunity_id=$1", [o.id]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "created", changed_by_type: "system", evidence: "Negócio criado porque o vendedor recebeu uma tarefa sem negócio", new_value: { source: "human_task_trigger", task_id: t } });
    expect(await s.q("select event_type from public.task_events where task_id=$1", [t])).toEqual([{ event_type: "opportunity_auto_linked" }]);
  });

  it("operação vem do tipo da tarefa; tipo ambíguo ou desconhecido não cria (nada de chute)", async () => {
    const cases: Array<[string, string | null]> = [["consortium_followup", "consortium"], ["vehicle_followup", "vehicle_sale"], ["financing_followup", "financing"], ["libera_cred_resumption", "libera_cred"],
      ["return_customer", null], ["scheduled_callback", null], ["proposal_followup", null], ["other", null]];
    for (const [type, op] of cases) {
      const s = await setup();
      await s.task(s.org, s.contact, "human", s.marina, { type });
      const all = await s.opps(s.org, s.contact);
      if (op) expect(all.map(o => o.operation)).toEqual([op]); else expect(all).toHaveLength(0);
    }
  });

  it("dono: prefere o vendedor da conversa; senão o assignee se for vendedor; assignee que não é vendedor nunca vira dono", async () => {
    const marcio = crypto.randomUUID();
    let s = await setup();
    await s.q("insert into public.sales_reps(organization_id,user_id) values ($1,$2)", [s.org, marcio]);
    await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [s.org, s.contact, marcio]);
    await s.task(s.org, s.contact, "human", s.marina);
    expect((await s.opps(s.org, s.contact))[0].owner_id).toBe(marcio); // conversa do Márcio, tarefa da Marina: não separa

    s = await setup();
    await s.task(s.org, s.contact, "human", s.marina);
    expect((await s.opps(s.org, s.contact))[0].owner_id).toBe(s.marina); // sem conversa: assignee vendedor

    s = await setup();
    await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [s.org, s.contact, s.shared]);
    await s.task(s.org, s.contact, "human", s.shared);
    expect((await s.opps(s.org, s.contact))[0].owner_id).toBeNull(); // conta compartilhada nos dois

    s = await setup();
    await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [s.org, s.contact, s.marina]);
    await s.task(s.org, s.contact, "human", s.shared);
    expect((await s.opps(s.org, s.contact))[0].owner_id).toBe(s.marina); // conversa de vendedor, tarefa da compartilhada
  });

  it("convive com trg_sync_owner_on_conversation_assign: reatribuir a conversa depois leva o dono, sem duplicar negócio", async () => {
    const s = await setup();
    const marcio = crypto.randomUUID();
    await s.q("insert into public.sales_reps(organization_id,user_id) values ($1,$2)", [s.org, marcio]);
    const conv = (await s.q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3) returning id", [s.org, s.contact, marcio]))[0].id;
    await s.task(s.org, s.contact, "human", s.marina);
    await s.q("update public.conversations set assigned_to=$2 where id=$1", [conv, s.marina]);
    const all = await s.opps(s.org, s.contact);
    expect(all).toHaveLength(1);
    expect(all[0].owner_id).toBe(s.marina);
  });

  it("não cria para tarefa da IA, concluída ou cancelada", async () => {
    const s = await setup();
    await s.task(s.org, s.contact, "ai", null);
    await s.task(s.org, s.contact, "human", s.marina, { status: "completed" });
    await s.task(s.org, s.contact, "human", s.marina, { status: "cancelled" });
    expect(await s.opps(s.org, s.contact)).toHaveLength(0);
  });

  it("não cria se já há negócio aberto (de qualquer dono) e não mexe nele nem na tarefa", async () => {
    const s = await setup();
    const o = await s.opp(s.org, s.contact, "open", "financing", s.shared);
    const t = await s.task(s.org, s.contact, "human", s.marina);
    const all = await s.opps(s.org, s.contact);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: o, owner_id: s.shared });
    expect(await s.linkOf(t)).toBeNull();
  });

  it("contato só com negócio fechado (perdido ou ganho) NÃO ganha negócio novo, nem a tarefa de negócio fechado é religada", async () => {
    for (const status of ["lost", "won"]) {
      const s = await setup();
      const closed = await s.opp(s.org, s.contact, status, "financing");
      const linked = await s.task(s.org, s.contact, "human", s.marina, { opportunityId: closed });
      const free = await s.task(s.org, s.contact, "human", s.marina);
      const all = await s.opps(s.org, s.contact);
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe(status);
      expect(await s.linkOf(linked)).toBe(closed);
      expect(await s.linkOf(free)).toBeNull();
      // mudar para humano/reagendar depois (sync de conversa, redistribuição) também não ressuscita
      await s.q("update public.tasks set status='rescheduled' where id=$1", [linked]);
      await s.q("update public.tasks set assignee_type='human', assignee_id=$2 where id=$1", [linked, s.marina]);
      expect(await s.opps(s.org, s.contact)).toHaveLength(1);
    }
  });

  it("tarefa que já tem opportunity_id nunca abre outro negócio", async () => {
    const s = await setup();
    const other = await s.opp(s.org, (await s.q("insert into public.wa_contacts(organization_id) values ($1) returning id", [s.org]))[0].id, "open");
    const t = await s.task(s.org, s.contact, "human", s.marina, { opportunityId: other });
    expect(await s.opps(s.org, s.contact)).toHaveLength(0);
    expect(await s.linkOf(t)).toBe(other);
  });

  it("liga todas as tarefas abertas sem vínculo do contato ao negócio novo; mais tarefas depois não geram outro negócio", async () => {
    const s = await setup();
    const a = await s.task(s.org, s.contact, "human", s.marina, { type: "return_customer" }); // tipo sem operação: sem card, mas será ligada
    const ai = await s.task(s.org, s.contact, "ai", null, { type: "customer_unresponsive" });
    const done = await s.task(s.org, s.contact, "human", s.marina, { type: "return_customer", status: "completed" });
    expect(await s.opps(s.org, s.contact)).toHaveLength(0);
    const b = await s.task(s.org, s.contact, "human", s.marina); // abre
    const all = await s.opps(s.org, s.contact);
    expect(all).toHaveLength(1);
    expect(await s.linkOf(a)).toBe(all[0].id);
    expect(await s.linkOf(b)).toBe(all[0].id);
    expect(await s.linkOf(ai)).toBe(all[0].id); // aberta sem vínculo, como sync_sales_pipeline faz
    expect(await s.linkOf(done)).toBeNull();
    await s.task(s.org, s.contact, "human", s.marina);
    expect(await s.opps(s.org, s.contact)).toHaveLength(1);
  });

  it("respeita a flag: desligada, ausente ou string não cria", async () => {
    for (const settings of [{}, { sales_auto_pipeline_enabled: false }, { sales_auto_pipeline_enabled: "true" }]) {
      const s = await setup(settings);
      await s.task(s.org, s.contact, "human", s.marina);
      expect(await s.opps(s.org, s.contact)).toHaveLength(0);
    }
  });

  it("não atravessa organizações", async () => {
    const s = await setup();
    const c2 = (await s.q("insert into public.wa_contacts(organization_id,phone) values ($1,'5511999990002') returning id", [s.other]))[0].id;
    await s.opp(s.other, c2);
    const c3 = (await s.q("insert into public.wa_contacts(organization_id,phone) values ($1,'5511999990003') returning id", [s.other]))[0].id;
    await s.task(s.org, s.contact, "human", s.marina);
    expect(await s.opps(s.org, s.contact)).toHaveLength(1);
    expect(await s.opps(s.other, c2)).toHaveLength(1);
    expect(await s.opps(s.other, c3)).toHaveLength(0);
    // negócio de OUTRA organização para um contato de mesmo id é impossível; o histórico de outra org não bloqueia esta
  });

  it("tarefa que muda de IA para humano, ou reabre (status), dispara", async () => {
    const s = await setup();
    const t = await s.task(s.org, s.contact, "ai", null);
    expect(await s.opps(s.org, s.contact)).toHaveLength(0);
    await s.q("update public.tasks set assignee_type='human', assignee_id=$2 where id=$1", [t, s.marina]);
    const [o] = await s.opps(s.org, s.contact);
    expect(o).toMatchObject({ owner_id: s.marina, status: "open" });
    expect(await s.linkOf(t)).toBe(o.id);

    const c2 = (await s.q("insert into public.wa_contacts(organization_id) values ($1) returning id", [s.org]))[0].id;
    const t2 = await s.task(s.org, c2, "human", s.marina, { status: "completed" });
    expect(await s.opps(s.org, c2)).toHaveLength(0);
    await s.q("update public.tasks set status='rescheduled' where id=$1", [t2]);
    expect(await s.opps(s.org, c2)).toHaveLength(1);
  });

  it("contato na lista de ignorados da organização não ganha negócio", async () => {
    const s = await setup();
    await s.q("insert into public.organization_ignored_contacts(organization_id,phone) values ($1,'5511999990001')", [s.org]);
    await s.task(s.org, s.contact, "human", s.marina);
    expect(await s.opps(s.org, s.contact)).toHaveLength(0);
  });

  it("onde o card cai (classifySalesQueue): nunca vazio, nunca 'Pronto para assumir' só por causa da tarefa", async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const day = (delta: number) => new Date(Date.parse(`${today}T12:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
    const expected: Array<[string, string, string]> = [
      ["consortium_followup", day(-3), "overdue"], ["consortium_followup", today, "action"], ["consortium_followup", day(5), "scheduled"], ["vehicle_followup", day(-3), "overdue"],
    ];
    for (const [type, due, group] of expected) {
      const s = await setup();
      const t = await s.task(s.org, s.contact, "human", s.marina, { type, dueDate: due });
      const o = (await s.opps(s.org, s.contact))[0];
      const rows = await s.q("select id, type, due_date::text as due_date, priority from public.tasks where opportunity_id=$1", [o.id]);
      expect(rows.map(r => r.id)).toEqual([t]); // tem tarefa vinculada: não é card fantasma
      const res = classifySalesQueue({ id: o.id, created_at: o.created_at.toISOString(), status: o.status, stage: o.stage, waiting_on: null, next_action_due_date: null, tasks: rows }, new Date().toISOString());
      expect(res.group).toBe(group);
      expect(res.group).not.toBe("ready");
      expect(res.group).not.toBe("other");
    }
  });

  it("tipos de tarefa com operações diferentes no mesmo contato: não cria (ambíguo), nem por ordem de linha", async () => {
    const s = await setup();
    await s.task(s.org, s.contact, "human", s.marina, { type: "return_customer" });
    const a = await s.task(s.org, s.contact, "human", s.marina, { type: "consortium_followup" }); // sozinha já abriria
    expect(await s.opps(s.org, s.contact)).toHaveLength(1);
    const s2 = await setup();
    await s2.db.exec("DROP TRIGGER trg_human_task_opens_opportunity ON public.tasks");
    await s2.task(s2.org, s2.contact, "human", s2.marina, { type: "consortium_followup" });
    await s2.task(s2.org, s2.contact, "human", s2.marina, { type: "vehicle_followup" });
    await s2.db.exec(readFileSync(MIGRATION, "utf8")); // religa o gatilho
    await s2.q("update public.tasks set assignee_type='human' where organization_id=$1", [s2.org]);
    expect(await s2.opps(s2.org, s2.contact)).toHaveLength(0);
    // mesmo tipo repetido não é ambíguo
    const s3 = await setup();
    await s3.db.exec("DROP TRIGGER trg_human_task_opens_opportunity ON public.tasks");
    await s3.task(s3.org, s3.contact, "human", s3.marina, { type: "consortium_followup" });
    await s3.task(s3.org, s3.contact, "human", s3.marina, { type: "consortium_followup" });
    await s3.db.exec(readFileSync(MIGRATION, "utf8"));
    await s3.q("update public.tasks set assignee_type='human' where organization_id=$1", [s3.org]);
    expect(await s3.opps(s3.org, s3.contact)).toHaveLength(1);
    expect(a).toBeTruthy();
  });

  it("migration é idempotente (pode rodar duas vezes) e continua funcionando", async () => {
    const s = await setup();
    await s.db.exec(readFileSync(MIGRATION, "utf8"));
    await s.task(s.org, s.contact, "human", s.marina);
    expect(await s.opps(s.org, s.contact)).toHaveLength(1);
  });
});

describe("backfill", () => {
  async function seed() {
    const s = await setup({ sales_auto_pipeline_enabled: true }, { apply: false });
    const mk = async () => (await s.q("insert into public.wa_contacts(organization_id) values ($1) returning id", [s.org]))[0].id as string;
    const c2 = await mk(), c3 = await mk(), c4 = await mk(), c5 = await mk(), c6 = await mk();
    const t1 = await s.task(s.org, s.contact, "human", s.marina); // mais antiga
    const t1b = await s.task(s.org, s.contact, "human", s.marina);
    await s.task(s.org, c2, "ai", null);
    await s.task(s.org, c3, "human", s.shared, { type: "vehicle_followup" });
    await s.opp(s.org, c4); await s.task(s.org, c4, "human", s.marina); // negócio aberto
    await s.opp(s.org, c5, "lost"); await s.task(s.org, c5, "human", s.marina); // só fechado
    await s.task(s.org, c6, "human", s.marina, { type: "return_customer" }); // operação não inferível
    const c7 = await mk();
    await s.task(s.org, c7, "human", s.marina, { type: "consortium_followup" }); await s.task(s.org, c7, "human", s.marina, { type: "vehicle_followup" }); // ambíguo
    await s.db.exec(readFileSync(MIGRATION, "utf8")); // depois dos dados, como em produção
    return { s, c2, c3, c4, c5, c6, c7, t1, t1b };
  }
  const apply = (sql: string) => sql.replace(/\nROLLBACK;[^\n]*/, "\nCOMMIT;");

  it("termina em ROLLBACK por padrão (não confirma nada sozinho) e o preview cobre todas as linhas", async () => {
    const { s, c3 } = await seed();
    await s.db.exec(readFileSync(BACKFILL, "utf8"));
    expect(await s.opps(s.org, c3)).toHaveLength(0);
    expect(readFileSync(BACKFILL, "utf8")).not.toMatch(/^COMMIT;/m);
  });

  it("com COMMIT: mesma regra do gatilho, um negócio por contato, pula histórico/IA/tipo ambíguo, e reexecutar não duplica", async () => {
    const { s, c2, c3, c4, c5, c6, c7, t1, t1b } = await seed();
    await s.db.exec(apply(readFileSync(BACKFILL, "utf8")));
    const [o] = await s.opps(s.org, s.contact);
    expect(await s.opps(s.org, s.contact)).toHaveLength(1);
    expect(o).toMatchObject({ owner_id: s.marina, stage: "interest_received", status: "open", operation: "consortium" });
    expect(await s.linkOf(t1)).toBe(o.id);
    expect(await s.linkOf(t1b)).toBe(o.id);
    expect(await s.opps(s.org, c2)).toHaveLength(0);
    expect((await s.opps(s.org, c3)).map(x => [x.operation, x.owner_id])).toEqual([["vehicle_sale", null]]);
    expect(await s.opps(s.org, c4)).toHaveLength(1);
    expect((await s.opps(s.org, c5)).map(x => x.status)).toEqual(["lost"]);
    expect(await s.opps(s.org, c6)).toHaveLength(0);
    expect(await s.opps(s.org, c7)).toHaveLength(0);
    await s.db.exec(apply(readFileSync(BACKFILL, "utf8")));
    expect(await s.opps(s.org, s.contact)).toHaveLength(1);
    expect((await s.q("select 1 from public.opportunity_events where new_value->>'source'='human_task_backfill'")).length).toBe(2);
  });

  const reversal = () => {
    const sql = readFileSync(BACKFILL, "utf8");
    const part = sql.slice(sql.indexOf("-- ===== 3) REVERSÃO"));
    return part.split("\n").filter(l => l.startsWith("-- ") && !l.startsWith("-- ====") && !l.startsWith("-- (")).map(l => l.slice(3)).join("\n").replace(/-- confira.*|-- Confira.*/g, "");
  };

  it("reversão: apaga só os negócios do backfill intactos e desliga as tarefas; recusa se foram usados", async () => {
    const { s, c3, t1 } = await seed();
    await s.db.exec(apply(readFileSync(BACKFILL, "utf8")));
    const manual = await s.opp(s.org, (await s.q("insert into public.wa_contacts(organization_id) values ($1) returning id", [s.org]))[0].id);
    const o = (await s.opps(s.org, s.contact))[0];
    await s.q("insert into public.sales_call_logs(opportunity_id) values ($1)", [o.id]);
    await expect(s.db.exec(reversal())).rejects.toThrow(/Reversão recusada/);
    await s.db.exec("ROLLBACK");
    expect(await s.opps(s.org, s.contact)).toHaveLength(1);
    await s.q("delete from public.sales_call_logs");
    await s.db.exec(reversal());
    expect(await s.opps(s.org, s.contact)).toHaveLength(0);
    expect(await s.opps(s.org, c3)).toHaveLength(0);
    expect(await s.linkOf(t1)).toBeNull();
    expect((await s.q("select 1 from public.opportunities where id=$1", [manual])).length).toBe(1);
  });
});
