// packages/database/src/sql/lead-distribution-sales-pipeline.test.ts
// C3: sync_sales_pipeline não pode devolver ao responsável padrão um lead que a distribuição já entregou a um vendedor.
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, inMinutes, seedHandoff, seedOrg, seedRep, uuid } from "./harness.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => { db = await createTestDb(); });

const distribute = async (org: string, h: { conversationId: string; handoffId: string }) =>
  (await db.query<{ id: string | null }>("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [org, h.conversationId, h.handoffId, inMinutes(15)])).rows[0].id;
const helper = async (org: string, conversationId: string, def: string | null) =>
  (await db.query<{ id: string | null }>("select public._lead_handoff_assignee($1,$2,$3) as id", [org, conversationId, def])).rows[0].id;

describe("_lead_handoff_assignee", () => {
  it("com a flag ligada devolve o usuário do vendedor da atribuição ativa (pendente ou aceita)", async () => {
    const org = await seedOrg(db); const marina = await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const def = await uuid(db);
    const id = (await distribute(org, h))!;
    expect(await helper(org, h.conversationId, def)).toBe(marina.userId);
    await db.query("select public.accept_assignment($1,$2,false)", [id, marina.userId]);
    expect(await helper(org, h.conversationId, def)).toBe(marina.userId);
  });

  it("com exceção em aberto devolve NULL (o lead está na fila do gestor)", async () => {
    const org = await seedOrg(db); const h = await seedHandoff(db, org);
    expect((await db.query<any>("select status from public.lead_assignments where id=$1", [(await distribute(org, h))!])).rows[0].status).toBe("exception");
    expect(await helper(org, h.conversationId, await uuid(db))).toBeNull();
  });

  it("sem nenhuma linha de distribuição para a conversa devolve o padrão", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); const def = await uuid(db);
    expect(await helper(org, h.conversationId, def)).toBe(def);
    expect(await helper(org, h.conversationId, null)).toBeNull();
  });

  it("com a flag desligada devolve sempre o padrão, mesmo havendo atribuição", async () => {
    const org = await seedOrg(db); await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org); await distribute(org, h);
    await db.query("update public.organizations set settings = settings || '{\"lead_distribution_enabled\": false}'::jsonb where id=$1", [org]);
    const def = await uuid(db);
    expect(await helper(org, h.conversationId, def)).toBe(def);
  });
});

// O fixture comum só modela o que a distribuição usa. Aqui estende-se com as colunas/tabelas que sync_sales_pipeline lê,
// para exercitar o bloco do responsável de ponta a ponta (o corpo da função é o de 20261002024809, só o bloco do responsável mudou).
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

describe("sync_sales_pipeline: responsável do encaminhamento qualificado", () => {
  async function setup(settings: Record<string, unknown>) {
    await db.exec(PIPELINE_FIXTURE);
    const def = await uuid(db);
    const org = await seedOrg(db, { sales_auto_pipeline_enabled: true, sales_qualified_handoff_task_enabled: true, ...settings });
    await db.query("update public.organizations set settings = settings || jsonb_build_object('default_handoff_assignee_id', $2::text) where id=$1", [org, def]);
    await db.query("insert into auth.users(id) values ($1)", [def]);
    await db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,'admin')", [org, def]);
    return { org, def };
  }
  async function turn(org: string, h: { conversationId: string; handoffId: string }) {
    await db.query("update public.handoff_events set motivo='cliente_pediu', resumo='Quer fechar' where id=$1", [h.handoffId]);
    const msg = (await db.query<any>("insert into public.messages(organization_id,conversation_id,role,content) values ($1,$2,'contact','quero fechar') returning id", [org, h.conversationId])).rows[0].id;
    return (await db.query<any>("select public.sync_sales_pipeline($1,$2,$3,null,'consortium','qualification',false,'{}'::jsonb) as id", [org, h.conversationId, msg])).rows[0].id as string;
  }
  const tasksOf = async (contactId: string) => (await db.query<any>("select assignee_id, title from public.tasks where contact_id=$1", [contactId])).rows;

  it("flag ligada: a tarefa qualificada e o dono do negócio ficam com o vendedor distribuído", async () => {
    const { org, def } = await setup({ lead_distribution_enabled: true });
    await seedRep(db, org, "Marina", 1); const marcio = await seedRep(db, org, "Márcio", 2);
    await db.query("insert into public.lead_distribution_state(organization_id,last_rotation_order) values ($1,1) on conflict (organization_id) do update set last_rotation_order=1", [org]);
    const h = await seedHandoff(db, org);
    await distribute(org, h); // Márcio
    const opp = await turn(org, h);
    expect(await tasksOf(h.contactId)).toEqual([{ assignee_id: marcio.userId, title: "Atender cliente qualificado" }]);
    expect((await db.query<any>("select owner_id from public.opportunities where id=$1", [opp])).rows[0].owner_id).toBe(marcio.userId);
    expect(def).not.toBe(marcio.userId);
  });

  it("flag ligada com exceção em aberto: não cria tarefa para o responsável padrão", async () => {
    const { org } = await setup({ lead_distribution_enabled: true }); // nenhum vendedor: no_available_rep
    const h = await seedHandoff(db, org);
    await distribute(org, h);
    const opp = await turn(org, h);
    expect(await tasksOf(h.contactId)).toEqual([]);
    expect((await db.query<any>("select owner_id from public.opportunities where id=$1", [opp])).rows[0].owner_id).toBeNull();
  });

  it("flag ligada sem linha de distribuição (handoff antes da ativação): responsável padrão como hoje", async () => {
    const { org, def } = await setup({ lead_distribution_enabled: true });
    await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    await turn(org, h);
    expect(await tasksOf(h.contactId)).toEqual([{ assignee_id: def, title: "Atender cliente qualificado" }]);
  });

  it("flag desligada: idêntico a hoje (responsável padrão), mesmo com atribuição antiga", async () => {
    const { org, def } = await setup({ lead_distribution_enabled: true });
    await seedRep(db, org, "Marina", 1);
    const h = await seedHandoff(db, org);
    await distribute(org, h);
    await db.query("update public.organizations set settings = settings || '{\"lead_distribution_enabled\": false}'::jsonb where id=$1", [org]);
    const opp = await turn(org, h);
    expect(await tasksOf(h.contactId)).toEqual([{ assignee_id: def, title: "Atender cliente qualificado" }]);
    expect((await db.query<any>("select owner_id from public.opportunities where id=$1", [opp])).rows[0].owner_id).toBe(def);
  });
});
