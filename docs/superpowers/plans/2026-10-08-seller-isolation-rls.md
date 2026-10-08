# Isolamento por vendedor (RLS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o banco impedir que um vendedor leia ou altere o que pertence claramente a outro vendedor (conversas, mensagens, negócios, tarefas e dependentes), inclusive no inbox ao vivo, com um interruptor por organização.

**Architecture:** Três funções `SECURITY DEFINER` (`seller_isolation_applies`, `seller_can_see`, `contact_has_any_conversation`) concentram a regra. Três migrations substituem as políticas RLS atuais (hoje "por organização") das tabelas que a tela lê direto, usando essas funções. Tudo é governado por `organizations.settings.seller_isolation_enabled` (padrão desligado), então o deploy não muda nada até o interruptor ser ligado.

**Tech Stack:** Postgres/Supabase (RLS, funções SQL), testes em PGlite (`@electric-sql/pglite`, já usado em `packages/database/src/sql`), TypeScript, Next.js (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-10-08-seller-isolation-rls-design.md`. Leia antes de começar.

## Global Constraints

- **Interruptor:** `organizations.settings->>'seller_isolation_enabled' = 'true'`. Ausente ou diferente de `'true'` = desligado = comportamento idêntico ao de hoje (todo membro vê tudo da organização).
- **Gestor:** `organization_members.role IN ('owner','admin')` vê e altera tudo.
- **Vendedor:** quem existe em `sales_reps` da organização. Organização **sem nenhum** `sales_reps`: ninguém é restringido.
- **Regra de visibilidade de uma linha com "dono" `owner`:** visível se `owner IS NULL`, ou `owner = auth.uid()`, ou o interruptor está desligado, ou o usuário é gestor, ou `owner` **não** é vendedor. Invisível só quando o dono é **outro vendedor**.
- **UPDATE/DELETE:** mesma condição no `USING`; no UPDATE o `WITH CHECK` repete a condição (um vendedor não transfere linha própria a outro vendedor).
- **Subconsulta dentro de política sofre RLS.** Para saber se um contato "tem conversa" mesmo invisível usa-se função `SECURITY DEFINER` (`contact_has_any_conversation`); nunca `NOT EXISTS` comum sobre `conversations`.
- **API e worker** usam chave de serviço (ignoram RLS); não alterar código deles.
- **Tabelas fora do escopo não mudam:** `organizations`, `organization_members`, `organization_invitations`, `organization_secrets`, `agents`, `evolution_instances`, `knowledge_*`, `conversation_metrics`, `sales_reps`, `lead_*`.
- **Nenhuma migration é aplicada em produção por este plano.** O usuário aplica (colando no SQL Editor do Supabase). A migration não apaga nem altera dados.
- Nomes das migrations (exatos): `20261008120000_seller_isolation_functions.sql`, `20261008120100_seller_isolation_conversations.sql`, `20261008120200_seller_isolation_opportunities.sql`.
- Commits ao final de cada task, na branch `feat/seller-isolation-rls`, **sem push** até a task 6.

## Review Focus

Entradas que a spec implica mas nenhuma task testaria sozinha; cada uma tem teste na task indicada:

1. **Contato com conversas só de outro vendedor não vaza** (o `NOT EXISTS` ingênuo vazaria). Teste na Task 4.
2. **Vendedor tentando passar a própria conversa/negócio a outro vendedor por UPDATE** é rejeitado (e o gestor consegue). Testes nas Tasks 3 e 4.
3. **Organização sem vendedores, interruptor desligado e outra organização:** sem restrição indevida e sem vazamento entre organizações. Testes na Task 5.
4. **Tarefa com vínculos conflitantes** (negócio de um vendedor, conversa de outro): o negócio decide. Teste na Task 4.
5. **Vendedor sem estar em `sales_reps`** (ex.: suporte): vê sem dono/legado, não o de vendedores. Teste na Task 2.
6. **Desempenho:** consulta de mensagens com política ativa não degrada de forma patológica. Teste na Task 5.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `packages/database/src/sql/rls-fixture.ts` (novo) | Esquema mínimo realista (tabelas, índices, políticas "por organização" atuais, `auth.uid()`, papéis) para testar RLS |
| `packages/database/src/sql/rls-harness.ts` (novo) | `createRlsDb`, `asUser`, `seedWorld`, `visible` |
| `packages/database/src/sql/seller-isolation-*.test.ts` (novos) | Testes por task |
| `supabase/migrations/20261008120000_seller_isolation_functions.sql` (novo) | Índices + 3 funções |
| `supabase/migrations/20261008120100_seller_isolation_conversations.sql` (novo) | Políticas de conversas e dependentes |
| `supabase/migrations/20261008120200_seller_isolation_opportunities.sql` (novo) | Políticas de negócios, tarefas, eventos e contatos |
| `packages/shared/src/types/organization.ts` (mod.) | Chave `seller_isolation_enabled?: boolean` |
| `apps/web/src/app/(dashboard)/settings/page.tsx` (mod.) | Interruptor na tela |
| `scripts/build-seller-isolation-sql.sh` (novo) | Junta as 3 migrations em um arquivo transacional para colar no SQL Editor |
| `docs/runbook-isolamento-vendedor.md` (novo) | Ativação, verificação ao vivo e reversão |

---

### Task 1: Harness de testes de RLS (baseline "por organização")

**Files:**
- Create: `packages/database/src/sql/rls-fixture.ts`
- Create: `packages/database/src/sql/rls-harness.ts`
- Create: `packages/database/src/sql/seller-isolation-baseline.test.ts`

**Interfaces:**
- Produces:
  - `createRlsDb(migrations?: string[]): Promise<PGlite>` — cria o esquema de teste, aplica as migrations de isolamento listadas (padrão: as 3) e devolve o banco (usuário superusuário).
  - `asUser<T>(db, userId: string | null, fn: () => Promise<T>): Promise<T>` — roda `fn` como papel `authenticated` com `auth.uid() = userId`.
  - `seedWorld(db, opts?: { isolation?: boolean; withReps?: boolean }): Promise<World>`
  - `visible(db, userId, table: string, column = "id"): Promise<string[]>` — ids visíveis, ordenados.
  - `World` = `{ org, otherOrg, users: { manager, marina, marcio, legacy, support }, contacts: {...}, conv: {...}, opp: {...}, task: {...}, msg: {...} }` (ids em string).

- [ ] **Step 1: Escrever o fixture**

```ts
// packages/database/src/sql/rls-fixture.ts
// Esquema mínimo das tabelas que a tela lê direto, com as políticas "por organização" de hoje (00008, 00011, 00018, 00020, 00025, 00028).
export const RLS_FIXTURE_SQL = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), settings jsonb NOT NULL DEFAULT '{}');
CREATE TABLE public.organization_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), user_id uuid NOT NULL, role text NOT NULL DEFAULT 'agent');
CREATE TABLE public.sales_reps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), user_id uuid NOT NULL, display_name text NOT NULL DEFAULT 'x', rotation_order integer NOT NULL DEFAULT 1);
CREATE TABLE public.wa_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), name text);
CREATE TABLE public.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id) ON DELETE CASCADE, assigned_to uuid, status text NOT NULL DEFAULT 'open');
CREATE TABLE public.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE, role text NOT NULL DEFAULT 'contact', content text NOT NULL DEFAULT '');
CREATE TABLE public.conversation_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE, user_id uuid NOT NULL, content text NOT NULL DEFAULT '');
CREATE TABLE public.conversation_reads (conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE, user_id uuid NOT NULL, last_read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (conversation_id, user_id));
CREATE TABLE public.conversation_qualifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE);
CREATE TABLE public.conversation_qualification_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_qualification_id uuid NOT NULL REFERENCES public.conversation_qualifications(id) ON DELETE CASCADE, event_type text NOT NULL DEFAULT 'x');
CREATE TABLE public.handoff_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE, trigger_type text NOT NULL DEFAULT 'request_human');
CREATE TABLE public.opportunities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id) ON DELETE CASCADE, owner_id uuid, status text NOT NULL DEFAULT 'open');
CREATE TABLE public.opportunity_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), opportunity_id uuid NOT NULL REFERENCES public.opportunities(id) ON DELETE CASCADE, event_type text NOT NULL DEFAULT 'created');
CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id) ON DELETE CASCADE, conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL, opportunity_id uuid REFERENCES public.opportunities(id) ON DELETE SET NULL, assignee_id uuid, status text NOT NULL DEFAULT 'pending');
CREATE TABLE public.task_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE, event_type text NOT NULL DEFAULT 'created');
CREATE INDEX idx_messages_conversation ON public.messages(conversation_id);

