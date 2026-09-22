# Oportunidades Comerciais — Fase 1 (Fundação) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a entidade `opportunities` nativa no `aula-agente` (schema, service, rotas), uma tela de Funil de vendas por operação (Kanban), criação/edição manual de oportunidade com responsável e próxima ação, vínculo manual de tarefa existente a uma oportunidade, e dedup de tarefas revisada por `(opportunity_id, type)` — sem nenhuma automação nova e sem tocar no CRM standalone.

**Architecture:** Segue exatamente os padrões já estabelecidos por `tasks`/`task_events`/`conversation_qualifications` neste mesmo repositório: migration → tipos/schemas em `packages/shared` → queries em `packages/database` → service + rotas Fastify em `apps/api` (mutações passam sempre pela API, nunca escritas diretas do client pra `opportunities`, porque é lá que a evidência obrigatória é aplicada) → leitura direta via Supabase client no `apps/web` (RLS já cobre) para listagens, mutação via `apiFetch`.

**Tech Stack:** Next.js (App Router), Fastify (`apps/api`), Supabase/Postgres, zod, `@dnd-kit/core` (novo em `apps/web`, mesma versão já usada em outras explorações deste projeto: `^6.3.1`).

**Spec:** [`specs/2026-09-22-oportunidades-comerciais-design.md`](../specs/2026-09-22-oportunidades-comerciais-design.md) (seções 1, 2, 4, 9 "Fase 1")

## Global Constraints

