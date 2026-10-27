// Esquema realista (colunas e constraints de produção) para os testes do cartão de encaminhamento e da escalada de SLA.
// Aplica, na ordem real, as migrações que convivem: distribuição, pipeline, congelamento, gatilhos de dono e de tarefa humana.
import { readFileSync } from "node:fs";
import { createTestDb, seedOrg, seedRep, uuid } from "./harness.js";

export const M = (f: string) => new URL(`../../../../supabase/migrations/${f}`, import.meta.url);

const PIPELINE_FIXTURE = `
CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
ALTER TABLE public.conversations ADD COLUMN agent_id uuid;
CREATE TABLE public.agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, tools_config jsonb NOT NULL DEFAULT '{}');
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS evolution_message_id text;
ALTER TABLE public.opportunities ADD COLUMN initial_operation text, ADD COLUMN sale_amount numeric, ADD COLUMN credit_amount numeric, ADD COLUMN down_payment_amount numeric,
  ADD COLUMN bid_amount numeric, ADD COLUMN target_installment_amount numeric, ADD COLUMN term_months integer, ADD COLUMN usage_purpose text, ADD COLUMN urgency text,
  ADD COLUMN commercial_notes text, ADD COLUMN last_interaction_at timestamptz, ADD COLUMN last_progress_at timestamptz, ADD COLUMN next_action text,
  ADD COLUMN waiting_on text, ADD COLUMN next_action_due_date date, ADD COLUMN waiting_on_until date,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE public.opportunities ALTER COLUMN operation SET NOT NULL, ALTER COLUMN initial_operation SET NOT NULL,
  ADD CONSTRAINT opp_operation_chk CHECK (operation IN ('vehicle_sale','consortium','financing','libera_cred','contemplated_letter')),
  ADD CONSTRAINT opp_status_chk CHECK (status IN ('open','won','lost'));
CREATE TABLE public.opportunity_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, opportunity_id uuid, event_type text NOT NULL, previous_value jsonb, new_value jsonb,
  evidence text NOT NULL, changed_by_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT oe_type_chk CHECK (event_type IN ('created','stage_changed','operation_changed','won','lost','reopened','owner_changed','next_action_updated','waiting_on_changed')),
  CONSTRAINT oe_by_chk CHECK (changed_by_type IN ('ai','human','system')));
CREATE TABLE public.conversation_qualifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, conversation_id uuid, opportunity_id uuid,
  cpf_encrypted text, birth_date date, has_driver_license boolean, down_payment_amount numeric, product_model text, product_interest text);
ALTER TABLE public.tasks ADD COLUMN conversation_id uuid, ADD COLUMN opportunity_id uuid, ADD COLUMN type text NOT NULL DEFAULT 'other', ADD COLUMN title text, ADD COLUMN description text,
  ADD COLUMN reason text, ADD COLUMN priority text NOT NULL DEFAULT 'normal', ADD COLUMN due_date date, ADD COLUMN due_time time, ADD COLUMN created_by_type text, ADD COLUMN created_by_id uuid,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN consolidated_pendencies jsonb NOT NULL DEFAULT '[]',
  ADD CONSTRAINT tasks_status_chk CHECK (status IN ('pending','in_progress','completed','cancelled','rescheduled'));
CREATE TABLE public.task_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid, organization_id uuid, event_type text, note text, created_by_type text NOT NULL CHECK (created_by_type IN ('ai','human')), created_by_id uuid);
ALTER TABLE public.handoff_events ADD COLUMN motivo text, ADD COLUMN resumo text, ADD COLUMN first_human_reply_at timestamptz;
ALTER TABLE public.wa_contacts ADD COLUMN phone text;
ALTER TABLE public.conversations ADD COLUMN status text NOT NULL DEFAULT 'open', ADD COLUMN last_message_at timestamptz, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.opportunity_events ADD COLUMN changed_by_id uuid;
CREATE TABLE public.sales_call_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, opportunity_id uuid NOT NULL REFERENCES public.opportunities(id) ON DELETE CASCADE, contact_id uuid, called_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.organization_ignored_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, phone text NOT NULL);
`;

export type Db = Awaited<ReturnType<typeof createTestDb>>;

/** Migrações novas (opcionais: só entram quando existem) na ordem em que serão aplicadas em produção. */
export const NEW_MIGRATIONS = [
  "20261027120000_handoff_card.sql",
  "20261027120100_default_operation_sync.sql",
  "20261027120200_sla_alert_escalation.sql",
];

export async function setupHandoffDb(opts: { apply?: string[] } = {}) {
  const db = await createTestDb();
  await db.exec(PIPELINE_FIXTURE);
  // só colunas de congelamento + refresh_freeze_task (linhas 1-31) do arquivo original; o corpo antigo do sync vem da migração de distribuição
  await db.exec(readFileSync(M("20261001194818_sales_opportunity_freeze.sql"), "utf8").split("\n").slice(0, 31).join("\n"));
  for (const f of ["20261013120000_freeze_no_flag_gate.sql", "20261015120000_sync_owner_on_conversation_assign.sql", "20261020120000_owner_on_opportunity_create.sql",
    "20261021120000_human_task_opens_opportunity.sql", ...(opts.apply ?? NEW_MIGRATIONS)]) {
    try { await db.exec(readFileSync(M(f), "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
  return { db, q };
}

export const ALL_ON = { lead_distribution_enabled: true, sales_auto_pipeline_enabled: true, sales_qualified_handoff_task_enabled: true };

/** Organização com a conta compartilhada ("def", como a Helena) e vendedores Marina(1), Márcio(2) e Paulo(3) opcionais. */
export async function seedWorld(db: Db, settings: Record<string, unknown> = ALL_ON, reps: Array<[string, number, string?]> = [["Marina", 1], ["Márcio", 2]]) {
  const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
  const org = await seedOrg(db, settings);
  const def = await uuid(db);
  await q("insert into auth.users(id) values ($1)", [def]);
  await q("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,'admin')", [org, def]);
  const r: Record<string, { repId: string; userId: string }> = {};
  for (const [name, order, availability] of reps) { r[name] = await seedRep(db, org, name, order, availability ?? "available"); await q("insert into auth.users(id) values ($1)", [r[name].userId]); }
  return { org, def, reps: r };
}

/** Contato + conversa + handoff (request_human) já com telefone. */
export async function seedLead(db: Db, org: string, opts: { phone?: string; handedAt?: string; assignedTo?: string | null } = {}) {
  const q = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
  const contactId = (await q("insert into public.wa_contacts(organization_id,phone) values ($1,$2) returning id", [org, opts.phone ?? `55119${Math.floor(Math.random() * 1e8)}`]))[0].id as string;
  const conversationId = (await q("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3) returning id", [org, contactId, opts.assignedTo ?? null]))[0].id as string;
  const handoffId = (await q("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,$3) returning id", [org, conversationId, opts.handedAt ?? new Date().toISOString()]))[0].id as string;
  return { contactId, conversationId, handoffId };
}