CREATE FUNCTION public.get_user_org_ids() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE AS $$ SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid() $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','organization_members','sales_reps','wa_contacts','conversations','messages','conversation_notes','conversation_reads','conversation_qualifications','conversation_qualification_events','handoff_events','opportunities','opportunity_events','tasks','task_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  -- Políticas "por organização" de hoje (00008 loop, 00011, 00020, 00025, 00028).
  FOREACH t IN ARRAY ARRAY['wa_contacts','conversations','messages','conversation_notes','tasks','task_events'] LOOP
    EXECUTE format('CREATE POLICY "%1$s_select" ON public.%1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON public.%1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON public.%1$s FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_delete" ON public.%1$s FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['conversation_qualifications','opportunities'] LOOP
    EXECUTE format('CREATE POLICY "%1$s_select" ON public.%1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON public.%1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON public.%1$s FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_delete" ON public.%1$s FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['conversation_qualification_events','opportunity_events'] LOOP
    EXECUTE format('CREATE POLICY "%1$s_select" ON public.%1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON public.%1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))', t);
  END LOOP;
  EXECUTE 'CREATE POLICY "handoff_events_select" ON public.handoff_events FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "handoff_events_insert" ON public.handoff_events FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "handoff_events_update" ON public.handoff_events FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "organizations_select" ON public.organizations FOR SELECT USING (id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "org_members_select" ON public.organization_members FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "sales_reps_select" ON public.sales_reps FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))';
  -- conversation_reads (00018): só o próprio marcador; escrita só em conversa de organização do usuário.
  EXECUTE 'CREATE POLICY "conversation_reads_select" ON public.conversation_reads FOR SELECT USING (user_id = auth.uid())';
  EXECUTE 'CREATE POLICY "conversation_reads_insert" ON public.conversation_reads FOR INSERT WITH CHECK (user_id = auth.uid() AND conversation_id IN (SELECT id FROM public.conversations WHERE organization_id IN (SELECT get_user_org_ids())))';
  EXECUTE 'CREATE POLICY "conversation_reads_update" ON public.conversation_reads FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid() AND conversation_id IN (SELECT id FROM public.conversations WHERE organization_id IN (SELECT get_user_org_ids())))';
END $$;

GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth TO authenticated, anon, service_role;
`;
```

- [ ] **Step 2: Escrever o harness**

```ts
// packages/database/src/sql/rls-harness.ts
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { RLS_FIXTURE_SQL } from "./rls-fixture.js";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);
export const RLS_MIGRATIONS = [
  "20261008120000_seller_isolation_functions.sql",
  "20261008120100_seller_isolation_conversations.sql",
  "20261008120200_seller_isolation_opportunities.sql",
];

export async function createRlsDb(files: string[] = RLS_MIGRATIONS) {
  const db = new PGlite();
  await db.exec(RLS_FIXTURE_SQL);
  for (const file of files) {
    let sql: string;
    try { sql = readFileSync(new URL(file, MIGRATIONS), "utf8"); }
    catch (err: any) { if (err?.code === "ENOENT") continue; throw err; } // as próximas tasks criam os arquivos
    await db.exec(sql);
  }
  await db.exec("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, anon, service_role;");
  return db;
}
type Db = Awaited<ReturnType<typeof createRlsDb>>;

/** Executa fn como o papel `authenticated` com auth.uid() = userId (null = sem login). */
export async function asUser<T>(db: Db, userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec("SET ROLE authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  try { return await fn(); }
  finally { await db.exec("RESET ROLE"); await db.query("select set_config('request.jwt.claim.sub', '', false)"); }
}

export async function visible(db: Db, userId: string | null, table: string, column = "id"): Promise<string[]> {
  return asUser(db, userId, async () => (await db.query<any>(`select ${column} as id from public.${table} order by ${column}`)).rows.map(r => r.id as string));
}

const id = () => crypto.randomUUID();
const q = async (db: Db, sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0].id as string;

export interface World {
  org: string; otherOrg: string;
  users: { manager: string; marina: string; marcio: string; legacy: string; support: string; otherOrgUser: string };
  contacts: { marina: string; marcio: string; none: string; legacy: string; orphan: string; both: string; otherOrg: string };
  conv: { marina: string; marcio: string; none: string; legacy: string; both1: string; both2: string; otherOrg: string };
  opp: { marina: string; marcio: string; none: string; legacy: string; otherOrg: string };
  task: { onMarinaOpp: string; onMarcioConv: string; assigneeMarcio: string; free: string; conflict: string; otherOrg: string };
  msg: { marina: string; marcio: string; none: string; legacy: string };
}

/**
 * Mundo de teste: 1 organização com gestor (owner), Marina e Márcio (vendedores, em sales_reps),
 * "legacy" (conta compartilhada: membro que NÃO é vendedor) e "support" (agent que NÃO é vendedor);
 * mais uma 2ª organização isolada. opts.isolation liga o interruptor; opts.withReps=false não cadastra vendedores.
 */
export async function seedWorld(db: Db, opts: { isolation?: boolean; withReps?: boolean } = {}): Promise<World> {
  const isolation = opts.isolation ?? true; const withReps = opts.withReps ?? true;
  const org = await q(db, "insert into public.organizations(settings) values ($1) returning id", [JSON.stringify(isolation ? { seller_isolation_enabled: true } : {})]);
  const otherOrg = await q(db, "insert into public.organizations(settings) values ($1) returning id", [JSON.stringify({ seller_isolation_enabled: true })]);
  const users = { manager: id(), marina: id(), marcio: id(), legacy: id(), support: id(), otherOrgUser: id() };
  const member = (o: string, u: string, role: string) => db.query("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,$3)", [o, u, role]);
  await member(org, users.manager, "owner"); await member(org, users.marina, "agent"); await member(org, users.marcio, "agent");
  await member(org, users.legacy, "agent"); await member(org, users.support, "agent"); await member(otherOrg, users.otherOrgUser, "agent");
  if (withReps) for (const [i, u] of [users.marina, users.marcio].entries()) await db.query("insert into public.sales_reps(organization_id,user_id,rotation_order) values ($1,$2,$3)", [org, u, i + 1]);
  await db.query("insert into public.sales_reps(organization_id,user_id) values ($1,$2)", [otherOrg, users.otherOrgUser]);

  const contact = (o: string) => q(db, "insert into public.wa_contacts(organization_id) values ($1) returning id", [o]);
  const contacts = { marina: await contact(org), marcio: await contact(org), none: await contact(org), legacy: await contact(org), orphan: await contact(org), both: await contact(org), otherOrg: await contact(otherOrg) };
  const conversation = (o: string, c: string, assigned: string | null) => q(db, "insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3) returning id", [o, c, assigned]);
  const conv = {
    marina: await conversation(org, contacts.marina, users.marina), marcio: await conversation(org, contacts.marcio, users.marcio),
    none: await conversation(org, contacts.none, null), legacy: await conversation(org, contacts.legacy, users.legacy),
    // "both": contato com duas conversas de vendedores diferentes (só visível a quem vê alguma delas).
    both1: await conversation(org, contacts.both, users.marina), both2: await conversation(org, contacts.both, users.marcio),
    otherOrg: await conversation(otherOrg, contacts.otherOrg, users.otherOrgUser),
  };
  const message = (o: string, c: string) => q(db, "insert into public.messages(organization_id,conversation_id,content) values ($1,$2,'oi') returning id", [o, c]);
  const msg = { marina: await message(org, conv.marina), marcio: await message(org, conv.marcio), none: await message(org, conv.none), legacy: await message(org, conv.legacy) };
  const opportunity = (o: string, c: string, owner: string | null) => q(db, "insert into public.opportunities(organization_id,contact_id,owner_id) values ($1,$2,$3) returning id", [o, c, owner]);
  const opp = { marina: await opportunity(org, contacts.marina, users.marina), marcio: await opportunity(org, contacts.marcio, users.marcio), none: await opportunity(org, contacts.none, null), legacy: await opportunity(org, contacts.legacy, users.legacy), otherOrg: await opportunity(otherOrg, contacts.otherOrg, users.otherOrgUser) };
  const t = (o: string, c: string, conversationId: string | null, opportunityId: string | null, assignee: string | null) =>
    q(db, "insert into public.tasks(organization_id,contact_id,conversation_id,opportunity_id,assignee_id) values ($1,$2,$3,$4,$5) returning id", [o, c, conversationId, opportunityId, assignee]);
  const task = {
    onMarinaOpp: await t(org, contacts.marina, null, opp.marina, users.legacy),
    onMarcioConv: await t(org, contacts.marcio, conv.marcio, null, users.legacy),
    assigneeMarcio: await t(org, contacts.none, null, null, users.marcio),
    free: await t(org, contacts.none, null, null, null),
    // vínculos conflitantes: negócio da Marina + conversa do Márcio → o negócio decide.
    conflict: await t(org, contacts.marina, conv.marcio, opp.marina, null),
    otherOrg: await t(otherOrg, contacts.otherOrg, conv.otherOrg, opp.otherOrg, users.otherOrgUser),
  };
  return { org, otherOrg, users, contacts, conv, opp, task, msg };
}
```

- [ ] **Step 3: Escrever o teste de baseline (falha até o harness existir)**

```ts
// packages/database/src/sql/seller-isolation-baseline.test.ts
import { describe, expect, it } from "vitest";
import { createRlsDb, seedWorld, visible } from "./rls-harness.js";

describe("baseline: sem as migrations de isolamento (comportamento de hoje)", () => {
  it("todo membro vê tudo da própria organização e nada de outra", async () => {
    const db = await createRlsDb([]); // nenhuma migration de isolamento
    const w = await seedWorld(db, { isolation: true });
    for (const user of [w.users.manager, w.users.marina, w.users.marcio, w.users.legacy]) {
      const convs = await visible(db, user, "conversations");
      expect(convs).toContain(w.conv.marcio); expect(convs).toContain(w.conv.marina); expect(convs).not.toContain(w.conv.otherOrg);
      expect(await visible(db, user, "opportunities")).toContain(w.opp.marina);
      expect(await visible(db, user, "tasks")).toContain(w.task.onMarinaOpp);
    }
    expect(await visible(db, w.users.otherOrgUser, "conversations")).toEqual([w.conv.otherOrg]);
    expect(await visible(db, null, "conversations")).toEqual([]);
  });
});
```

- [ ] **Step 4: Rodar e ver passar** (o baseline documenta o comportamento atual)

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/seller-isolation-baseline.test.ts`
Expected: PASS. Se falhar por detalhe do PGlite (ex.: `SET ROLE`, `BYPASSRLS`), corrija o fixture/harness, não o teste.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/seller-isolation-rls
git add packages/database/src/sql/rls-fixture.ts packages/database/src/sql/rls-harness.ts packages/database/src/sql/seller-isolation-baseline.test.ts
git commit -m "test(rls): PGlite harness for seller isolation with today's org-level baseline"
```

---

### Task 2: Migration 1: funções e índices

**Files:**
- Create: `supabase/migrations/20261008120000_seller_isolation_functions.sql`
- Create: `packages/database/src/sql/seller-isolation-functions.test.ts`

**Interfaces:**
- Consumes: Task 1 (`createRlsDb`, `seedWorld`, `asUser`).
- Produces (SQL, `STABLE SECURITY DEFINER SET search_path = public, pg_temp`):
  - `public.seller_isolation_applies(p_org uuid) RETURNS boolean` — `true` só se o interruptor da organização está ligado **e** o usuário (`auth.uid()`) não é gestor **e** a organização tem ao menos um `sales_reps`.
  - `public.seller_can_see(p_org uuid, p_owner uuid) RETURNS boolean` — regra da seção "Global Constraints".
  - `public.contact_has_any_conversation(p_contact uuid) RETURNS boolean` — `EXISTS` em `conversations` **ignorando RLS**.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// packages/database/src/sql/seller-isolation-functions.test.ts
import { describe, expect, it } from "vitest";
import { asUser, createRlsDb, seedWorld } from "./rls-harness.js";

const call = async (db: any, user: string | null, sql: string, params: unknown[] = []) => asUser(db, user, async () => (await db.query(sql, params)).rows[0].r);

describe("seller_isolation_applies", () => {
  it("só se aplica a vendedor, com o interruptor ligado e vendedores cadastrados", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    expect(await call(db, w.users.marcio, "select public.seller_isolation_applies($1) as r", [w.org])).toBe(true);
    expect(await call(db, w.users.support, "select public.seller_isolation_applies($1) as r", [w.org])).toBe(true); // agent fora de sales_reps também é restringido
    expect(await call(db, w.users.manager, "select public.seller_isolation_applies($1) as r", [w.org])).toBe(false); // gestor
  });
  it("não se aplica com o interruptor desligado nem sem vendedores", async () => {
    const off = await createRlsDb(); const wOff = await seedWorld(off, { isolation: false });
    expect(await call(off, wOff.users.marcio, "select public.seller_isolation_applies($1) as r", [wOff.org])).toBe(false);
    const none = await createRlsDb(); const wNone = await seedWorld(none, { withReps: false });
    expect(await call(none, wNone.users.marcio, "select public.seller_isolation_applies($1) as r", [wNone.org])).toBe(false);
  });
  it("organização inexistente ou ausente nunca restringe", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    expect(await call(db, w.users.marcio, "select public.seller_isolation_applies($1) as r", [crypto.randomUUID()])).toBe(false);
  });
});