- Nenhuma automação nova nesta fase (matriz da spec, itens #1, #2, #5, #6, #11, #12 ficam para as Fases 2-4). Nenhum worker novo, nenhuma tool nova pra Helena.
- Nenhuma migração de dados do CRM standalone (`assistente-mt`), nenhuma mudança em `crm-sync.ts`.
- Mudar `stage`, `operation`, `status` (won/lost) de uma oportunidade **exige** `evidence` não vazio, gravado em `opportunity_events` — regra de negócio, aplicada no service, nunca contornável pela UI.
- `stage` não tem `CHECK` no banco (5 funis com estágios diferentes) — validado no zod schema contra `FUNNEL_STAGES[operation]`, mesmo padrão de `tasks.type`.
- RLS de `opportunities`/`opportunity_events` usa o mesmo `get_user_org_ids()` já existente — nenhuma função de RLS nova.
- Responsável (`owner_id`) e próxima ação (`next_action` + `next_action_due_date`) são **obrigatórios na criação manual** de uma oportunidade (decisão da spec, seção 9).
- `apps/web` segue sem framework de teste automatizado (mesma constatação já registrada no plano anterior) — verificação desta fase é manual. `apps/api` e `packages/database` **têm** teste automatizado (`task.service.test.ts` existe) — o service novo (`opportunity.service.ts`) ganha testes unitários no mesmo molde.

## Review Focus

- Mudar `stage`/`operation`/marcar `won`/`lost` sem `evidence` (string vazia ou só espaços) precisa ser rejeitado pelo service com erro claro, não silenciosamente aceito com `evidence: ""`.
- Mudar `operation` precisa resetar `stage` para o primeiro estágio do funil novo — se o `stage` antigo simplesmente for mantido, ele pode não existir na lista do funil novo (ex. `"documentation"` não existe no funil de consórcio).
- Duas oportunidades diferentes do mesmo contato, mesmo `type` de tarefa (`run_quote` em ambas) — a dedup revisada não pode fundir as duas numa só; criar uma tarefa pra cada oportunidade tem que resultar em 2 linhas em `tasks`.
- Uma tarefa comercial sem `opportunity_id` (criada antes desta fase, ou de suporte) precisa continuar funcionando com a dedup antiga `(contact_id, type)` — a mudança é aditiva, não pode quebrar tarefas existentes.
- Criar uma oportunidade sem `owner_id` ou sem `next_action_due_date` precisa ser rejeitado pela validação (zod), não aceito com `null` silenciosamente — é regra de negócio da Fase 1, não só sugestão de UI.

---

## Task 1: Schema — `opportunities`, `opportunity_events`, colunas em `tasks`/`conversation_qualifications`

**Files:**
- Create: `supabase/migrations/00024_opportunities.sql`
- Create: `supabase/migrations/00025_opportunities_rls.sql`

**Interfaces:**
- Consumes: `organizations`, `wa_contacts`, `auth.users`, `get_user_org_ids()` (já existem), `update_updated_at()` (trigger function já existe).
- Produces: tabelas `opportunities`, `opportunity_events`; colunas `tasks.opportunity_id`, `conversation_qualifications.opportunity_id` — consumidas pelas Tasks 2-5.

- [ ] **Step 1: Criar a migration de schema**

Criar `supabase/migrations/00024_opportunities.sql`:

```sql
CREATE TABLE opportunities (
  id                          uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id                  uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,

  operation                   text NOT NULL CHECK (operation IN
                                 ('vehicle_sale', 'consortium', 'financing', 'libera_cred', 'contemplated_letter')),
  stage                       text NOT NULL,
  status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),

  product                     text,
  product_model               text,

  initial_operation           text NOT NULL,

  sale_amount                 numeric,
  credit_amount                numeric,
  down_payment_amount          numeric,
  bid_amount                    numeric,
  target_installment_amount     numeric,
  term_months                   integer,

  usage_purpose                text,
  urgency                       text,
  main_objection                text,
  commercial_notes              text,

  owner_id                      uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  next_action                   text,
  next_action_due_date          date,

  waiting_on                    text CHECK (waiting_on IN ('customer', 'team', 'bank_or_admin', 'scheduled_date')),
  waiting_on_until              date,

  last_interaction_at           timestamptz,
  last_progress_at              timestamptz,

  lost_reason                   text,
  resume_date                   date,

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_opportunities_org_status ON opportunities(organization_id, status);
CREATE INDEX idx_opportunities_contact ON opportunities(contact_id);
CREATE INDEX idx_opportunities_operation_stage ON opportunities(operation, stage);
CREATE INDEX idx_opportunities_owner ON opportunities(owner_id);
CREATE INDEX idx_opportunities_waiting_on ON opportunities(waiting_on) WHERE status = 'open';

CREATE TRIGGER trg_opportunities_updated_at
  BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE opportunity_events (
  id                 uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id     uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  event_type         text NOT NULL CHECK (event_type IN (
                        'created', 'stage_changed', 'operation_changed',
                        'won', 'lost', 'reopened', 'owner_changed',
                        'next_action_updated', 'waiting_on_changed'
                      )),
  previous_value     jsonb,
  new_value          jsonb,
  evidence           text NOT NULL,
  changed_by_type    text NOT NULL CHECK (changed_by_type IN ('ai', 'human', 'system')),
  changed_by_id      uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_opportunity_events_opportunity ON opportunity_events(opportunity_id, created_at);

ALTER TABLE tasks
  ADD COLUMN opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL;

CREATE INDEX idx_tasks_opportunity ON tasks(opportunity_id);

ALTER TABLE conversation_qualifications
  ADD COLUMN opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL;
```

- [ ] **Step 2: Criar a migration de RLS**

Criar `supabase/migrations/00025_opportunities_rls.sql`, mesmo padrão exato de `conversation_qualifications` (`00020`):

```sql
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "opportunities_select" ON opportunities
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "opportunities_insert" ON opportunities
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "opportunities_update" ON opportunities
  FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "opportunities_delete" ON opportunities
  FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()));

CREATE POLICY "opportunity_events_select" ON opportunity_events
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "opportunity_events_insert" ON opportunity_events
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
```

Nota: sem policy de `UPDATE`/`DELETE` em `opportunity_events` de propósito —
é append-only, mesmo espírito de `task_events` (que também não tem essas
duas policies).

- [ ] **Step 3: Aplicar e verificar localmente**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
npx supabase migration list --linked
npx supabase db push --dry-run
```

Ler a saída do `--dry-run` e confirmar que só `00024`/`00025` aparecem como
pendentes (nenhuma outra migration fora de ordem). Só então:

```bash
npx supabase db push
```

Confirmar que as tabelas existem de verdade (não só que o CLI acha que
aplicou — lição já registrada em `docs/operations/deployment.md`):

```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('opportunities', 'opportunity_events');

select column_name from information_schema.columns
where table_name = 'tasks' and column_name = 'opportunity_id';

select column_name from information_schema.columns
where table_name = 'conversation_qualifications' and column_name = 'opportunity_id';
```

- [ ] **Step 4: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
git add supabase/migrations/00024_opportunities.sql supabase/migrations/00025_opportunities_rls.sql
git commit -m "feat(db): add opportunities schema and RLS"
```

---

## Task 2: Tipos, schemas e constantes (`packages/shared`)

**Files:**
- Create: `packages/shared/src/types/opportunity.ts`
- Create: `packages/shared/src/schemas/opportunity.ts`
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/schemas/index.ts`

**Interfaces:**
- Consumes: nenhuma dependência nova.
- Produces: `Operation`, `FUNNEL_STAGES`, `FUNNEL_STAGE_LABELS`, `OPERATION_LABELS`, `OpportunityStatus`, `WaitingOn`, `Product`, `Opportunity`, `OpportunityEvent`, `OpportunityEventType`, `isValidStage()`, `createOpportunitySchema`, `changeOpportunityStageSchema`, `changeOpportunityOperationSchema`, `markOpportunityWonSchema`, `markOpportunityLostSchema`, `updateOpportunitySchema` — consumidos por Tasks 3-5.

- [ ] **Step 1: Adicionar constantes em `packages/shared/src/constants.ts`**

Adicionar ao final do arquivo:

```ts
export const OPERATIONS = [
  "vehicle_sale",
  "consortium",
  "financing",
  "libera_cred",
  "contemplated_letter",
] as const;

export const OPERATION_LABELS: Record<(typeof OPERATIONS)[number], string> = {
  vehicle_sale: "Venda de veículos e elétricos",
  consortium: "Consórcio",
  financing: "Financiamento",
  libera_cred: "Libera Cred",
  contemplated_letter: "Carta contemplada",
};

export const FUNNEL_STAGES: Record<(typeof OPERATIONS)[number], readonly string[]> = {
  vehicle_sale: ["interest_received", "qualification", "proposal_sent", "negotiation", "formalization"],
  consortium: ["interest_received", "qualification", "simulation_sent", "decision_negotiation", "membership"],
  financing: [
    "interest_received",
    "qualification",
    "documentation",
    "bank_analysis",
    "conditions_approved_negotiation",
    "formalization",
  ],
  libera_cred: ["interest_received", "qualification", "plan_term_presented", "decision_objections", "membership"],
  contemplated_letter: [
    "interest_received",
    "qualification",
    "compatible_letter_search",
    "proposal_sent",
    "analysis_transfer",
  ],
};

export const FUNNEL_STAGE_LABELS: Record<string, string> = {
  interest_received: "Interesse recebido",
  qualification: "Qualificação",
  proposal_sent: "Proposta enviada",
  negotiation: "Negociação",
  formalization: "Formalização",
  simulation_sent: "Simulação enviada",
  decision_negotiation: "Decisão/negociação",
  membership: "Adesão",
  documentation: "Documentação",
  bank_analysis: "Análise bancária",
  conditions_approved_negotiation: "Condições aprovadas em negociação",
  plan_term_presented: "Plano e prazo apresentados",
  decision_objections: "Decisão/objeções",
  compatible_letter_search: "Busca de carta compatível",
  analysis_transfer: "Análise/transferência",
};

export const OPPORTUNITY_STATUSES = ["open", "won", "lost"] as const;

export const OPPORTUNITY_STATUS_LABELS: Record<(typeof OPPORTUNITY_STATUSES)[number], string> = {
  open: "Aberto",
  won: "Ganho",
  lost: "Perdido",
};

export const WAITING_ON_OPTIONS = ["customer", "team", "bank_or_admin", "scheduled_date"] as const;

export const WAITING_ON_LABELS: Record<(typeof WAITING_ON_OPTIONS)[number], string> = {
  customer: "Cliente",
  team: "Equipe",
  bank_or_admin: "Banco/administradora",
  scheduled_date: "Data combinada",
};

export const PRODUCTS = ["car", "motorcycle", "real_estate", "e_bike"] as const;

export const PRODUCT_LABELS: Record<(typeof PRODUCTS)[number], string> = {
  car: "Carro",
  motorcycle: "Moto",
  real_estate: "Imóvel",
  e_bike: "Bike elétrica",
};

export function isValidStage(operation: (typeof OPERATIONS)[number], stage: string): boolean {
  return (FUNNEL_STAGES[operation] as readonly string[]).includes(stage);
}
```

- [ ] **Step 2: Criar `packages/shared/src/types/opportunity.ts`**

```ts
import { OPERATIONS, OPPORTUNITY_STATUSES, WAITING_ON_OPTIONS, PRODUCTS } from "../constants.js";

export type Operation = (typeof OPERATIONS)[number];
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
export type WaitingOn = (typeof WAITING_ON_OPTIONS)[number];
export type Product = (typeof PRODUCTS)[number];

export interface Opportunity {
  id: string;
  organization_id: string;
  contact_id: string;
  operation: Operation;
  stage: string;
  status: OpportunityStatus;
  product: Product | null;
  product_model: string | null;
  initial_operation: Operation;
  sale_amount: number | null;
  credit_amount: number | null;
  down_payment_amount: number | null;
  bid_amount: number | null;
  target_installment_amount: number | null;
  term_months: number | null;
  usage_purpose: string | null;
  urgency: string | null;
  main_objection: string | null;
  commercial_notes: string | null;
  owner_id: string | null;
  next_action: string | null;
  next_action_due_date: string | null;
  waiting_on: WaitingOn | null;
  waiting_on_until: string | null;
  last_interaction_at: string | null;
  last_progress_at: string | null;
  lost_reason: string | null;
  resume_date: string | null;
  created_at: string;
  updated_at: string;
}

export type OpportunityEventType =
  | "created"
  | "stage_changed"
  | "operation_changed"
  | "won"
  | "lost"
  | "reopened"
  | "owner_changed"
  | "next_action_updated"
  | "waiting_on_changed";

export type OpportunityEventActorType = "ai" | "human" | "system";

export interface OpportunityEvent {
  id: string;
  organization_id: string;
  opportunity_id: string;
  event_type: OpportunityEventType;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  evidence: string;
  changed_by_type: OpportunityEventActorType;
  changed_by_id: string | null;
  created_at: string;
}
```

- [ ] **Step 3: Criar `packages/shared/src/schemas/opportunity.ts`**

```ts
import { z } from "zod";
import { OPERATIONS, WAITING_ON_OPTIONS, PRODUCTS } from "../constants.js";

const evidenceSchema = z.string().trim().min(1, "Evidência é obrigatória");
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data deve estar no formato YYYY-MM-DD");

export const createOpportunitySchema = z.object({
  contact_id: z.string().uuid(),
  operation: z.enum(OPERATIONS),
  stage: z.string().min(1),
  product: z.enum(PRODUCTS).nullable().optional(),
  product_model: z.string().max(200).nullable().optional(),
  owner_id: z.string().uuid(),
  next_action: z.string().min(1, "Próxima ação é obrigatória"),
  next_action_due_date: dateSchema,
  sale_amount: z.coerce.number().nonnegative().nullable().optional(),
  credit_amount: z.coerce.number().nonnegative().nullable().optional(),
  down_payment_amount: z.coerce.number().nonnegative().nullable().optional(),
  bid_amount: z.coerce.number().nonnegative().nullable().optional(),
  target_installment_amount: z.coerce.number().nonnegative().nullable().optional(),
  term_months: z.coerce.number().int().positive().nullable().optional(),
  usage_purpose: z.string().max(500).nullable().optional(),
  urgency: z.string().max(200).nullable().optional(),
  main_objection: z.string().max(1000).nullable().optional(),
  commercial_notes: z.string().max(5000).nullable().optional(),
});

export const updateOpportunitySchema = z.object({
  owner_id: z.string().uuid().nullable().optional(),
  next_action: z.string().nullable().optional(),
  next_action_due_date: dateSchema.nullable().optional(),
  waiting_on: z.enum(WAITING_ON_OPTIONS).nullable().optional(),
  waiting_on_until: dateSchema.nullable().optional(),
  product: z.enum(PRODUCTS).nullable().optional(),
  product_model: z.string().max(200).nullable().optional(),
  sale_amount: z.coerce.number().nonnegative().nullable().optional(),
  credit_amount: z.coerce.number().nonnegative().nullable().optional(),
  down_payment_amount: z.coerce.number().nonnegative().nullable().optional(),
  bid_amount: z.coerce.number().nonnegative().nullable().optional(),
  target_installment_amount: z.coerce.number().nonnegative().nullable().optional(),
  term_months: z.coerce.number().int().positive().nullable().optional(),
  usage_purpose: z.string().max(500).nullable().optional(),
  urgency: z.string().max(200).nullable().optional(),
  main_objection: z.string().max(1000).nullable().optional(),
  commercial_notes: z.string().max(5000).nullable().optional(),
});

export const changeOpportunityStageSchema = z.object({
  stage: z.string().min(1),
  evidence: evidenceSchema,
});

export const changeOpportunityOperationSchema = z.object({
  operation: z.enum(OPERATIONS),
  evidence: evidenceSchema,
});

export const markOpportunityWonSchema = z.object({
  evidence: evidenceSchema,
});

export const markOpportunityLostSchema = z.object({
  evidence: evidenceSchema,
  lost_reason: z.string().min(1, "Motivo da perda é obrigatório"),
  resume_date: dateSchema.nullable().optional(),
});
```

- [ ] **Step 4: Registrar os exports novos**

Em `packages/shared/src/types/index.ts`, adicionar:

```ts
export * from "./opportunity.js";
```

Em `packages/shared/src/schemas/index.ts`, adicionar:

```ts
export * from "./opportunity.js";
```

- [ ] **Step 5: Verificar**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
pnpm --filter @aula-agente/shared build
pnpm --filter @aula-agente/shared typecheck
```

Ambos precisam terminar sem erro.

- [ ] **Step 6: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
git add packages/shared/src/types/opportunity.ts packages/shared/src/schemas/opportunity.ts \
  packages/shared/src/constants.ts packages/shared/src/types/index.ts packages/shared/src/schemas/index.ts
git commit -m "feat(shared): add opportunity types, schemas and funnel constants"
```

---

## Task 3: Queries, service e rotas (`packages/database` + `apps/api`)

**Files:**
- Create: `packages/database/src/queries/opportunities.ts`
- Modify: `packages/database/src/queries/index.ts`
- Create: `apps/api/src/services/opportunity.service.ts`
- Create: `apps/api/src/services/opportunity.service.test.ts`
- Create: `apps/api/src/routes/opportunities/index.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `Opportunity`, `OpportunityEvent`, `Operation`, `isValidStage`, `FUNNEL_STAGES` (Task 2). `getAdminClient` (já existe, mesmo padrão de `queries/tasks.ts`).
- Produces: `createOpportunity`, `updateOpportunity`, `getOpportunityById`, `getOpportunitiesByOrganization`, `addOpportunityEvent`, `getOpportunityEvents` (queries) — consumidas por Task 4. Rotas HTTP `/organizations/:id/opportunities`, `/opportunities/:id`, `/opportunities/:id/stage`, `/opportunities/:id/operation`, `/opportunities/:id/won`, `/opportunities/:id/lost` — consumidas por Task 5.

- [ ] **Step 1: Criar as queries**

Criar `packages/database/src/queries/opportunities.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Opportunity, OpportunityEvent } from "@aula-agente/shared";

export async function createOpportunity(
  client: SupabaseClient,
  opportunity: Omit<Opportunity, "id" | "created_at" | "updated_at">
) {
  const { data, error } = await client.from("opportunities").insert(opportunity).select().single();
  if (error) throw error;
  return data as Opportunity;
}

export async function updateOpportunity(client: SupabaseClient, id: string, updates: Partial<Opportunity>) {
  const { data, error } = await client.from("opportunities").update(updates).eq("id", id).select().single();
  if (error) throw error;
  return data as Opportunity;
}

export async function getOpportunityById(client: SupabaseClient, id: string) {
  const { data, error } = await client.from("opportunities").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Opportunity;
}

export async function getOpportunitiesByOrganization(
  client: SupabaseClient,
  organizationId: string,
  filters: { operation?: string; status?: string } = {}
) {
  let query = client.from("opportunities").select("*").eq("organization_id", organizationId);
  if (filters.operation) query = query.eq("operation", filters.operation);
  if (filters.status) query = query.eq("status", filters.status);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return data as Opportunity[];
}

export async function addOpportunityEvent(
  client: SupabaseClient,
  event: Omit<OpportunityEvent, "id" | "created_at">
) {
  const { data, error } = await client.from("opportunity_events").insert(event).select().single();
  if (error) throw error;
  return data as OpportunityEvent;
}

export async function getOpportunityEvents(client: SupabaseClient, opportunityId: string) {
  const { data, error } = await client
    .from("opportunity_events")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as OpportunityEvent[];
}
```

- [ ] **Step 2: Registrar o export**

Em `packages/database/src/queries/index.ts`, adicionar:

```ts
export * from "./opportunities.js";
```

- [ ] **Step 3: Criar o service**

Criar `apps/api/src/services/opportunity.service.ts`:

```ts
import type { SupabaseClient } from "@aula-agente/database";
import { createOpportunity, updateOpportunity, addOpportunityEvent } from "@aula-agente/database";
import { isValidStage, FUNNEL_STAGES } from "@aula-agente/shared";
import type { Opportunity, Operation, OpportunityEventActorType } from "@aula-agente/shared";

interface Actor {
  type: OpportunityEventActorType;
  id: string | null;
}

export async function changeStage(
  db: SupabaseClient,
  opportunityId: string,
  newStage: string,
  evidence: string,
  actor: Actor
): Promise<Opportunity> {
  const current = await db.from("opportunities").select("*").eq("id", opportunityId).single();
  if (current.error) throw current.error;
  const opportunity = current.data as Opportunity;

  if (!isValidStage(opportunity.operation, newStage)) {
    throw new Error(`Estágio "${newStage}" não existe no funil "${opportunity.operation}"`);
  }

  const updated = await updateOpportunity(db, opportunityId, {
    stage: newStage,
    last_progress_at: new Date().toISOString(),
  });

  await addOpportunityEvent(db, {
    organization_id: opportunity.organization_id,
    opportunity_id: opportunityId,
    event_type: "stage_changed",
    previous_value: { stage: opportunity.stage },
    new_value: { stage: newStage },
    evidence,
    changed_by_type: actor.type,
    changed_by_id: actor.id,
  });

  return updated;
}

export async function changeOperation(
  db: SupabaseClient,
  opportunityId: string,
  newOperation: Operation,
  evidence: string,
  actor: Actor
): Promise<Opportunity> {
  const current = await db.from("opportunities").select("*").eq("id", opportunityId).single();
  if (current.error) throw current.error;
  const opportunity = current.data as Opportunity;

  // Trocar de funil torna o estágio antigo inválido no funil novo — sempre
  // reinicia no primeiro estágio do funil de destino, nunca mantém o valor
  // antigo por engano.
  const newStage = FUNNEL_STAGES[newOperation][0];

  const updated = await updateOpportunity(db, opportunityId, {
    operation: newOperation,
    stage: newStage,
    last_progress_at: new Date().toISOString(),
  });

  await addOpportunityEvent(db, {
    organization_id: opportunity.organization_id,
    opportunity_id: opportunityId,
    event_type: "operation_changed",
    previous_value: { operation: opportunity.operation, stage: opportunity.stage },
    new_value: { operation: newOperation, stage: newStage },
    evidence,
    changed_by_type: actor.type,
    changed_by_id: actor.id,
  });

  return updated;
}

export async function markWon(
  db: SupabaseClient,
  opportunityId: string,
  evidence: string,
  actor: Actor
): Promise<Opportunity> {
  const current = await db.from("opportunities").select("*").eq("id", opportunityId).single();
  if (current.error) throw current.error;
  const opportunity = current.data as Opportunity;

  const updated = await updateOpportunity(db, opportunityId, {
    status: "won",
    last_progress_at: new Date().toISOString(),
  });

  await addOpportunityEvent(db, {
    organization_id: opportunity.organization_id,
    opportunity_id: opportunityId,
    event_type: "won",
    previous_value: { status: opportunity.status },
    new_value: { status: "won" },
    evidence,
    changed_by_type: actor.type,
    changed_by_id: actor.id,
  });

  return updated;
}

export async function markLost(
  db: SupabaseClient,
  opportunityId: string,
  evidence: string,
  lostReason: string,
  resumeDate: string | null,
  actor: Actor
): Promise<Opportunity> {
  const current = await db.from("opportunities").select("*").eq("id", opportunityId).single();
  if (current.error) throw current.error;
  const opportunity = current.data as Opportunity;

  const updated = await updateOpportunity(db, opportunityId, {
    status: "lost",
    lost_reason: lostReason,
    resume_date: resumeDate,
    last_progress_at: new Date().toISOString(),
  });

  await addOpportunityEvent(db, {
    organization_id: opportunity.organization_id,
    opportunity_id: opportunityId,
    event_type: "lost",
    previous_value: { status: opportunity.status },
    new_value: { status: "lost", lost_reason: lostReason, resume_date: resumeDate },
    evidence,
    changed_by_type: actor.type,
    changed_by_id: actor.id,
  });

  return updated;
}

export interface UpdateOpportunityFieldsInput {
  owner_id?: string | null;
  next_action?: string | null;
  next_action_due_date?: string | null;
  waiting_on?: string | null;
  waiting_on_until?: string | null;
  product?: string | null;
  product_model?: string | null;
  sale_amount?: number | null;
  credit_amount?: number | null;
  down_payment_amount?: number | null;
  bid_amount?: number | null;
  target_installment_amount?: number | null;
  term_months?: number | null;
  usage_purpose?: string | null;
  urgency?: string | null;
  main_objection?: string | null;
  commercial_notes?: string | null;
}

// Campos livres, sem exigência de evidência — só stage/operation/won/lost
// (mudanças de resultado comercial) exigem evidência, conforme a spec.
export async function updateOpportunityFields(
  db: SupabaseClient,
  opportunityId: string,
  updates: UpdateOpportunityFieldsInput
): Promise<Opportunity> {
  return updateOpportunity(db, opportunityId, updates);
}
```

- [ ] **Step 4: Testes unitários do service**

Criar `apps/api/src/services/opportunity.service.test.ts`, no molde de
`task.service.test.ts` (ler esse arquivo primeiro para confirmar o padrão
exato de mock do Supabase client usado neste repositório antes de escrever
os testes — o service acima usa `db.from("opportunities").select("*")...`
diretamente, então o mock precisa cobrir essa chamada além das já
existentes em `createOpportunity`/`updateOpportunity`/`addOpportunityEvent`).
Casos mínimos a cobrir:

- `changeStage` com `newStage` fora de `FUNNEL_STAGES[operation]` lança erro
  e **não** chama `updateOpportunity`/`addOpportunityEvent`.
- `changeStage` bem-sucedido grava `opportunity_events` com
  `event_type: "stage_changed"` e o `evidence` recebido.
- `changeOperation` reseta `stage` para `FUNNEL_STAGES[newOperation][0]`,
  não mantém o `stage` antigo.
- `markWon`/`markLost` gravam `event_type` correto; `markLost` grava
  `lost_reason`/`resume_date` em `new_value`.

- [ ] **Step 5: Criar as rotas**

Criar `apps/api/src/routes/opportunities/index.ts`, seguindo exatamente o
padrão de checagem de `membership` de `routes/tasks/index.ts`:

```ts
import type { FastifyInstance } from "fastify";
import {
  createOpportunitySchema,
  updateOpportunitySchema,
  changeOpportunityStageSchema,
  changeOpportunityOperationSchema,
  markOpportunityWonSchema,
  markOpportunityLostSchema,
} from "@aula-agente/shared";
import {
  getAdminClient,
  createOpportunity,
  getOpportunityById,
  getOpportunitiesByOrganization,
  addOpportunityEvent,
} from "@aula-agente/database";
import {
  changeStage,
  changeOperation,
  markWon,
  markLost,
  updateOpportunityFields,
} from "../../services/opportunity.service.js";
import { authMiddleware } from "../../middleware/auth.js";

export default async function opportunityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { organizationId: string }; Querystring: { operation?: string; status?: string } }>(
    "/organizations/:organizationId/opportunities",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const db = getAdminClient();
      return getOpportunitiesByOrganization(db, organizationId, request.query);
    }
  );

  app.post<{ Params: { organizationId: string } }>(
    "/organizations/:organizationId/opportunities",
    async (request, reply) => {
      const { organizationId } = request.params;
      const membership = request.user.memberships.find((m) => m.organization_id === organizationId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const parseResult = createOpportunitySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();

      const { data: contact } = await db
        .from("wa_contacts")
        .select("id")
        .eq("id", parseResult.data.contact_id)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!contact) {
        return reply.status(403).send({ error: "Contact does not belong to this organization" });
      }

      const opportunity = await createOpportunity(db, {
        organization_id: organizationId,
        contact_id: parseResult.data.contact_id,
        operation: parseResult.data.operation,
        stage: parseResult.data.stage,
        status: "open",
        product: parseResult.data.product ?? null,
        product_model: parseResult.data.product_model ?? null,
        initial_operation: parseResult.data.operation,
        sale_amount: parseResult.data.sale_amount ?? null,
        credit_amount: parseResult.data.credit_amount ?? null,
        down_payment_amount: parseResult.data.down_payment_amount ?? null,
        bid_amount: parseResult.data.bid_amount ?? null,
        target_installment_amount: parseResult.data.target_installment_amount ?? null,
        term_months: parseResult.data.term_months ?? null,
        usage_purpose: parseResult.data.usage_purpose ?? null,
        urgency: parseResult.data.urgency ?? null,
        main_objection: parseResult.data.main_objection ?? null,
        commercial_notes: parseResult.data.commercial_notes ?? null,
        owner_id: parseResult.data.owner_id,
        next_action: parseResult.data.next_action,
        next_action_due_date: parseResult.data.next_action_due_date,
        waiting_on: null,
        waiting_on_until: null,
        last_interaction_at: null,
        last_progress_at: new Date().toISOString(),
        lost_reason: null,
        resume_date: null,
      });

      await addOpportunityEvent(db, {
        organization_id: organizationId,
        opportunity_id: opportunity.id,
        event_type: "created",
        previous_value: null,
        new_value: { operation: opportunity.operation, stage: opportunity.stage },
        evidence: "Oportunidade criada manualmente",
        changed_by_type: "human",
        changed_by_id: request.user.id,
      });

      return reply.status(201).send(opportunity);
    }
  );

  app.patch<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId", async (request, reply) => {
    const parseResult = updateOpportunitySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getOpportunityById(db, request.params.opportunityId);
    const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return updateOpportunityFields(db, request.params.opportunityId, parseResult.data);
  });

  app.post<{ Params: { opportunityId: string } }>(
    "/opportunities/:opportunityId/stage",
    async (request, reply) => {
      const parseResult = changeOpportunityStageSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();
      const existing = await getOpportunityById(db, request.params.opportunityId);
      const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      try {
        const opportunity = await changeStage(
          db,
          request.params.opportunityId,
          parseResult.data.stage,
          parseResult.data.evidence,
          { type: "human", id: request.user.id }
        );
        return opportunity;
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Params: { opportunityId: string } }>(
    "/opportunities/:opportunityId/operation",
    async (request, reply) => {
      const parseResult = changeOpportunityOperationSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: parseResult.error.issues });
      }

      const db = getAdminClient();
      const existing = await getOpportunityById(db, request.params.opportunityId);
      const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      return changeOperation(db, request.params.opportunityId, parseResult.data.operation, parseResult.data.evidence, {
        type: "human",
        id: request.user.id,
      });
    }
  );

  app.post<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId/won", async (request, reply) => {
    const parseResult = markOpportunityWonSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getOpportunityById(db, request.params.opportunityId);
    const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return markWon(db, request.params.opportunityId, parseResult.data.evidence, { type: "human", id: request.user.id });
  });

  app.post<{ Params: { opportunityId: string } }>("/opportunities/:opportunityId/lost", async (request, reply) => {
    const parseResult = markOpportunityLostSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const existing = await getOpportunityById(db, request.params.opportunityId);
    const membership = request.user.memberships.find((m) => m.organization_id === existing.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return markLost(
      db,
      request.params.opportunityId,
      parseResult.data.evidence,
      parseResult.data.lost_reason,
      parseResult.data.resume_date ?? null,
      { type: "human", id: request.user.id }
    );
  });
}
```

- [ ] **Step 6: Registrar a rota em `server.ts`**

Abrir `apps/api/src/server.ts`, encontrar a linha
`import taskRoutes from "./routes/tasks/index.js";` e o `app.register(taskRoutes)`
correspondente (procurar por `register(taskRoutes`). Adicionar, no mesmo
padrão:

```ts
import opportunityRoutes from "./routes/opportunities/index.js";
```

e, junto do `app.register(taskRoutes)` existente:

```ts
app.register(opportunityRoutes);
```

- [ ] **Step 7: Verificar**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
pnpm --filter @aula-agente/database build
pnpm --filter @aula-agente/api typecheck
pnpm --filter @aula-agente/api test -- opportunity.service
```

Os três precisam passar. O teste roda só o arquivo novo (`-- opportunity.service`
filtra pelo nome, mesmo runner já usado no projeto — confirmar a flag exata
olhando como `task.service.test.ts` é rodado hoje, ex. `pnpm --filter @aula-agente/api test`
sem filtro se o projeto não usa filtro de nome).

- [ ] **Step 8: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
git add packages/database/src/queries/opportunities.ts packages/database/src/queries/index.ts \
  apps/api/src/services/opportunity.service.ts apps/api/src/services/opportunity.service.test.ts \
  apps/api/src/routes/opportunities/index.ts apps/api/src/server.ts
git commit -m "feat(api): add opportunities service and routes"
```

---

## Task 4: Dedup de tarefas por oportunidade

**Files:**
- Modify: `packages/database/src/queries/tasks.ts`
- Modify: `packages/shared/src/schemas/task.ts`
- Modify: `apps/api/src/routes/tasks/index.ts`

**Interfaces:**
- Consumes: `Task.opportunity_id` (coluna já existe desde Task 1, mas o tipo `Task` em `packages/shared/src/types/task.ts` ainda não tem o campo — este task adiciona).
- Produces: `getOpenTaskByOpportunityAndType`, `createTaskWithDedup` aceitando `opportunity_id` — consumido por Task 5 (vínculo manual de tarefa) e pelas automações das Fases 2-4 (fora deste plano).

- [ ] **Step 1: Adicionar `opportunity_id` ao tipo `Task`**

Em `packages/shared/src/types/task.ts`, no `interface Task`, adicionar
depois de `conversation_id`:

```ts
  opportunity_id: string | null;
```

- [ ] **Step 2: Adicionar `opportunity_id` ao schema de criação/edição de tarefa**

Em `packages/shared/src/schemas/task.ts`, `createTaskSchema` e
`updateTaskSchema` ganham, cada um:

```ts
    opportunity_id: z.string().uuid().nullable().optional(),
```

(no mesmo bloco de campos opcionais de `conversation_id`).

- [ ] **Step 3: Query de dedup por oportunidade**

Em `packages/database/src/queries/tasks.ts`, adicionar depois de
`getOpenTaskByContactAndType`:

```ts
export async function getOpenTaskByOpportunityAndType(
  client: SupabaseClient,
  organizationId: string,
  opportunityId: string,
  type: TaskType
) {
  const { data, error } = await client
    .from("tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("opportunity_id", opportunityId)
    .eq("type", type)
    .in("status", OPEN_TASK_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Task | null;
}
```

- [ ] **Step 4: `createTaskWithDedup` fica ciente de oportunidade**

Em `packages/database/src/queries/tasks.ts`, `CreateTaskWithDedupInput`
ganha:

```ts
  opportunity_id?: string | null;
```

E o início de `createTaskWithDedup` passa a escolher a chave de dedup
certa — trocar a chamada de `getOpenTaskByContactAndType`:

```ts
export async function createTaskWithDedup(
  client: SupabaseClient,
  input: CreateTaskWithDedupInput
): Promise<{ task: Task; wasUpdated: boolean }> {
  const existing = input.opportunity_id
    ? await getOpenTaskByOpportunityAndType(client, input.organization_id, input.opportunity_id, input.type)
    : await getOpenTaskByContactAndType(client, input.organization_id, input.contact_id, input.type);
  const decision = resolveTaskDedupAction(existing, {
    due_date: input.due_date,
    description: input.description,
    reason: input.reason,
  });
```

(resto da função sem mudança até o `createTask(client, {...})`, que ganha
`opportunity_id: input.opportunity_id ?? null,` no objeto passado).

Nota (Review Focus — tarefa sem oportunidade continua funcionando): quando
`input.opportunity_id` é `undefined`/`null` (tarefa de suporte, ou tarefa
comercial criada antes desta fase), o `? :` cai no branch antigo
`getOpenTaskByContactAndType` — comportamento idêntico ao que já existe
hoje, não muda para nenhuma tarefa existente.

- [ ] **Step 5: Rota de criação de tarefa aceita `opportunity_id`**

Em `apps/api/src/routes/tasks/index.ts`, na rota
`POST /organizations/:organizationId/tasks`, adicionar a validação de posse
(mesmo padrão já usado para `conversation_id`) antes da chamada de
`createTaskWithDedup`:

```ts
      if (parseResult.data.opportunity_id) {
        const { data: opp } = await db
          .from("opportunities")
          .select("id")
          .eq("id", parseResult.data.opportunity_id)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!opp) {
          return reply.status(403).send({ error: "Opportunity does not belong to this organization" });
        }
      }
```

E adicionar `opportunity_id: parseResult.data.opportunity_id ?? null,` no
objeto passado para `createTaskWithDedup`.

Na rota `PATCH /tasks/:taskId`, adicionar `opportunity_id` ao
`UpdateTaskFieldsInput` (`apps/api/src/services/task.service.ts`) e no
`patch: Partial<Task>` de `updateTaskFields` — isso é o que permite
"vínculo manual de tarefa existente a uma oportunidade" (Task 5): editar
uma tarefa já existente só pra setar `opportunity_id`.

- [ ] **Step 6: Verificar**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
pnpm --filter @aula-agente/database build
pnpm --filter @aula-agente/shared build
pnpm --filter @aula-agente/api typecheck
pnpm --filter @aula-agente/api test
```

Rodar a suíte inteira de `apps/api` (não só o arquivo novo) — mudar
`createTaskWithDedup` é uma mudança num caminho já coberto por teste
existente; confirmar que nada quebrou.

- [ ] **Step 7: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
git add packages/shared/src/types/task.ts packages/shared/src/schemas/task.ts \
  packages/database/src/queries/tasks.ts apps/api/src/routes/tasks/index.ts \
  apps/api/src/services/task.service.ts
git commit -m "feat(api): scope task dedup by opportunity when present"
```

---

## Task 5: Tela de Funil de vendas, criação de oportunidade, vínculo de tarefa, menu

**Files:**
- Modify: `apps/web/package.json` (adicionar `@dnd-kit/core`)
- Create: `apps/web/src/components/opportunities/opportunity-kanban.tsx`
- Create: `apps/web/src/components/opportunities/opportunity-form.tsx`
- Create: `apps/web/src/components/opportunities/stage-change-dialog.tsx`
- Create: `apps/web/src/app/(dashboard)/opportunities/page.tsx`
- Modify: `apps/web/src/components/tasks/task-dialog.tsx` (campo de vínculo com oportunidade)
- Modify: `apps/web/src/components/layout/app-sidebar.tsx`

**Interfaces:**
- Consumes: rotas de Task 3 (`GET/POST /organizations/:id/opportunities`,
  `POST /opportunities/:id/stage`, `POST /opportunities/:id/won`,
  `POST /opportunities/:id/lost`), `GET /organizations/:id/members/display`
  (já existe), `OPERATIONS`/`OPERATION_LABELS`/`FUNNEL_STAGES`/
  `FUNNEL_STAGE_LABELS` (Task 2), `useOrganization()` (já existe).
- Produces: rota `/opportunities`, item de menu "Funil de vendas".

- [ ] **Step 1: Adicionar `@dnd-kit/core`**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers/apps/web"
pnpm add @dnd-kit/core@^6.3.1
```

- [ ] **Step 2: Diálogo de evidência (usado ao mudar de estágio)**

Criar `apps/web/src/components/opportunities/stage-change-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function StageChangeDialog({
  open,
  fromLabel,
  toLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  fromLabel: string;
  toLabel: string;
  onConfirm: (evidence: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [evidence, setEvidence] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!evidence.trim()) {
      setError("Descreva a evidência dessa mudança de etapa.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onConfirm(evidence.trim());
      setEvidence("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Mover de &quot;{fromLabel}&quot; para &quot;{toLabel}&quot;
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="evidence">O que confirma essa mudança?</Label>
            <Textarea
              id="evidence"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder='Ex: "Cliente confirmou a proposta por áudio às 14h32."'
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={handleConfirm} disabled={saving}>
              Confirmar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Kanban de oportunidades**

Criar `apps/web/src/components/opportunities/opportunity-kanban.tsx`:

```tsx
"use client";

import { useState } from "react";
import { DndContext, type DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";
import { apiFetch } from "@/lib/api";
import { FUNNEL_STAGES, FUNNEL_STAGE_LABELS } from "@aula-agente/shared";
import type { Opportunity, Operation } from "@aula-agente/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StageChangeDialog } from "@/components/opportunities/stage-change-dialog";

function OpportunityCard({ opportunity }: { opportunity: Opportunity }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: opportunity.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} className="cursor-grab mb-2">
      <Card>
        <CardContent className="p-3 text-sm space-y-1">
          <p className="font-medium">{opportunity.product_model || "Sem modelo"}</p>
          {opportunity.credit_amount != null && (
            <p className="text-muted-foreground">Crédito: R$ {opportunity.credit_amount}</p>
          )}
          {opportunity.sale_amount != null && (
            <p className="text-muted-foreground">Preço: R$ {opportunity.sale_amount}</p>
          )}
          {opportunity.next_action && (
            <p className="text-xs text-muted-foreground">
              Próxima ação: {opportunity.next_action}
              {opportunity.next_action_due_date && ` (${opportunity.next_action_due_date})`}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StageColumn({ stage, opportunities }: { stage: string; opportunities: Opportunity[] }) {
  const { setNodeRef } = useDroppable({ id: stage });
  return (
    <div ref={setNodeRef} className="w-64 shrink-0">
      <Card>
        <CardHeader className="p-3">
          <CardTitle className="text-sm">{FUNNEL_STAGE_LABELS[stage] ?? stage}</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {opportunities.map((o) => (
            <OpportunityCard key={o.id} opportunity={o} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function OpportunityKanban({
  operation,
  opportunities,
  onChanged,
}: {
  operation: Operation;
  opportunities: Opportunity[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<{ opportunity: Opportunity; targetStage: string } | null>(null);
  const stages = FUNNEL_STAGES[operation];

  function handleDragEnd(event: DragEndEvent) {
    const opportunityId = String(event.active.id);
    const targetStage = event.over?.id as string | undefined;
    if (!targetStage) return;

    const opportunity = opportunities.find((o) => o.id === opportunityId);
    if (!opportunity || opportunity.stage === targetStage) return;

    setPending({ opportunity, targetStage });
  }

  async function confirmStageChange(evidence: string) {
    if (!pending) return;
    await apiFetch(`/opportunities/${pending.opportunity.id}/stage`, {
      method: "POST",
      body: JSON.stringify({ stage: pending.targetStage, evidence }),
    });
    setPending(null);
    onChanged();
  }

  return (
    <>
      <DndContext onDragEnd={handleDragEnd}>
        <div className="flex gap-4 overflow-x-auto">
          {stages.map((stage) => (
            <StageColumn
              key={stage}
              stage={stage}
              opportunities={opportunities.filter((o) => o.stage === stage)}
            />
          ))}
        </div>
      </DndContext>
      {pending && (
        <StageChangeDialog
          open={!!pending}
          fromLabel={FUNNEL_STAGE_LABELS[pending.opportunity.stage] ?? pending.opportunity.stage}
          toLabel={FUNNEL_STAGE_LABELS[pending.targetStage] ?? pending.targetStage}
          onConfirm={confirmStageChange}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
```

Nota (Review Focus — transição sem regra restritiva, decisão explícita
desta fase): diferente do `deals` do CRM standalone, o Kanban de
oportunidades **não** bloqueia mover direto pra um estágio não-adjacente —
a spec não pediu essa restrição para os funis novos, e inventá-la agora
seria escopo não solicitado. Qualquer movimento exige evidência (o único
controle desta fase), mas para qualquer estágio do mesmo funil.

- [ ] **Step 4: Formulário de nova oportunidade**

Criar `apps/web/src/components/opportunities/opportunity-form.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import { useOrganization } from "@/providers/organization-provider";
import { OPERATIONS, OPERATION_LABELS, FUNNEL_STAGES, FUNNEL_STAGE_LABELS } from "@aula-agente/shared";
import type { Operation } from "@aula-agente/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

interface MemberOption {
  user_id: string;
  email: string;
  role: string;
}

export function OpportunityForm({ operation, onSaved }: { operation: Operation; onSaved: () => void }) {
  const { currentOrg } = useOrganization();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactOption[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactOption | null>(null);

  const [members, setMembers] = useState<MemberOption[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [stage, setStage] = useState(FUNNEL_STAGES[operation][0]);
  const [productModel, setProductModel] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextActionDueDate, setNextActionDueDate] = useState("");

  useEffect(() => {
    if (!open || !currentOrg) return;
    apiFetch(`/organizations/${currentOrg.id}/members/display`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [open, currentOrg]);

  useEffect(() => {
    if (!contactQuery.trim() || contactQuery.trim().length < 2 || !currentOrg) {
      setContactResults([]);
      return;
    }
    let cancelled = false;
    const supabase = createClient();
    const timeout = setTimeout(async () => {
      const { data } = await supabase
        .from("wa_contacts")
        .select("id, name, phone")
        .eq("organization_id", currentOrg.id)
        .or(`name.ilike.%${contactQuery}%,phone.ilike.%${contactQuery}%`)
        .limit(8);
      if (!cancelled) setContactResults(data || []);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [contactQuery, currentOrg]);

  async function handleSubmit() {
    if (!selectedContact) {
      setError("Selecione um contato");
      return;
    }
    if (!ownerId) {
      setError("Selecione um responsável");
      return;
    }
    if (!nextAction.trim() || !nextActionDueDate) {
      setError("Próxima ação e prazo são obrigatórios");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/organizations/${currentOrg!.id}/opportunities`, {
        method: "POST",
        body: JSON.stringify({
          contact_id: selectedContact.id,
          operation,
          stage,
          product_model: productModel || null,
          owner_id: ownerId,
          next_action: nextAction,
          next_action_due_date: nextActionDueDate,
        }),
      });
      setOpen(false);
      setSelectedContact(null);
      setContactQuery("");
      setProductModel("");
      setNextAction("");
      setNextActionDueDate("");
      setOwnerId("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Nova oportunidade</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova oportunidade — {OPERATION_LABELS[operation]}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Contato</Label>
            {selectedContact ? (
              <div className="flex items-center justify-between rounded border p-2 text-sm">
                <span>{selectedContact.name || selectedContact.phone}</span>
                <Button variant="ghost" size="sm" onClick={() => setSelectedContact(null)}>
                  Trocar
                </Button>
              </div>
            ) : (
              <>
                <Input
                  value={contactQuery}
                  onChange={(e) => setContactQuery(e.target.value)}
                  placeholder="Buscar por nome ou telefone"
                />
                {contactResults.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="block w-full rounded p-2 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setSelectedContact(c);
                      setContactResults([]);
                      setContactQuery("");
                    }}
                  >
                    {c.name || c.phone}
                  </button>
                ))}
              </>
            )}
          </div>
          <div>
            <Label>Estágio inicial</Label>
            <Select value={stage} onValueChange={setStage}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FUNNEL_STAGES[operation].map((s) => (
                  <SelectItem key={s} value={s}>
                    {FUNNEL_STAGE_LABELS[s] ?? s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="product_model">Modelo</Label>
            <Input id="product_model" value={productModel} onChange={(e) => setProductModel(e.target.value)} />
          </div>
          <div>
            <Label>Responsável</Label>
            <Select value={ownerId} onValueChange={setOwnerId}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione um responsável" />
              </SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="next_action">Próxima ação</Label>
            <Input id="next_action" value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="next_action_due_date">Prazo</Label>
            <Input
              id="next_action_due_date"
              type="date"
              value={nextActionDueDate}
              onChange={(e) => setNextActionDueDate(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button onClick={handleSubmit} disabled={saving} className="w-full">
            Salvar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Página do Funil de vendas**

Criar `apps/web/src/app/(dashboard)/opportunities/page.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { apiFetch } from "@/lib/api";
import { OPERATIONS, OPERATION_LABELS } from "@aula-agente/shared";
import type { Operation, Opportunity } from "@aula-agente/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OpportunityKanban } from "@/components/opportunities/opportunity-kanban";
import { OpportunityForm } from "@/components/opportunities/opportunity-form";

export default function OpportunitiesPage() {
  const { currentOrg } = useOrganization();
  const [operation, setOperation] = useState<Operation>("vehicle_sale");
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchOpportunities = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const data = await apiFetch(`/organizations/${currentOrg.id}/opportunities?operation=${operation}`);
    setOpportunities(data);
    setLoading(false);
  }, [currentOrg, operation]);

  useEffect(() => {
    fetchOpportunities();
  }, [fetchOpportunities]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Funil de vendas</h1>
        <OpportunityForm operation={operation} onSaved={fetchOpportunities} />
      </div>
      <Tabs value={operation} onValueChange={(v) => setOperation(v as Operation)}>
        <TabsList>
          {OPERATIONS.map((op) => (
            <TabsTrigger key={op} value={op}>
              {OPERATION_LABELS[op]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {!loading && (
        <OpportunityKanban operation={operation} opportunities={opportunities} onChanged={fetchOpportunities} />
      )}
    </div>
  );
}
```

`Tabs`/`TabsList`/`TabsTrigger` (`apps/web/src/components/ui/tabs.tsx`) são
construídos sobre `@base-ui/react/tabs`, que aceita `value`/`onValueChange`
controlados no `Tabs.Root` — mesmo padrão já confirmado no `Select` deste
projeto (`components/ui/select.tsx`, usado em `deal-kanban.tsx`/
`task-dialog.tsx`).

- [ ] **Step 6: Vínculo manual de tarefa existente a uma oportunidade**

Em `apps/web/src/components/tasks/task-dialog.tsx`, adicionar um estado e
campo novo (só visível ao editar uma tarefa comercial — reaproveita o
padrão de campo opcional já usado no formulário):

```tsx
  const [opportunityId, setOpportunityId] = useState(task?.opportunity_id ?? "");
```

No corpo do `<form>`/diálogo, adicionar um `Input` de texto simples para
colar o ID da oportunidade nesta primeira versão (sem busca — a busca por
nome de oportunidade é um refinamento de UI que pode vir depois; nesta
fase o vínculo existe e funciona, o que a spec pediu):

```tsx
          <div>
            <Label htmlFor="opportunity_id">ID da oportunidade (opcional)</Label>
            <Input
              id="opportunity_id"
              value={opportunityId}
              onChange={(e) => setOpportunityId(e.target.value)}
              placeholder="Vincular esta tarefa a uma oportunidade"
            />
          </div>
```

E no `handleSubmit`, incluir `opportunity_id: opportunityId || null,` nos
dois corpos de requisição (`PATCH /tasks/:id` e
`POST /organizations/:id/tasks`) já existentes na função.

- [ ] **Step 7: Menu lateral**

Em `apps/web/src/components/layout/app-sidebar.tsx`, adicionar `Kanban` aos
imports de `lucide-react` e um item entre "Conversas" e "Tarefas":

```tsx
import {
  Home,
  Inbox,
  Kanban,
  Bot,
  Radio,
  Users,
  Settings,
  DollarSign,
  ListChecks,
  ShoppingBag,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
```

```tsx
const navigation = [
  { name: "Início", href: "/", icon: Home },
  { name: "Conversas", href: "/inbox", icon: Inbox },
  { name: "Funil de vendas", href: "/opportunities", icon: Kanban },
  { name: "Tarefas", href: "/tasks", icon: ListChecks },
  { name: "Catálogo", href: "/catalog", icon: ShoppingBag },
  { name: "Agentes", href: "/agents", icon: Bot },
  { name: "Instancias", href: "/instances", icon: Radio },
  { name: "Custos", href: "/costs", icon: DollarSign },
  { name: "Equipe", href: "/team", icon: Users },
  { name: "Configuracoes", href: "/settings", icon: Settings },
];
```

- [ ] **Step 8: Verificar manualmente**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
pnpm --filter @aula-agente/web dev
```

Abrir `http://localhost:3000/opportunities`. Confirmar:
- As 5 abas (uma por operação) aparecem, com os nomes certos.
- "Nova oportunidade" exige contato, responsável, próxima ação e prazo —
  tentar salvar sem um desses mostra o erro, não salva silenciosamente.
- A oportunidade criada aparece na coluna do estágio inicial escolhido.
- Arrastar o card para outra coluna abre o diálogo de evidência; cancelar
  não move o card; confirmar com evidência move o card e persiste (recarregar
  a página confirma).
- Tentar confirmar sem preencher a evidência mostra o erro, não muda de
  estágio.
- Trocar de aba (outra operação) mostra um Kanban vazio ou com as
  oportunidades daquela operação, nunca misturando operações diferentes.
- Em `/tasks`, editar uma tarefa existente e preencher "ID da oportunidade"
  com o `id` de uma oportunidade real (copiado da URL/inspecionar
  elemento, já que não há busca nesta fase) salva sem erro.
- Criar duas oportunidades para o **mesmo contato**, mesma operação, e
  vincular uma tarefa comercial (ex. `run_quote`) a cada uma via API
  diretamente (`POST /organizations/:id/tasks` com `opportunity_id`
  diferente em cada chamada) resulta em 2 tarefas, não 1 — confirma a
  dedup revisada da Task 4.
- Todas as telas que já existiam continuam funcionando (`/`, `/inbox`,
  `/tasks`, `/catalog`, `/agents`, `/instances`, `/costs`, `/team`,
  `/settings`).

- [ ] **Step 9: Commit**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
git add apps/web/package.json apps/web/pnpm-lock.yaml \
  apps/web/src/components/opportunities/ \
  "apps/web/src/app/(dashboard)/opportunities/page.tsx" \
  apps/web/src/components/tasks/task-dialog.tsx \
  apps/web/src/components/layout/app-sidebar.tsx
git commit -m "feat(web): add Funil de vendas page, opportunity creation, task linking"
```

---

## Depois da Fase 1

Nenhum deploy automático (push para `main` não dispara deploy no
EasyPanel, conforme `docs/operations/deployment.md`). Deploy manual de
`api`/`web` no projeto `agente-whatsapp` só depois do usuário validar tudo
localmente. Fases 2-4 (automações) e Fase 5 (migração do CRM legado) ficam
para specs/planos próprios, seguindo a spec de Oportunidades.
