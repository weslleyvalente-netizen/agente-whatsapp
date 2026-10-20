// Gatilho de tarefa humana convivendo com as funções reais: sync_sales_pipeline, distribute_lead e os gatilhos de dono.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, inMinutes, seedHandoff, seedOrg, seedRep, uuid } from "./harness.js";

const M = (f: string) => new URL(`../../../../supabase/migrations/${f}`, import.meta.url);
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => { db = await createTestDb(); });

const PIPELINE_FIXTURE = `
CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
ALTER TABLE public.conversations ADD COLUMN agent_id uuid;
CREATE TABLE public.agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, tools_config jsonb NOT NULL DEFAULT '{}');
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS evolution_message_id text;
ALTER TABLE public.opportunities ADD COLUMN initial_operation text, ADD COLUMN sale_amount numeric, ADD COLUMN credit_amount numeric, ADD COLUMN down_payment_amount numeric,
  ADD COLUMN bid_amount numeric, ADD COLUMN target_installment_amount numeric, ADD COLUMN term_months integer, ADD COLUMN usage_purpose text, ADD COLUMN urgency text,
  ADD COLUMN commercial_notes text, ADD COLUMN last_interaction_at timestamptz, ADD COLUMN last_progress_at timestamptz, ADD COLUMN next_action text,
  ADD COLUMN frozen_until date, ADD COLUMN waiting_on text, ADD COLUMN next_action_due_date date;
CREATE TABLE public.opportunity_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, opportunity_id uuid, event_type text, previous_value jsonb, new_value jsonb, evidence text, changed_by_type text);
CREATE TABLE public.conversation_qualifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, conversation_id uuid, opportunity_id uuid,
  cpf_encrypted text, birth_date date, has_driver_license boolean, down_payment_amount numeric, product_model text);
ALTER TABLE public.tasks ADD COLUMN conversation_id uuid, ADD COLUMN opportunity_id uuid, ADD COLUMN type text NOT NULL DEFAULT 'other', ADD COLUMN title text, ADD COLUMN description text,
  ADD COLUMN reason text, ADD COLUMN priority text NOT NULL DEFAULT 'normal', ADD COLUMN due_date date, ADD COLUMN due_time time, ADD COLUMN created_by_type text, ADD COLUMN created_by_id uuid,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN consolidated_pendencies jsonb NOT NULL DEFAULT '[]';
CREATE TABLE public.task_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid, organization_id uuid, event_type text, note text, created_by_type text);
ALTER TABLE public.handoff_events ADD COLUMN motivo text, ADD COLUMN resumo text, ADD COLUMN first_human_reply_at timestamptz;
`;
const EXTRA = `
ALTER TABLE public.wa_contacts ADD COLUMN phone text;
CREATE TABLE public.organization_ignored_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, phone text NOT NULL);
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS last_message_at timestamptz; ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

`;

async function setup() {
  await db.exec(PIPELINE_FIXTURE); await db.exec(EXTRA);
  await db.exec(readFileSync(M("20261020120000_owner_on_opportunity_create.sql"), "utf8"));
  await db.exec(readFileSync(M("20261021120000_human_task_opens_opportunity.sql"), "utf8"));
  const def = await uuid(db);
  const org = await seedOrg(db, { sales_auto_pipeline_enabled: true, sales_qualified_handoff_task_enabled: true, lead_distribution_enabled: true });
  await db.query("update public.organizations set settings = settings || jsonb_build_object('default_handoff_assignee_id', $2::text) where id=$1", [org, def]);
  await db.query("insert into auth.users(id) values ($1)", [def]);
  await db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,'admin')", [org, def]);
  return { org, def };
}
const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
async function turn(org: string, h: { conversationId: string; handoffId: string }, operation = "consortium", stage = "qualification") {
  await db.query("update public.handoff_events set motivo='cliente_pediu', resumo='Quer fechar' where id=$1", [h.handoffId]);
  const msg = (await q("insert into public.messages(organization_id,conversation_id,role,content) values ($1,$2,'contact','quero fechar') returning id", [org, h.conversationId]))[0].id;
  return (await q("select public.sync_sales_pipeline($1,$2,$3,null,$4,$5,false,'{}'::jsonb) as id", [org, h.conversationId, msg, operation, stage]))[0].id as string;
}
const humanTask = (org: string, contact: string, user: string, type = "consortium_followup") =>
  q("insert into public.tasks(organization_id,contact_id,assignee_type,assignee_id,type,due_date,created_by_type) values ($1,$2,'human',$3,$4,current_date,'human') returning id", [org, contact, user, type]);

describe("gatilho de tarefa humana x sync_sales_pipeline / distribute_lead", () => {
  it("negócio aberto pelo gatilho com a operação certa: a IA depois avança a etapa e o encaminhamento qualificado cria a tarefa (nada trava)", async () => {
    const { org } = await setup(); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    await humanTask(org, h.contactId, marina.userId);
    const [created] = await q("select id, operation, stage from public.opportunities where contact_id=$1", [h.contactId]);
    expect(created).toMatchObject({ operation: "consortium", stage: "interest_received" });
    const opp = await turn(org, h);
    expect(opp).toBe(created.id);
    expect((await q("select stage from public.opportunities where id=$1", [opp]))[0].stage).toBe("qualification");
    expect(await q("select id from public.opportunities where contact_id=$1", [h.contactId])).toHaveLength(1);
    // a tarefa humana do gatilho já estava ligada ao negócio: o encaminhamento qualificado a consolida (não duplica)
    expect(await q("select id from public.tasks where contact_id=$1", [h.contactId])).toHaveLength(1);
    expect(await q("select 1 from public.task_events where event_type='qualified_handoff'")).toHaveLength(1);
    expect((await q("select waiting_on from public.opportunities where id=$1", [opp]))[0].waiting_on).toBe("team");
  });

  it("negócio criado antes pelo sync_sales_pipeline: tarefa humana depois não cria outro", async () => {
    const { org } = await setup(); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    const opp = await turn(org, h, "financing", "qualification");
    await humanTask(org, h.contactId, marina.userId, "financing_followup");
    const all = await q("select id from public.opportunities where contact_id=$1", [h.contactId]);
    expect(all.map(r => r.id)).toEqual([opp]);
  });

  it("distribute_lead promove tarefas da IA a humanas: roda sem erro e deixa no máximo um negócio por contato", async () => {
    const { org } = await setup(); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    await q("insert into public.tasks(organization_id,contact_id,assignee_type,type,due_date,created_by_type) values ($1,$2,'ai','consortium_followup',current_date,'ai')", [org, h.contactId]);
    await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [org, h.conversationId, h.handoffId, inMinutes(15)]);
    const opps = await q("select id, owner_id, operation from public.opportunities where contact_id=$1", [h.contactId]);
    expect(opps.length).toBeLessThanOrEqual(1);
    expect((await q("select assignee_type from public.tasks where contact_id=$1", [h.contactId]))[0].assignee_type).toBe("human");
  });
});