describe("seller_can_see", () => {
  it("vendedor vê o próprio, o sem dono e o de dono legado; não vê o de outro vendedor", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    const can = (user: string, owner: string | null) => call(db, user, "select public.seller_can_see($1,$2) as r", [w.org, owner]);
    expect(await can(w.users.marcio, w.users.marcio)).toBe(true);
    expect(await can(w.users.marcio, null)).toBe(true);
    expect(await can(w.users.marcio, w.users.legacy)).toBe(true);
    expect(await can(w.users.marcio, w.users.marina)).toBe(false);
    expect(await can(w.users.marina, w.users.marcio)).toBe(false);
  });
  it("agent que não é vendedor (suporte) vê sem dono e legado, não o de vendedores", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    const can = (owner: string | null) => call(db, w.users.support, "select public.seller_can_see($1,$2) as r", [w.org, owner]);
    expect(await can(null)).toBe(true); expect(await can(w.users.legacy)).toBe(true);
    expect(await can(w.users.marina)).toBe(false); expect(await can(w.users.marcio)).toBe(false);
  });
  it("gestor vê tudo; com o interruptor desligado todos veem tudo", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    expect(await call(db, w.users.manager, "select public.seller_can_see($1,$2) as r", [w.org, w.users.marina])).toBe(true);
    const off = await createRlsDb(); const wo = await seedWorld(off, { isolation: false });
    expect(await call(off, wo.users.marcio, "select public.seller_can_see($1,$2) as r", [wo.org, wo.users.marina])).toBe(true);
  });
});

