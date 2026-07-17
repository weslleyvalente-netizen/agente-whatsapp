# CRM ↔ Agente WhatsApp Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toda vez que um contato novo escreve pela primeira vez para uma organização no aula-agente, ele aparece automaticamente como `contact` (+ uma `activity` de log) no CRM que compartilha o mesmo projeto Supabase.

**Architecture:** Renomeia a tabela `contacts` do aula-agente para `wa_contacts` (resolve a colisão de nome com o `contacts` do CRM). Um módulo novo (`apps/api/src/integrations/crm-sync.ts`) escreve diretamente nas tabelas `contacts`/`activities` do CRM via o mesmo cliente admin (service role) já usado pelo aula-agente, casando por telefone. É chamado de forma síncrona, mas nunca lança exceção, a partir do handler do webhook da Evolution API, logo depois que uma nova conversa é garantida (`ensureConversation`).

**Tech Stack:** TypeScript, Fastify (`apps/api`), Supabase (Postgres + PostgREST), `@supabase/supabase-js`, Vitest (testes), pnpm workspaces + Turborepo.

## Global Constraints

- Monorepo pnpm workspaces + Turborepo, Node 20 (`.nvmrc`), TypeScript `strict: true` em todos os pacotes.
- O projeto Supabase remoto `fwwulkmriqkrzozcsqnx` (nome interno "crm-login-dashboard") já está linkado neste diretório via Supabase CLI. As migrations `00001` e `00002` já foram aplicadas nesse banco; `00003` em diante ainda não.
- Qualquer comando `supabase` neste plano precisa de `SUPABASE_ACCESS_TOKEN` exportado no shell (gerado em https://supabase.com/dashboard/account/tokens). **Nunca** commitar esse token em nenhum arquivo.
- Não alterar a estrutura das tabelas do CRM (`contacts`, `deals`, `activities`, `profiles`) — só ler/escrever usando as colunas que já existem hoje.
- `SUPABASE_SERVICE_ROLE_KEY` real ainda não está configurada no `.env` da raiz (hoje é um placeholder). Os testes automatizados (Task 3) usam o cliente Supabase mockado e não dependem dela; os passos de verificação manual "ao vivo" (Task 1 e apêndice da Task 4) precisam da chave real.
- `packages/database` publica via `dist/index.js` (`main` no `package.json`) — depois de editar `packages/database/src/**`, é preciso rodar `pnpm --filter @aula-agente/database build` para que `apps/api`, `apps/worker` e `apps/web` enxerguem a mudança.
- Deploy final roda numa VPS gerenciada por EasyPanel (o worker/api já sobem como serviço Docker via `Dockerfile.worker`/`docker-compose.yml`). Variáveis de ambiente novas precisam ser cadastradas lá também — isso é coberto no apêndice da Task 4, não bloqueia o desenvolvimento local.

---

### Task 1: Renomear `contacts` → `wa_contacts` no schema e aplicar no Supabase remoto

**Files:**
- Modify: `.gitignore`
- Modify (commit pendente): `supabase/migrations/00002_organizations.sql`, `00003_contacts.sql`, `00004_agents.sql`, `00005_evolution_instances.sql`, `00006_knowledge.sql`, `00007_conversations.sql` (fix já aplicado ao banco remoto numa sessão anterior de debug, ainda não commitado)
- Rename: `supabase/migrations/00003_contacts.sql` → `supabase/migrations/00003_wa_contacts.sql`
- Modify: `supabase/migrations/00007_conversations.sql`
- Modify: `supabase/migrations/00008_rls_policies.sql`

**Interfaces:**
- Produces: tabela `wa_contacts(id, organization_id, phone, name, photo_url, metadata, created_at, updated_at)` no schema `public`, com `UNIQUE(organization_id, phone)` — mesma estrutura que `contacts` tinha antes, só o nome muda. `conversations.contact_id` passa a referenciar `wa_contacts(id)`.

- [ ] **Step 1: Commitar o fix pendente de `uuid_generate_v4` (sessão anterior) e ignorar o cache local do Supabase CLI**

Esse fix (qualificar `uuid_generate_v4()` como `extensions.uuid_generate_v4()`) já foi aplicado ao banco remoto numa sessão de debug anterior, mas nunca foi commitado. Commitar antes de continuar para não misturar as duas mudanças no mesmo commit.

Adicione ao final de `.gitignore`:

```
supabase/.temp/
```

Rode:

```bash
git add .gitignore supabase/migrations/00002_organizations.sql supabase/migrations/00003_contacts.sql supabase/migrations/00004_agents.sql supabase/migrations/00005_evolution_instances.sql supabase/migrations/00006_knowledge.sql supabase/migrations/00007_conversations.sql
git commit -m "fix: qualify uuid_generate_v4() with extensions schema in migrations"
```

- [ ] **Step 2: Renomear o arquivo de migration e seu conteúdo**

```bash
git mv supabase/migrations/00003_contacts.sql supabase/migrations/00003_wa_contacts.sql
```

Substitua todo o conteúdo de `supabase/migrations/00003_wa_contacts.sql` por:

```sql
CREATE TABLE wa_contacts (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone text NOT NULL,
  name text,
  photo_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, phone)
);

CREATE INDEX idx_wa_contacts_org_phone ON wa_contacts(organization_id, phone);

CREATE TRIGGER trg_wa_contacts_updated_at
  BEFORE UPDATE ON wa_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 3: Atualizar a FK em `00007_conversations.sql`**

Em `supabase/migrations/00007_conversations.sql`, troque:

```sql
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
```

por:

```sql
  contact_id uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
```

- [ ] **Step 4: Atualizar as RLS policies em `00008_rls_policies.sql`**

Troque:

```sql
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
```

por:

```sql
ALTER TABLE wa_contacts ENABLE ROW LEVEL SECURITY;
```

E no `DO $$ ... FOREACH tbl IN ARRAY ARRAY[...]` mais abaixo no mesmo arquivo, troque:

```sql
  FOREACH tbl IN ARRAY ARRAY[
    'contacts', 'agents', 'evolution_instances',
```

por:

```sql
  FOREACH tbl IN ARRAY ARRAY[
    'wa_contacts', 'agents', 'evolution_instances',
```

- [ ] **Step 5: Aplicar as migrations pendentes no Supabase remoto**

```bash
export SUPABASE_ACCESS_TOKEN=<seu access token do Supabase>
cd "/Users/weslleyvalente/Agente IA/superpowers"
npx supabase db push --yes
```

Expected: aplica `00003_wa_contacts.sql` até `00009_functions.sql` sem erro (a saída lista cada arquivo com "Applying migration ..." e termina sem `ERROR`).

- [ ] **Step 6: Verificar no banco que `wa_contacts` existe e `contacts`/`activities`/`deals`/`profiles` do CRM continuam intactos**

```bash
npx supabase db query --linked "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('wa_contacts','contacts','deals','activities','profiles') ORDER BY table_name;"
```

Expected: as 5 linhas aparecem (`activities`, `contacts`, `deals`, `profiles`, `wa_contacts`).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/00003_wa_contacts.sql supabase/migrations/00007_conversations.sql supabase/migrations/00008_rls_policies.sql
git commit -m "feat: rename aula-agente contacts table to wa_contacts to avoid CRM collision"
```

---

### Task 2: Atualizar o código da aplicação para usar `wa_contacts`

**Files:**
- Modify: `packages/database/src/queries/contacts.ts`
- Modify: `packages/database/src/queries/conversations.ts`
- Modify: `apps/api/src/routes/messages/send.ts`
- Modify: `apps/worker/src/workers/process-message.ts`
- Modify: `apps/web/src/app/(dashboard)/inbox/page.tsx`
- Modify: `apps/web/src/components/inbox/chat-panel.tsx`
- Modify: `apps/web/src/components/inbox/conversation-list.tsx`
- Modify: `apps/web/src/components/inbox/side-panel.tsx`

**Interfaces:**
- Consumes: tabela `wa_contacts` criada na Task 1.
- Produces: `upsertContact`/`getContactById` (mesmas assinaturas de antes, só a tabela interna muda); embeds do Supabase (`select("*, wa_contacts(...)")`) agora retornam a propriedade `wa_contacts` em vez de `contacts` em qualquer linha de `conversations`.

- [ ] **Step 1: Atualizar `packages/database/src/queries/contacts.ts`**

Troque as duas ocorrências de `.from("contacts")` por `.from("wa_contacts")`. Conteúdo final do arquivo:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "@aula-agente/shared";

export async function upsertContact(
  client: SupabaseClient,
  organizationId: string,
  phone: string,
  name: string | null,
  photoUrl: string | null
) {
  const { data, error } = await client
    .from("wa_contacts")
    .upsert(
      {
        organization_id: organizationId,
        phone,
        name,
        photo_url: photoUrl,
      },
      { onConflict: "organization_id,phone" }
    )
    .select()
    .single();
  if (error) throw error;
  return data as Contact;
}

export async function getContactById(client: SupabaseClient, id: string) {
  const { data, error } = await client.from("wa_contacts").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Contact;
}
```

- [ ] **Step 2: Atualizar os embeds em `packages/database/src/queries/conversations.ts`**

Em `getConversationsByOrganization`, troque:

```typescript
    .from("conversations")
    .select("*, contacts(*)")
```

por:

```typescript
    .from("conversations")
    .select("*, wa_contacts(*)")
```

Em `getConversationById`, troque:

```typescript
    .from("conversations")
    .select("*, contacts(*), agents(name)")
```

por:

```typescript
    .from("conversations")
    .select("*, wa_contacts(*), agents(name)")
```

- [ ] **Step 3: Rebuild do pacote `@aula-agente/database`**

```bash
pnpm --filter @aula-agente/database build
```

Expected: termina sem erro, gera/atualiza `packages/database/dist/`.

- [ ] **Step 4: Atualizar `apps/api/src/routes/messages/send.ts`**

Troque:

```typescript
      // Get contact phone from conversation
      const contact = conversation.contacts;
```

por:

```typescript
      // Get contact phone from conversation
      const contact = conversation.wa_contacts;
```

- [ ] **Step 5: Atualizar `apps/worker/src/workers/process-message.ts`**

Troque:

```typescript
          phone: conversation.contacts?.phone || "",
```

por:

```typescript
          phone: conversation.wa_contacts?.phone || "",
```

- [ ] **Step 6: Atualizar `apps/web/src/app/(dashboard)/inbox/page.tsx`**

Troque:

```typescript
      .select("*, contacts(phone, name), agents(name)")
```

por:

```typescript
      .select("*, wa_contacts(phone, name), agents(name)")
```

Troque:

```typescript
      c.contacts?.name?.toLowerCase().includes(searchLower) ||
      c.contacts?.phone?.includes(search)
```

por:

```typescript
      c.wa_contacts?.name?.toLowerCase().includes(searchLower) ||
      c.wa_contacts?.phone?.includes(search)
```

- [ ] **Step 7: Atualizar `apps/web/src/components/inbox/chat-panel.tsx`**

Troque:

```typescript
      .select("*, contacts(phone, name)")
```

por:

```typescript
      .select("*, wa_contacts(phone, name)")
```

Troque:

```typescript
            {conversation?.contacts?.name || conversation?.contacts?.phone || "Conversa"}
          </p>
          <p className="text-xs text-muted-foreground">{conversation?.contacts?.phone}</p>
```

por:

```typescript
            {conversation?.wa_contacts?.name || conversation?.wa_contacts?.phone || "Conversa"}
          </p>
          <p className="text-xs text-muted-foreground">{conversation?.wa_contacts?.phone}</p>
```

- [ ] **Step 8: Atualizar `apps/web/src/components/inbox/conversation-list.tsx`**

Troque a interface:

```typescript
  contacts: {
    phone: string;
    name: string | null;
  };
```

por:

```typescript
  wa_contacts: {
    phone: string;
    name: string | null;
  };
```

Troque:

```typescript
              {conv.contacts.name?.[0]?.toUpperCase() || <User className="h-4 w-4" />}
```

por:

```typescript
              {conv.wa_contacts.name?.[0]?.toUpperCase() || <User className="h-4 w-4" />}
```

Troque:

```typescript
                {conv.contacts.name || conv.contacts.phone}
```

por:

```typescript
                {conv.wa_contacts.name || conv.wa_contacts.phone}
```

- [ ] **Step 9: Atualizar `apps/web/src/components/inbox/side-panel.tsx`**

Troque a interface:

```typescript
    contacts: { phone: string; name: string | null };
```

por:

```typescript
    wa_contacts: { phone: string; name: string | null };
```

Troque:

```typescript
        <p className="text-sm">{conversation.contacts.name || "Sem nome"}</p>
        <p className="text-xs text-muted-foreground">{conversation.contacts.phone}</p>
```

por:

```typescript
        <p className="text-sm">{conversation.wa_contacts.name || "Sem nome"}</p>
        <p className="text-xs text-muted-foreground">{conversation.wa_contacts.phone}</p>
```

- [ ] **Step 10: Typecheck de todos os pacotes tocados**

```bash
pnpm --filter @aula-agente/database typecheck
pnpm --filter @aula-agente/api typecheck
pnpm --filter @aula-agente/worker typecheck
pnpm --filter @aula-agente/web typecheck
```

Expected: os 4 comandos terminam sem erro.

- [ ] **Step 11: Grep de segurança — nenhuma referência solta a `contacts` do aula-agente sobrou**

```bash
grep -rn '\.from("contacts")\|contacts(\*)\|contacts(phone' apps packages --include="*.ts" --include="*.tsx"
```

Expected: nenhum resultado (a única tabela chamada `contacts` que sobra no projeto é a do CRM, referenciada só no novo módulo da Task 3/4).

- [ ] **Step 12: Commit**

```bash
git add packages/database/src apps/api/src/routes/messages/send.ts apps/worker/src/workers/process-message.ts apps/web/src/app/"(dashboard)"/inbox/page.tsx apps/web/src/components/inbox/chat-panel.tsx apps/web/src/components/inbox/conversation-list.tsx apps/web/src/components/inbox/side-panel.tsx
git commit -m "refactor: update all consumers to use wa_contacts instead of contacts"
```

---

### Task 3: Implementar `syncContactToCrm` com testes (TDD)

**Files:**
- Create: `apps/api/src/integrations/crm-sync.ts`
- Test: `apps/api/src/integrations/crm-sync.test.ts`
- Modify: `apps/api/package.json`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `getAdminClient()` de `@aula-agente/database` (já existe, lê `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` do `process.env`).
- Produces: `syncContactToCrm(contact: { id: string; organization_id: string; phone: string; name: string | null }): Promise<void>` — nunca lança exceção, só loga erro via `console.error`. Usado pela Task 4.

- [ ] **Step 1: Adicionar Vitest ao `apps/api`**

Substitua todo o conteúdo de `apps/api/package.json` por:

```json
{
  "name": "@aula-agente/api",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "echo 'no lint configured'"
  },
  "dependencies": {
    "fastify": "^5.2.0",
    "@fastify/cors": "^11.0.0",
    "@fastify/multipart": "^9.0.0",
    "dotenv": "^16.4.0",
    "@supabase/supabase-js": "^2.49.0",
    "@aula-agente/shared": "workspace:*",
    "@aula-agente/database": "workspace:*",
    "@aula-agente/queue": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0",
    "vitest": "^3.0.0"
  }
}
```

```bash
pnpm install
```

Expected: instala o vitest em `apps/api` sem erro.

- [ ] **Step 2: Documentar a nova env var**

Em `.env.example`, adicione ao final do bloco `# App`:

```
CRM_SYNC_ORGANIZATION_ID=your-organization-id
```

- [ ] **Step 3: Escrever os testes (vão falhar — `crm-sync.ts` ainda não existe)**

Crie `apps/api/src/integrations/crm-sync.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getAdminClient } = vi.hoisted(() => ({ getAdminClient: vi.fn() }));

vi.mock("@aula-agente/database", () => ({ getAdminClient }));

import { syncContactToCrm } from "./crm-sync.js";

const baseContact = {
  id: "wa-contact-1",
  organization_id: "org-1",
  phone: "5511999998888",
  name: "Maria",
};

describe("syncContactToCrm", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRM_SYNC_ORGANIZATION_ID = "org-1";
  });

  afterEach(() => {
    delete process.env.CRM_SYNC_ORGANIZATION_ID;
  });

  it("creates a new CRM contact and activity when no match exists by phone", async () => {
    const insertActivity = vi.fn().mockResolvedValue({ error: null });
    const insertContact = vi.fn(() => ({
      select: () => ({
        single: () => Promise.resolve({ data: { id: "crm-contact-1" }, error: null }),
      }),
    }));
    const from = vi.fn((table: string) => {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
          insert: insertContact,
        };
      }
      if (table === "activities") {
        return { insert: insertActivity };
      }
      throw new Error(`unexpected table ${table}`);
    });

    getAdminClient.mockReturnValue({ from });

    await syncContactToCrm(baseContact);

    expect(insertContact).toHaveBeenCalledWith({ name: "Maria", phone: "5511999998888" });
    expect(insertActivity).toHaveBeenCalledWith({
      contact_id: "crm-contact-1",
      title: "Novo contato via WhatsApp",
      done: false,
    });
  });

  it("reuses an existing CRM contact matched by phone instead of creating a new one", async () => {
    const insertActivity = vi.fn().mockResolvedValue({ error: null });
    const insertContact = vi.fn();
    const from = vi.fn((table: string) => {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { id: "crm-contact-existing" }, error: null }),
            }),
          }),
          insert: insertContact,
        };
      }
      if (table === "activities") {
        return { insert: insertActivity };
      }
      throw new Error(`unexpected table ${table}`);
    });

    getAdminClient.mockReturnValue({ from });

    await syncContactToCrm(baseContact);

    expect(insertContact).not.toHaveBeenCalled();
    expect(insertActivity).toHaveBeenCalledWith({
      contact_id: "crm-contact-existing",
      title: "Novo contato via WhatsApp",
      done: false,
    });
  });

  it("does nothing for contacts outside the configured sync organization", async () => {
    const from = vi.fn();
    getAdminClient.mockReturnValue({ from });

    await syncContactToCrm({ ...baseContact, organization_id: "other-org" });

    expect(from).not.toHaveBeenCalled();
  });

  it("does nothing when CRM_SYNC_ORGANIZATION_ID is not configured", async () => {
    delete process.env.CRM_SYNC_ORGANIZATION_ID;
    const from = vi.fn();
    getAdminClient.mockReturnValue({ from });

    await syncContactToCrm(baseContact);

    expect(from).not.toHaveBeenCalled();
  });

  it("swallows errors instead of throwing to the caller", async () => {
    const from = vi.fn(() => {
      throw new Error("boom");
    });
    getAdminClient.mockReturnValue({ from });

    await expect(syncContactToCrm(baseContact)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: Rodar os testes e confirmar que falham**

```bash
pnpm --filter @aula-agente/api test
```

Expected: falha com erro do tipo `Cannot find module './crm-sync.js'` (o arquivo de implementação ainda não existe).

- [ ] **Step 5: Implementar `crm-sync.ts`**

Crie `apps/api/src/integrations/crm-sync.ts`:

```typescript
import { getAdminClient } from "@aula-agente/database";

interface ContactForCrmSync {
  id: string;
  organization_id: string;
  phone: string;
  name: string | null;
}

export async function syncContactToCrm(contact: ContactForCrmSync): Promise<void> {
  const syncOrgId = process.env.CRM_SYNC_ORGANIZATION_ID;
  if (!syncOrgId || contact.organization_id !== syncOrgId) {
    return;
  }

  try {
    const db = getAdminClient();

    const { data: existing, error: findError } = await db
      .from("contacts")
      .select("id")
      .eq("phone", contact.phone)
      .maybeSingle();

    if (findError) throw findError;

    let crmContactId: string;

    if (existing) {
      crmContactId = existing.id as string;
    } else {
      const { data: created, error: insertError } = await db
        .from("contacts")
        .insert({ name: contact.name, phone: contact.phone })
        .select("id")
        .single();

      if (insertError) throw insertError;
      crmContactId = (created as { id: string }).id;
    }

    const { error: activityError } = await db.from("activities").insert({
      contact_id: crmContactId,
      title: "Novo contato via WhatsApp",
      done: false,
    });

    if (activityError) throw activityError;
  } catch (err) {
    console.error("[crm-sync] failed to sync contact to CRM:", err);
  }
}
```

- [ ] **Step 6: Rodar os testes e confirmar que passam**

```bash
pnpm --filter @aula-agente/api test
```

Expected: os 5 testes passam (`5 passed`).

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @aula-agente/api typecheck
```

Expected: termina sem erro.

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json apps/api/src/integrations/crm-sync.ts apps/api/src/integrations/crm-sync.test.ts .env.example pnpm-lock.yaml
git commit -m "feat: add syncContactToCrm with unit tests"
```

---

### Task 4: Conectar o sync ao webhook da Evolution API

**Files:**
- Modify: `apps/api/src/routes/webhooks/evolution.ts`
- Modify: `.env` (raiz, não commitado — `.env` está no `.gitignore`)

**Interfaces:**
- Consumes: `syncContactToCrm` (Task 3), `ensureConversation` (já existente em `apps/api/src/services/conversation.service.ts`, retorna `{ conversation, contact, isNew }`).
- Produces: contato/atividade criados no CRM sempre que uma nova conversa é aberta para a organização configurada em `CRM_SYNC_ORGANIZATION_ID`.

- [ ] **Step 1: Chamar `syncContactToCrm` no handler do webhook**

Em `apps/api/src/routes/webhooks/evolution.ts`, adicione o import:

```typescript
import { ensureConversation } from "../../services/conversation.service.js";
import { saveMessage } from "../../services/message.service.js";
import { enqueueProcessMessage } from "../../lib/queue.js";
import { syncContactToCrm } from "../../integrations/crm-sync.js";
```

Troque:

```typescript
      // Ensure conversation exists
      const { conversation } = await ensureConversation({
        organizationId,
        agentId,
        instanceId: instance.id,
        phone,
        contactName,
        contactPhotoUrl: null,
      });
```

por:

```typescript
      // Ensure conversation exists
      const { conversation, contact, isNew } = await ensureConversation({
        organizationId,
        agentId,
        instanceId: instance.id,
        phone,
        contactName,
        contactPhotoUrl: null,
      });

      // Best-effort: mirror brand-new contacts into the CRM. Never blocks
      // or fails the webhook — errors are swallowed inside syncContactToCrm.
      if (isNew) {
        await syncContactToCrm(contact);
      }
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @aula-agente/api typecheck
```

Expected: termina sem erro.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/webhooks/evolution.ts
git commit -m "feat: sync new WhatsApp contacts into the CRM on first conversation"
```

---

## Apêndice: verificação manual ao vivo (rodar quando `SUPABASE_SERVICE_ROLE_KEY` real e uma organização/agente/instância já existirem)

Isso não é um passo bloqueante do plano — é uma checklist para quando você tiver passado pelo `/onboarding` (criado sua organização) e configurado a `SUPABASE_SERVICE_ROLE_KEY` real no `.env`. Sem isso, os comandos abaixo não têm o que testar.

1. Descubra o `organization_id` da sua organização e defina as env vars locais:

```bash
npx supabase db query --linked "SELECT id, name FROM organizations;"
```

Adicione ao `.env` da raiz (e ao `.env` que o `apps/api` carrega em dev):

```
CRM_SYNC_ORGANIZATION_ID=<id retornado acima>
```

2. Crie um agente e uma `evolution_instance` mínimos para essa organização (se ainda não existirem, via SQL direto ou pela UI em `/agents` e `/instances`).

3. Suba a API (`pnpm --filter @aula-agente/api dev`) e envie um webhook fake simulando uma mensagem nova:

```bash
curl -X POST http://localhost:3001/webhooks/evolution \
  -H "Content-Type: application/json" \
  -H "apikey: $(grep '^WEBHOOK_SECRET=' .env | cut -d= -f2)" \
  -d '{
    "event": "messages.upsert",
    "instance": "<instance_id da evolution_instances>",
    "data": {
      "key": { "remoteJid": "5511999998888@s.whatsapp.net", "fromMe": false, "id": "test-msg-1" },
      "message": { "conversation": "Oi, quero saber mais" },
      "messageType": "conversation",
      "pushName": "Maria Teste"
    }
  }'
```

4. Confirme que o contato apareceu no CRM:

```bash
npx supabase db query --linked "SELECT c.name, c.phone, a.title FROM contacts c JOIN activities a ON a.contact_id = c.id WHERE c.phone = '5511999998888';"
```

Expected: uma linha com `name = 'Maria Teste'`, `phone = '5511999998888'`, `title = 'Novo contato via WhatsApp'`.

5. Limpe os dados de teste:

```bash
npx supabase db query --linked "DELETE FROM activities WHERE title = 'Novo contato via WhatsApp' AND contact_id IN (SELECT id FROM contacts WHERE phone = '5511999998888'); DELETE FROM contacts WHERE phone = '5511999998888'; DELETE FROM wa_contacts WHERE phone = '5511999998888';"
```

## Apêndice: EasyPanel (deploy)

Depois que este plano estiver implementado e testado localmente, cadastre no serviço `worker`/`api` do EasyPanel (junto das env vars que já devem existir lá — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL` etc.):

```
CRM_SYNC_ORGANIZATION_ID=<mesmo id usado em produção>
```

Sem isso, `syncContactToCrm` roda em produção mas sempre entra no caminho "organização fora de escopo" e não sincroniza nada — falha silenciosa por design, não trava a aplicação.