describe("contact_has_any_conversation", () => {
  it("enxerga conversas que o vendedor não vê (ignora RLS), e é falso para contato sem conversa", async () => {
    const db = await createRlsDb(); const w = await seedWorld(db);
    expect(await call(db, w.users.marcio, "select public.contact_has_any_conversation($1) as r", [w.contacts.marina])).toBe(true);
    expect(await call(db, w.users.marcio, "select public.contact_has_any_conversation($1) as r", [w.contacts.orphan])).toBe(false);
  });
});

describe("índices", () => {
  it("cria os índices usados pelas políticas", async () => {
    const db = await createRlsDb();
    const names = (await db.query<any>("select indexname from pg_indexes where schemaname='public'")).rows.map(r => r.indexname);
    for (const n of ["idx_conversations_assigned_to", "idx_conversations_contact", "idx_opportunities_owner", "idx_tasks_assignee"]) expect(names).toContain(n);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/seller-isolation-functions.test.ts`
Expected: FAIL (funções inexistentes).

- [ ] **Step 3: Escrever a migration**

```sql
-- supabase/migrations/20261008120000_seller_isolation_functions.sql
-- Isolamento por vendedor (RLS), parte 1: índices e funções de apoio. Sem efeito sozinho: as políticas vêm nas próximas migrations
-- e só restringem quando organizations.settings.seller_isolation_enabled = 'true'.

CREATE INDEX IF NOT EXISTS idx_conversations_assigned_to ON public.conversations (assigned_to);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON public.conversations (contact_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_owner ON public.opportunities (owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON public.tasks (assignee_id);

-- Verdadeiro só quando: o interruptor da organização está ligado, o usuário não é gestor e a organização tem vendedores.
CREATE OR REPLACE FUNCTION public.seller_isolation_applies(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT o.settings->>'seller_isolation_enabled' = 'true' FROM public.organizations o WHERE o.id = p_org), false)
     AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = p_org AND m.user_id = auth.uid() AND m.role IN ('owner','admin'))
     AND EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = p_org)
$$;

-- Uma linha com dono p_owner é visível, salvo quando o dono é OUTRO vendedor e o isolamento se aplica ao usuário.
CREATE OR REPLACE FUNCTION public.seller_can_see(p_org uuid, p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_owner IS NULL
      OR p_owner = auth.uid()
      OR NOT public.seller_isolation_applies(p_org)
      OR NOT EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = p_org AND r.user_id = p_owner)
$$;

-- Existe alguma conversa do contato? Ignora RLS de propósito: uma subconsulta comum dentro de política só enxergaria as conversas
-- visíveis e faria um contato cujas conversas são todas de outro vendedor parecer "sem conversa" (vazamento).
CREATE OR REPLACE FUNCTION public.contact_has_any_conversation(p_contact uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.conversations WHERE contact_id = p_contact)
$$;

REVOKE ALL ON FUNCTION public.seller_isolation_applies(uuid), public.seller_can_see(uuid, uuid), public.contact_has_any_conversation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seller_isolation_applies(uuid), public.seller_can_see(uuid, uuid), public.contact_has_any_conversation(uuid) TO authenticated, service_role;
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/seller-isolation-functions.test.ts src/sql/seller-isolation-baseline.test.ts`
Expected: PASS nos dois (o baseline continua igual, pois as políticas ainda não mudaram).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261008120000_seller_isolation_functions.sql packages/database/src/sql/seller-isolation-functions.test.ts
git commit -m "feat(rls): seller isolation helper functions and indexes"
```

---

### Task 3: Migration 2: políticas de conversas e dependentes

**Files:**
- Create: `supabase/migrations/20261008120100_seller_isolation_conversations.sql`
- Create: `packages/database/src/sql/seller-isolation-conversations.test.ts`

**Interfaces:**
- Consumes: Tasks 1 e 2.
- Produces: políticas substituídas (mesmos nomes de hoje) em `conversations`, `messages`, `conversation_notes`, `conversation_qualifications`, `conversation_qualification_events`, `handoff_events`. `conversation_reads` **não muda** (justificativa abaixo).

Regras desta task:
- `conversations`: dono = `assigned_to` via `seller_can_see(organization_id, assigned_to)`; SELECT/INSERT/UPDATE/DELETE; no INSERT e no UPDATE o `WITH CHECK` exige a mesma visibilidade (um vendedor não pode atribuir a conversa a outro vendedor).
- `messages`, `conversation_notes`, `conversation_qualifications`, `handoff_events`: visíveis/alteráveis se a **conversa** for visível, via `EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = <tabela>.conversation_id)` (a subconsulta herda o RLS de `conversations`).
- `conversation_qualification_events`: via a qualificação (`EXISTS` em `conversation_qualifications`, que herda a regra).
- `conversation_reads`: as políticas de hoje já exigem `user_id = auth.uid()` e as de escrita fazem subconsulta em `conversations` (que sofre RLS), então um vendedor **não consegue** criar marcador de leitura numa conversa invisível e só lê o próprio marcador. Não muda; há teste.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// packages/database/src/sql/seller-isolation-conversations.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { asUser, createRlsDb, seedWorld, visible, type World } from "./rls-harness.js";

let db: Awaited<ReturnType<typeof createRlsDb>>; let w: World;
beforeEach(async () => {
  db = await createRlsDb();
  w = await seedWorld(db);
  // dependentes (qualificação, eventos, handoff, notas, marcador de leitura) para cada conversa da organização
  for (const c of [w.conv.marina, w.conv.marcio, w.conv.none, w.conv.legacy]) {
    const qid = (await db.query<any>("insert into public.conversation_qualifications(organization_id,conversation_id) values ($1,$2) returning id", [w.org, c])).rows[0].id;
    await db.query("insert into public.conversation_qualification_events(organization_id,conversation_qualification_id) values ($1,$2)", [w.org, qid]);
    await db.query("insert into public.handoff_events(organization_id,conversation_id) values ($1,$2)", [w.org, c]);
    await db.query("insert into public.conversation_notes(organization_id,conversation_id,user_id) values ($1,$2,$3)", [w.org, c, w.users.manager]);
  }
});

describe("conversations", () => {
  it("o Márcio não vê as conversas da Marina; vê as dele, as sem dono e as do dono legado", async () => {
    expect(await visible(db, w.users.marcio, "conversations")).toEqual([w.conv.marcio, w.conv.none, w.conv.legacy, w.conv.both2].sort());
  });
  it("a Marina não vê as do Márcio", async () => {
    expect(await visible(db, w.users.marina, "conversations")).toEqual([w.conv.marina, w.conv.none, w.conv.legacy, w.conv.both1].sort());
  });
  it("o gestor vê todas da organização e nenhuma de outra", async () => {
    const ids = await visible(db, w.users.manager, "conversations");
    expect(ids).toEqual([w.conv.marina, w.conv.marcio, w.conv.none, w.conv.legacy, w.conv.both1, w.conv.both2].sort());
  });
  it("outra organização nunca aparece, nem para o gestor", async () => {
    for (const u of [w.users.manager, w.users.marina]) expect(await visible(db, u, "conversations")).not.toContain(w.conv.otherOrg);
    expect(await visible(db, w.users.otherOrgUser, "conversations")).toEqual([w.conv.otherOrg]);
  });
  it("o vendedor não altera nem apaga conversa que não vê (0 linhas afetadas)", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.conversations set status='closed' where id=$1", [w.conv.marina])).affectedRows).toBe(0);
      expect((await db.query("delete from public.conversations where id=$1", [w.conv.marina])).affectedRows).toBe(0);
    });
    expect((await db.query<any>("select status from public.conversations where id=$1", [w.conv.marina])).rows[0].status).toBe("open");
  });
  it("o vendedor altera a própria conversa, mas NÃO a passa para outro vendedor (WITH CHECK)", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.conversations set status='closed' where id=$1", [w.conv.marcio])).affectedRows).toBe(1);
      await expect(db.query("update public.conversations set assigned_to=$2 where id=$1", [w.conv.marcio, w.users.marina])).rejects.toThrow(/row-level security/i);
      // soltar a conversa (sem dono) é permitido: continua visível para ele
      expect((await db.query("update public.conversations set assigned_to=null where id=$1", [w.conv.marcio])).affectedRows).toBe(1);
    });
  });
  it("o gestor consegue transferir a conversa de um vendedor a outro", async () => {
    await asUser(db, w.users.manager, async () => {
      expect((await db.query("update public.conversations set assigned_to=$2 where id=$1", [w.conv.marina, w.users.marcio])).affectedRows).toBe(1);
    });
  });
  it("o vendedor pode assumir uma conversa sem dono (passa a ser dele)", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.conversations set assigned_to=$2 where id=$1", [w.conv.none, w.users.marcio])).affectedRows).toBe(1);
    });
  });
  it("o vendedor não cria conversa já atribuída a outro vendedor", async () => {
    await asUser(db, w.users.marcio, async () => {
      await expect(db.query("insert into public.conversations(organization_id,contact_id,assigned_to) values ($1,$2,$3)", [w.org, w.contacts.none, w.users.marina])).rejects.toThrow(/row-level security/i);
    });
  });
});

describe.each([
  ["messages", "conversation_id"], ["conversation_notes", "conversation_id"], ["conversation_qualifications", "conversation_id"], ["handoff_events", "conversation_id"],
])("%s herda a visibilidade da conversa", (table, col) => {
  it("o Márcio só vê as linhas das conversas que ele vê", async () => {
    const rows = await asUser(db, w.users.marcio, async () => (await db.query<any>(`select ${col} as c from public.${table}`)).rows.map(r => r.c));
    expect(rows).not.toContain(w.conv.marina);
    expect(rows).toContain(w.conv.marcio);
  });
  it("o gestor vê as de todos", async () => {
    const rows = await asUser(db, w.users.manager, async () => (await db.query<any>(`select ${col} as c from public.${table}`)).rows.map(r => r.c));
    expect(rows).toContain(w.conv.marina); expect(rows).toContain(w.conv.marcio);
  });
});

describe("mensagens e dependentes", () => {
  it("o Márcio não lê nem escreve mensagem na conversa da Marina", async () => {
    expect(await visible(db, w.users.marcio, "messages")).not.toContain(w.msg.marina);
    await asUser(db, w.users.marcio, async () => {
      await expect(db.query("insert into public.messages(organization_id,conversation_id,content) values ($1,$2,'x')", [w.org, w.conv.marina])).rejects.toThrow(/row-level security/i);
      expect((await db.query("update public.messages set content='x' where id=$1", [w.msg.marina])).affectedRows).toBe(0);
    });
  });
  it("o Márcio escreve na própria conversa", async () => {
    await asUser(db, w.users.marcio, async () => {
      await db.query("insert into public.messages(organization_id,conversation_id,content) values ($1,$2,'x')", [w.org, w.conv.marcio]);
    });
  });
  it("eventos de qualificação seguem a qualificação (e a conversa)", async () => {
    const rows = await asUser(db, w.users.marcio, async () => (await db.query<any>("select count(*)::int as n from public.conversation_qualification_events")).rows[0].n);
    const all = (await db.query<any>("select count(*)::int as n from public.conversation_qualification_events")).rows[0].n;
    expect(rows).toBe(3); // marcio + none + legacy (marina fica de fora)
    expect(all).toBe(4);
  });
});

describe("conversation_reads (não muda)", () => {
  it("o Márcio não cria marcador de leitura em conversa que não vê e só lê o próprio marcador", async () => {
    await asUser(db, w.users.marcio, async () => {
      await expect(db.query("insert into public.conversation_reads(conversation_id,user_id) values ($1,$2)", [w.conv.marina, w.users.marcio])).rejects.toThrow(/row-level security/i);
      await db.query("insert into public.conversation_reads(conversation_id,user_id) values ($1,$2)", [w.conv.marcio, w.users.marcio]);
      expect((await db.query<any>("select count(*)::int as n from public.conversation_reads")).rows[0].n).toBe(1);
    });
  });
});
```

(Observação sobre `affectedRows`: o PGlite devolve `affectedRows` em `db.query` para UPDATE/DELETE. Se a versão instalada não devolver, use `UPDATE ... RETURNING id` e conte `rows.length`; ajuste só o helper do teste, não a asserção.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/seller-isolation-conversations.test.ts`
Expected: FAIL (as políticas ainda são por organização).

- [ ] **Step 3: Escrever a migration**

```sql
-- supabase/migrations/20261008120100_seller_isolation_conversations.sql
-- Isolamento por vendedor (RLS), parte 2: conversas e dependentes. Só restringe com seller_isolation_enabled = 'true'.

-- conversations: dono = assigned_to.
DROP POLICY IF EXISTS "conversations_select" ON public.conversations;
DROP POLICY IF EXISTS "conversations_insert" ON public.conversations;
DROP POLICY IF EXISTS "conversations_update" ON public.conversations;
DROP POLICY IF EXISTS "conversations_delete" ON public.conversations;
CREATE POLICY "conversations_select" ON public.conversations FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, assigned_to));
CREATE POLICY "conversations_insert" ON public.conversations FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, assigned_to));
CREATE POLICY "conversations_update" ON public.conversations FOR UPDATE
  USING (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, assigned_to))
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, assigned_to));
CREATE POLICY "conversations_delete" ON public.conversations FOR DELETE
  USING (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, assigned_to));

-- Dependentes diretos da conversa: a subconsulta em conversations herda o RLS acima (só enxerga conversas visíveis).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages','conversation_notes','conversation_qualifications'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_select" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_insert" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_update" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_delete" ON public.%1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_select" ON public.%1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = %1$s.conversation_id))', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON public.%1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = %1$s.conversation_id))', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON public.%1$s FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = %1$s.conversation_id)) WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = %1$s.conversation_id))', t);
    EXECUTE format('CREATE POLICY "%1$s_delete" ON public.%1$s FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = %1$s.conversation_id))', t);
  END LOOP;
END $$;

-- handoff_events (hoje: select, insert, update; sem delete).
DROP POLICY IF EXISTS "handoff_events_select" ON public.handoff_events;
DROP POLICY IF EXISTS "handoff_events_insert" ON public.handoff_events;
DROP POLICY IF EXISTS "handoff_events_update" ON public.handoff_events;
CREATE POLICY "handoff_events_select" ON public.handoff_events FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = handoff_events.conversation_id));
CREATE POLICY "handoff_events_insert" ON public.handoff_events FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = handoff_events.conversation_id));
CREATE POLICY "handoff_events_update" ON public.handoff_events FOR UPDATE
  USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = handoff_events.conversation_id));

-- conversation_qualification_events: via a qualificação (que herda a conversa). Hoje: select, insert.
DROP POLICY IF EXISTS "conversation_qualification_events_select" ON public.conversation_qualification_events;
DROP POLICY IF EXISTS "conversation_qualification_events_insert" ON public.conversation_qualification_events;
CREATE POLICY "conversation_qualification_events_select" ON public.conversation_qualification_events FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversation_qualifications q WHERE q.id = conversation_qualification_events.conversation_qualification_id));
CREATE POLICY "conversation_qualification_events_insert" ON public.conversation_qualification_events FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversation_qualifications q WHERE q.id = conversation_qualification_events.conversation_qualification_id));

-- conversation_reads: sem alteração (política atual já exige user_id = auth.uid() e subconsulta em conversations, que sofre RLS).
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/seller-isolation-conversations.test.ts src/sql/seller-isolation-functions.test.ts`
Expected: PASS. Se o baseline (Task 1) agora falhar, é esperado: com as migrations carregadas por padrão ele deixa de valer; o teste de baseline usa `createRlsDb([])` e continua passando.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261008120100_seller_isolation_conversations.sql packages/database/src/sql/seller-isolation-conversations.test.ts
git commit -m "feat(rls): seller isolation policies for conversations and dependents"
```

---

### Task 4: Migration 3: negócios, tarefas, eventos e contatos

**Files:**
- Create: `supabase/migrations/20261008120200_seller_isolation_opportunities.sql`
- Create: `packages/database/src/sql/seller-isolation-opportunities.test.ts`

**Interfaces:**
- Consumes: Tasks 1 a 3.
- Produces: políticas substituídas (mesmos nomes) em `opportunities`, `opportunity_events`, `tasks`, `task_events`, `wa_contacts`.

Regras:
- `opportunities`: dono = `owner_id`, `seller_can_see(organization_id, owner_id)`; `WITH CHECK` no INSERT/UPDATE.
- `opportunity_events`: via `EXISTS` em `opportunities`. Hoje só tem select e insert.
- `tasks`: o vínculo mais forte decide: `opportunity_id` (o negócio precisa ser visível) → senão `conversation_id` (a conversa precisa ser visível) → senão `seller_can_see(organization_id, assignee_id)`.
- `task_events`: via `EXISTS` em `tasks`.
- `wa_contacts`: visível se `NOT seller_isolation_applies(organization_id)` ou o contato não tem nenhuma conversa (`NOT contact_has_any_conversation(id)`) ou alguma conversa dele é visível (`EXISTS` em `conversations`, que herda o RLS).

- [ ] **Step 1: Escrever o teste que falha**

```ts
// packages/database/src/sql/seller-isolation-opportunities.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { asUser, createRlsDb, seedWorld, visible, type World } from "./rls-harness.js";

let db: Awaited<ReturnType<typeof createRlsDb>>; let w: World;
beforeEach(async () => {
  db = await createRlsDb(); w = await seedWorld(db);
  for (const o of [w.opp.marina, w.opp.marcio, w.opp.none, w.opp.legacy]) await db.query("insert into public.opportunity_events(organization_id,opportunity_id) values ($1,$2)", [w.org, o]);
  for (const t of [w.task.onMarinaOpp, w.task.onMarcioConv, w.task.assigneeMarcio, w.task.free, w.task.conflict]) await db.query("insert into public.task_events(organization_id,task_id) values ($1,$2)", [w.org, t]);
});

describe("opportunities", () => {
  it("o Márcio não vê os negócios da Marina; vê o dele, o sem dono e o legado", async () => {
    expect(await visible(db, w.users.marcio, "opportunities")).toEqual([w.opp.marcio, w.opp.none, w.opp.legacy].sort());
  });
  it("a Marina não vê o do Márcio; o gestor vê todos", async () => {
    expect(await visible(db, w.users.marina, "opportunities")).toEqual([w.opp.marina, w.opp.none, w.opp.legacy].sort());
    expect(await visible(db, w.users.manager, "opportunities")).toEqual([w.opp.marina, w.opp.marcio, w.opp.none, w.opp.legacy].sort());
  });
  it("o vendedor não altera negócio que não vê, não o passa a outro vendedor, mas pega um sem dono", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.opportunities set status='lost' where id=$1", [w.opp.marina])).affectedRows).toBe(0);
      await expect(db.query("update public.opportunities set owner_id=$2 where id=$1", [w.opp.marcio, w.users.marina])).rejects.toThrow(/row-level security/i);
      expect((await db.query("update public.opportunities set owner_id=$2 where id=$1", [w.opp.none, w.users.marcio])).affectedRows).toBe(1);
    });
  });
  it("o gestor transfere negócio entre vendedores", async () => {
    await asUser(db, w.users.manager, async () => {
      expect((await db.query("update public.opportunities set owner_id=$2 where id=$1", [w.opp.marina, w.users.marcio])).affectedRows).toBe(1);
    });
  });
});

describe("opportunity_events", () => {
  it("seguem a visibilidade do negócio", async () => {
    const n = (u: string) => asUser(db, u, async () => (await db.query<any>("select count(*)::int as n from public.opportunity_events")).rows[0].n);
    expect(await n(w.users.marcio)).toBe(3); expect(await n(w.users.manager)).toBe(4);
  });
});

describe("tasks (o vínculo mais forte decide)", () => {
  it("o Márcio: tarefa do negócio da Marina fica invisível mesmo com responsável legado", async () => {
    const ids = await visible(db, w.users.marcio, "tasks");
    expect(ids).not.toContain(w.task.onMarinaOpp);
  });
  it("o Márcio vê a tarefa da própria conversa, a atribuída a ele e a livre", async () => {
    const ids = await visible(db, w.users.marcio, "tasks");
    expect(ids).toEqual([w.task.onMarcioConv, w.task.assigneeMarcio, w.task.free].sort());
  });
  it("vínculos conflitantes: negócio da Marina + conversa do Márcio → o negócio decide (Márcio não vê; Marina vê)", async () => {
    expect(await visible(db, w.users.marcio, "tasks")).not.toContain(w.task.conflict);
    expect(await visible(db, w.users.marina, "tasks")).toContain(w.task.conflict);
  });
  it("a Marina não vê a tarefa atribuída ao Márcio nem a da conversa dele; vê a do negócio dela e a livre", async () => {
    const ids = await visible(db, w.users.marina, "tasks");
    expect(ids).toEqual([w.task.onMarinaOpp, w.task.free, w.task.conflict].sort());
  });
  it("o gestor vê todas da organização", async () => {
    const ids = await visible(db, w.users.manager, "tasks");
    expect(ids).toEqual([w.task.onMarinaOpp, w.task.onMarcioConv, w.task.assigneeMarcio, w.task.free, w.task.conflict].sort());
  });
  it("o vendedor não altera tarefa que não vê", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.tasks set status='completed' where id=$1", [w.task.onMarinaOpp])).affectedRows).toBe(0);
    });
  });
  it("task_events seguem a tarefa", async () => {
    const n = (u: string) => asUser(db, u, async () => (await db.query<any>("select count(*)::int as n from public.task_events")).rows[0].n);
    expect(await n(w.users.marcio)).toBe(3); expect(await n(w.users.manager)).toBe(5);
  });
});

describe("wa_contacts (a armadilha do contato)", () => {
  it("contato só com conversa de outro vendedor NÃO vaza; sem conversa, sem dono e legado são visíveis", async () => {
    const ids = await visible(db, w.users.marcio, "wa_contacts");
    expect(ids).not.toContain(w.contacts.marina);          // só conversa da Marina
    expect(ids).toContain(w.contacts.marcio);
    expect(ids).toContain(w.contacts.none);
    expect(ids).toContain(w.contacts.legacy);
    expect(ids).toContain(w.contacts.orphan);              // sem nenhuma conversa
    expect(ids).toContain(w.contacts.both);                // tem uma conversa dele
  });
  it("contato com conversas de dois vendedores é visível a ambos", async () => {
    expect(await visible(db, w.users.marina, "wa_contacts")).toContain(w.contacts.both);
    expect(await visible(db, w.users.marcio, "wa_contacts")).toContain(w.contacts.both);
  });
  it("o gestor vê todos; ninguém vê contato de outra organização", async () => {
    const all = await visible(db, w.users.manager, "wa_contacts");
    expect(all).toContain(w.contacts.marina); expect(all).not.toContain(w.contacts.otherOrg);
    expect(await visible(db, w.users.marcio, "wa_contacts")).not.toContain(w.contacts.otherOrg);
  });
  it("o vendedor não altera contato que não vê", async () => {
    await asUser(db, w.users.marcio, async () => {
      expect((await db.query("update public.wa_contacts set name='x' where id=$1", [w.contacts.marina])).affectedRows).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/seller-isolation-opportunities.test.ts`
Expected: FAIL.

- [ ] **Step 3: Escrever a migration**

```sql
-- supabase/migrations/20261008120200_seller_isolation_opportunities.sql
-- Isolamento por vendedor (RLS), parte 3: negócios, tarefas, eventos e contatos. Só restringe com seller_isolation_enabled = 'true'.

-- opportunities: dono = owner_id.
DROP POLICY IF EXISTS "opportunities_select" ON public.opportunities;
DROP POLICY IF EXISTS "opportunities_insert" ON public.opportunities;
DROP POLICY IF EXISTS "opportunities_update" ON public.opportunities;
DROP POLICY IF EXISTS "opportunities_delete" ON public.opportunities;
CREATE POLICY "opportunities_select" ON public.opportunities FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, owner_id));
CREATE POLICY "opportunities_insert" ON public.opportunities FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, owner_id));
CREATE POLICY "opportunities_update" ON public.opportunities FOR UPDATE
  USING (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, owner_id))
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, owner_id));
CREATE POLICY "opportunities_delete" ON public.opportunities FOR DELETE
  USING (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, owner_id));

-- opportunity_events (hoje: select, insert): via o negócio.
DROP POLICY IF EXISTS "opportunity_events_select" ON public.opportunity_events;
DROP POLICY IF EXISTS "opportunity_events_insert" ON public.opportunity_events;
CREATE POLICY "opportunity_events_select" ON public.opportunity_events FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = opportunity_events.opportunity_id));
CREATE POLICY "opportunity_events_insert" ON public.opportunity_events FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = opportunity_events.opportunity_id));

-- tasks: o vínculo mais forte decide (negócio > conversa > responsável).
DROP POLICY IF EXISTS "tasks_select" ON public.tasks;
DROP POLICY IF EXISTS "tasks_insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks_update" ON public.tasks;
DROP POLICY IF EXISTS "tasks_delete" ON public.tasks;
CREATE POLICY "tasks_select" ON public.tasks FOR SELECT USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE public.seller_can_see(organization_id, assignee_id) END));
CREATE POLICY "tasks_insert" ON public.tasks FOR INSERT WITH CHECK (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE public.seller_can_see(organization_id, assignee_id) END));
CREATE POLICY "tasks_update" ON public.tasks FOR UPDATE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE public.seller_can_see(organization_id, assignee_id) END))
  WITH CHECK (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE public.seller_can_see(organization_id, assignee_id) END));
CREATE POLICY "tasks_delete" ON public.tasks FOR DELETE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE public.seller_can_see(organization_id, assignee_id) END));

-- task_events: via a tarefa.
DO $$
DECLARE cmd text;
BEGIN
  DROP POLICY IF EXISTS "task_events_select" ON public.task_events;
  DROP POLICY IF EXISTS "task_events_insert" ON public.task_events;
  DROP POLICY IF EXISTS "task_events_update" ON public.task_events;
  DROP POLICY IF EXISTS "task_events_delete" ON public.task_events;
  CREATE POLICY "task_events_select" ON public.task_events FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.tasks k WHERE k.id = task_events.task_id));
  CREATE POLICY "task_events_insert" ON public.task_events FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.tasks k WHERE k.id = task_events.task_id));
  CREATE POLICY "task_events_update" ON public.task_events FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.tasks k WHERE k.id = task_events.task_id));
  CREATE POLICY "task_events_delete" ON public.task_events FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.tasks k WHERE k.id = task_events.task_id));
END $$;

-- wa_contacts: visível se o isolamento não se aplica, ou o contato não tem conversa nenhuma (função que ignora RLS), ou alguma conversa dele é visível.
DROP POLICY IF EXISTS "wa_contacts_select" ON public.wa_contacts;
DROP POLICY IF EXISTS "wa_contacts_insert" ON public.wa_contacts;
DROP POLICY IF EXISTS "wa_contacts_update" ON public.wa_contacts;
DROP POLICY IF EXISTS "wa_contacts_delete" ON public.wa_contacts;
CREATE POLICY "wa_contacts_select" ON public.wa_contacts FOR SELECT USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    NOT public.seller_isolation_applies(organization_id)
    OR NOT public.contact_has_any_conversation(id)
    OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = wa_contacts.id)));
CREATE POLICY "wa_contacts_insert" ON public.wa_contacts FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "wa_contacts_update" ON public.wa_contacts FOR UPDATE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    NOT public.seller_isolation_applies(organization_id)
    OR NOT public.contact_has_any_conversation(id)
    OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = wa_contacts.id)));
CREATE POLICY "wa_contacts_delete" ON public.wa_contacts FOR DELETE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    NOT public.seller_isolation_applies(organization_id)
    OR NOT public.contact_has_any_conversation(id)
    OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = wa_contacts.id)));
```

(Nota: o bloco `DO $$ ... DECLARE cmd text` do `task_events` não usa `cmd`; remova a declaração se o linter reclamar. `DROP POLICY`/`CREATE POLICY` dentro de `DO` são válidos; se preferir, mova os comandos para fora do `DO`.)

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/seller-isolation-opportunities.test.ts`
Expected: PASS. Em caso de falha no wa_contacts, confira que a política usa `contact_has_any_conversation` (e não `NOT EXISTS` comum): é a armadilha da spec.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261008120200_seller_isolation_opportunities.sql packages/database/src/sql/seller-isolation-opportunities.test.ts
git commit -m "feat(rls): seller isolation policies for opportunities, tasks, events and contacts"
```

---

### Task 5: Regressão (interruptor, sem vendedores, outra organização) e desempenho

**Files:**
- Create: `packages/database/src/sql/seller-isolation-regression.test.ts`

**Interfaces:**
- Consumes: Tasks 1 a 4 (todas as migrations).
- Produces: nenhum código novo; só testes que fixam o comportamento seguro e o desempenho.

- [ ] **Step 1: Escrever os testes**

```ts
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
```

- [ ] **Step 2: Rodar**

Run: `pnpm --filter @aula-agente/database exec vitest run src/sql/seller-isolation-regression.test.ts`
Expected: PASS. Se o teste de desempenho passar de 8 s, **não aumente o limite**: investigue (índice faltando, função sendo avaliada por linha sem curto-circuito) e reporte; a ordem `p_owner IS NULL OR p_owner = auth.uid() OR ...` em `seller_can_see` foi escolhida para evitar consultas no caso comum.

- [ ] **Step 3: Suíte completa do pacote**

Run: `pnpm --filter @aula-agente/database exec vitest run && pnpm --filter @aula-agente/database exec tsc --noEmit`
Expected: tudo passa (os testes de SQL da distribuição de leads continuam passando).

- [ ] **Step 4: Commit**

```bash
git add packages/database/src/sql/seller-isolation-regression.test.ts
git commit -m "test(rls): regression and performance guards for seller isolation"
```

---

### Task 6: Interruptor na tela, runbook e pacote SQL para aplicar

**Files:**
- Modify: `packages/shared/src/types/organization.ts` (chave `seller_isolation_enabled?: boolean`)
- Modify: `apps/web/src/app/(dashboard)/settings/page.tsx` (interruptor)
- Create: `scripts/build-seller-isolation-sql.sh`
- Create: `docs/runbook-isolamento-vendedor.md`

**Interfaces:**
- Consumes: as 3 migrations (Tasks 2 a 4).
- Produces: chave de settings tipada; interruptor "Isolamento por vendedor" (só owner/admin enxergam e usam, como os demais da página); script que gera `/tmp/seller-isolation-migrations.sql` (3 migrations em uma transação + registro no histórico do Supabase CLI).

- [ ] **Step 1: Tipar a chave**

Em `packages/shared/src/types/organization.ts`, em `OrganizationSettings`, junto das chaves de distribuição, adicione:

```ts
  // Isolamento por vendedor no banco (RLS). Desligado por padrão: com ele ligado, um vendedor não lê nem altera o que é de outro vendedor.
  seller_isolation_enabled?: boolean;
```

Run: `pnpm --filter @aula-agente/shared exec tsc --noEmit && pnpm --filter @aula-agente/shared build`
Expected: sem erros.

- [ ] **Step 2: Interruptor na tela**

Em `apps/web/src/app/(dashboard)/settings/page.tsx`: na união de flags aceita por `toggleWorkspace` (hoje inclui `"scheduled_ad_closure_enabled"`, `"lead_distribution_enabled"`, etc.) acrescente `"seller_isolation_enabled"`. Dentro do cartão **Distribuição** (onde estão os interruptores `lead_distribution_*`), logo **antes** do interruptor da distribuição real, acrescente:

```tsx
<div className="flex items-center justify-between gap-3">
  <Label htmlFor="seller-isolation">Isolamento por vendedor (cada vendedor só vê o que é dele e o que está sem dono)</Label>
  <Switch id="seller-isolation" checked={currentOrg?.settings.seller_isolation_enabled === true} disabled={savingWorkspace} onCheckedChange={v => toggleWorkspace(v, "seller_isolation_enabled")} />
</div>
```

Se `toggleWorkspace` encaminha erros de flags `lead_distribution_*` para `leadError`, inclua também `seller_isolation_enabled` nessa regra para o erro aparecer no mesmo cartão.

Run: `pnpm --filter @aula-agente/web exec tsc --noEmit && (cd apps/web && npx next build)`
Expected: sem erros de tipo; build compila.

- [ ] **Step 3: Script que junta as migrations**

```bash
#!/usr/bin/env bash
# scripts/build-seller-isolation-sql.sh
# Junta as 3 migrations de isolamento por vendedor em um arquivo único, em uma transação,
# e registra as versões no histórico do Supabase CLI. Para colar no SQL Editor do Supabase.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-/tmp/seller-isolation-migrations.sql}"
FILES=$(ls supabase/migrations/20261008120*_seller_isolation_*.sql | sort)
{
  echo "-- Isolamento por vendedor (RLS): 3 migrations em UMA transação (tudo ou nada)."
  echo "-- Só restringe quando organizations.settings.seller_isolation_enabled = 'true'; aplicar não muda nada sozinho."
  echo "begin;"
  for f in $FILES; do echo; echo "-- ===== $(basename "$f") ====="; cat "$f"; done
  echo
  echo "insert into supabase_migrations.schema_migrations(version, name) values"
  echo "$FILES" | sed -E "s#.*/([0-9]+)_(.*)\.sql#('\1','\2')#" | paste -sd, -
  echo "on conflict (version) do nothing;"
  echo
  echo "commit;"
} > "$OUT"
echo "wrote $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"
```

Run: `chmod +x scripts/build-seller-isolation-sql.sh && bash scripts/build-seller-isolation-sql.sh /tmp/seller-isolation-test.sql && head -4 /tmp/seller-isolation-test.sql && grep -c "begin;" /tmp/seller-isolation-test.sql && tail -8 /tmp/seller-isolation-test.sql`
Expected: arquivo gerado com `begin;` no início, as 3 versões no `insert` e `commit;` no fim.

- [ ] **Step 4: Runbook**

Crie `docs/runbook-isolamento-vendedor.md` com este conteúdo:

```markdown
# Runbook: isolamento por vendedor (RLS)

Spec: docs/superpowers/specs/2026-10-08-seller-isolation-rls-design.md

## O que é
Faz o banco impedir que um vendedor leia ou altere o que pertence a outro vendedor (conversas, mensagens, negócios, tarefas e dependentes), inclusive no inbox ao vivo. Só vale com `organizations.settings.seller_isolation_enabled = true`. Gestores (owner/admin) veem tudo. Organização sem vendedores em `sales_reps` não é restringida.

## 1. Aplicar as migrations (desligadas)
1. Na raiz do repositório: `bash scripts/build-seller-isolation-sql.sh` (gera `/tmp/seller-isolation-migrations.sql`).
2. No Supabase: SQL Editor → New query → colar o arquivo inteiro → Run. Deve responder "Success". Tudo ou nada (uma transação).
3. Conferir: a função `seller_can_see` existe e nada mudou para os usuários (o interruptor está desligado).

## 2. Regressão com o interruptor DESLIGADO
Entrar com o Márcio, com a Marina e com o gestor: inbox, funil e tarefas devem estar **iguais a antes** (todos veem tudo).

## 3. Ligar
Configurações → Distribuição → "Isolamento por vendedor", ou por SQL:
`update organizations set settings = settings || '{"seller_isolation_enabled": true}'::jsonb where id = '<id da organização>';`

## 4. Verificação ao vivo (obrigatória)
- **Márcio:** inbox, funil e tarefas **não** mostram a carteira da Marina; só veem o que for dele ou sem dono. O inbox em tempo real não recebe mensagens de conversas da Marina.
- **Marina:** continua vendo a carteira dela.
- **Gestor (owner):** vê tudo.
- Se algo estiver errado, desligar o interruptor (passo 5) e reportar.

## 5. Reverter
Desligar o interruptor (tela ou `update organizations set settings = settings || '{"seller_isolation_enabled": false}'::jsonb where id = '<id>';`). Nada é apagado nem alterado.

## Comportamentos a saber
- Um **vendedor não consegue passar uma conversa/negócio dele para outro vendedor** (a linha sairia da visão dele). Só o gestor transfere entre vendedores. O vendedor pode soltar (deixar sem dono) e pegar o que está sem dono.
- Durante o modo sombra da distribuição, leads novos têm dono "legado" (conta compartilhada) e ficam visíveis aos dois vendedores.
- API e worker usam chave de serviço e ignoram RLS (não são afetados).
```

- [ ] **Step 5: Verificação final**

Run: `pnpm build --filter=@aula-agente/shared --filter=@aula-agente/database && pnpm --filter @aula-agente/database exec vitest run && pnpm --filter @aula-agente/web exec tsc --noEmit`
Expected: tudo passa.

- [ ] **Step 6: Commit (sem push)**

```bash
git add packages/shared/src/types/organization.ts "apps/web/src/app/(dashboard)/settings/page.tsx" scripts/build-seller-isolation-sql.sh docs/runbook-isolamento-vendedor.md
git commit -m "feat(rls): seller isolation switch, SQL bundle script and runbook"
```

---

## Self-Review

**1. Cobertura da spec:** regra e funções (Tasks 2); políticas de conversas e dependentes (Task 3); negócios, tarefas, eventos e contatos (Task 4); interruptor, sem vendedores, outra organização (Tasks 2 e 5); desempenho (Task 5); índices (Task 2); realtime (herda RLS do Supabase; verificação ao vivo no runbook, seção 4); rollback por interruptor (Task 6 runbook); `conversation_reads` sem alteração justificada e testada (Task 3).
**Desvios da spec registrados:** `conversation_reads` não recebe política nova (as existentes já protegem; há teste). O vendedor **não** pode transferir uma conversa/negócio dele a outro vendedor (spec 5 já previa); documentado no runbook.
**2. Placeholders:** nenhum "TBD/TODO". Pontos que dependem do PGlite (`affectedRows`) têm instrução explícita de ajuste só do helper do teste.
**3. Consistência de tipos:** `World`, `createRlsDb`, `asUser`, `seedWorld`, `visible` definidos na Task 1 e usados nas Tasks 2 a 5; nomes de migrations idênticos em Global Constraints, harness, script e runbook.
**4. Review Focus:** as seis entradas têm teste nas tasks indicadas (contato: Task 4; transferência: Tasks 3 e 4; sem vendedores/interruptor/outra organização: Task 5; conflito de tarefa: Task 4; agent sem `sales_reps`: Task 2; desempenho: Task 5).
