# Central de Configuração da Helena — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Helena's single `agents.system_prompt` free-text field with a modular, versioned configuration (Identidade/Personalidade/Regras/Conhecimento/Playbooks/Ferramentas), a pure Prompt Builder that compiles it, a transactional Draft → Publish → Version cycle, and a Playground that tests the draft with sandboxed tools — without ever changing the shape or runtime read path of the `agents` table.

**Architecture:** Two new tables (`agent_configs` = current draft, `agent_versions` = append-only published snapshots) plus a Playground pair (`agent_playground_sessions`/`_messages`). A pure `compileSystemPrompt()` function in `packages/shared` turns the draft into the same kind of text `agents.system_prompt` holds today. Publishing is one atomic Postgres function (`publish_agent_config`) that writes `agents`, inserts a version, and updates the draft's `base_version_id` together or not at all. `apps/worker`'s `agent-runner.ts` and its tools move into a new `packages/agent-runtime` package so `apps/api` can reuse the exact same LLM-calling code for the Playground, in sandbox mode, without duplicating it.

**Tech Stack:** Next.js 16 (App Router) + React 19 + Tailwind + `@base-ui/react` components in `apps/web`; Fastify in `apps/api`; BullMQ worker in `apps/worker`; Supabase/Postgres (pgvector) via `packages/database`; Vercel AI SDK (`ai`, `@ai-sdk/*`) for LLM calls; Zod + `react-hook-form` for forms; Vitest for tests (`pnpm --filter <package> test` runs `vitest run`).

## Global Constraints

- `agents` table (`supabase/migrations/00004_agents.sql`) keeps its exact current shape — no new columns, no dropped columns, no changed defaults. It is written to ONLY by `publish_agent_config`.
- `apps/worker/src/agents/agent-runner.ts`'s `buildSystemPrompt(basePrompt, now)` behavior does not change: it still just appends the date/time line (`formatDateTimeForPrompt`) to whatever text it's given. Compilation of the modular config into that text happens once, at publish time — never at runtime per-message.
- The 4 existing tools (`search_knowledge`, `search_faq`, `send_catalog_photo`, `create_task`) keep their exact current `tools_config` boolean-flag shape and real-path behavior. `agent-runner.test.ts` and `search-catalog.test.ts` must still pass unchanged after any refactor.
- `agent_versions` is append-only: no UPDATE or DELETE RLS policy is ever created for it, for any role. Restoring a version copies its snapshot into the draft — it never modifies or removes the version row.
- The Playground never causes a real side effect: `create_task` and `send_catalog_photo` run as mocks when `sandbox: true`; `search_knowledge`/`search_faq`/`search_catalog` stay real (read-only, safe) in sandbox mode too.
- `is_active` is written immediately, outside the draft/publish cycle (it's an operational safety toggle, not a content change).
- No handoff/transfer-to-human tool is created. The corresponding rules module (`transferencia_para_humano`) is instructional text only, compiled into the prompt like any other rule.
- No classification of the current `system_prompt` into sections is ever applied automatically — the import-suggestion endpoint only returns a proposal; a human click applies it to the draft via the normal PATCH endpoint.
- RLS on every new table follows the existing `get_user_org_ids()` pattern from `supabase/migrations/00008_rls_policies.sql`.
- Out of scope this round (per approved spec): Trainer conversacional, MCP, sub-agentes, Instagram, e-mail, rotinas, automações genéricas, analytics avançado.
- Test command per package: `pnpm --filter @aula-agente/<name> test` (runs `vitest run`); typecheck: `pnpm --filter @aula-agente/<name> typecheck` (runs `tsc --noEmit`).
- `apps/web` runs on a Next.js version with breaking changes vs. training data (see `apps/web/AGENTS.md`) — before writing any new file under `apps/web/src/app`, check `apps/web/node_modules/next/dist/docs/01-app/` for the current App Router conventions if anything in a step looks unfamiliar. All existing agent pages are `"use client"` components using `useParams()`/`useRouter()` from `next/navigation` (not server-component `params` props) — new pages follow the same pattern.

## File Structure

New files, grouped by package:

**`packages/shared/src/`** (types, zod schemas, pure functions — no I/O):
- `types/agent-config.ts` — `AgentConfigDraft`, `AgentVersion`, `AgentPlaygroundSession`, `AgentPlaygroundMessage`, `PlaygroundToolCall`, and all section sub-types (`AgentIdentity`, `AgentPersonality`, `AgentRules`, `AgentKnowledgeConfig`, `AgentPlaybook`, `AgentModelSettings`, plus item types `AgentRuleItem`, `AgentTypeRuleItem`, `AgentObjecao`, `AgentLinkItem`).
- `schemas/agent-config.ts` — zod schemas mirroring the above, plus `updateAgentConfigSchema` (PATCH body) and `publishAgentConfigSchema`.
- `prompt-builder.ts` — `compileSystemPrompt(config)`, pure.
- `agent-config-diff.ts` — `computeChangedSections(draft, baseSnapshot)`, pure.
- `prompt-builder.test.ts`, `agent-config-diff.test.ts`.

**`packages/database/src/queries/`**:
- `agent-configs.ts` — `getOrCreateAgentConfig`, `patchAgentConfig`, `restoreAgentConfigFromVersion`.
- `agent-versions.ts` — `getAgentVersions`, `getAgentVersionById`, `getLatestAgentVersion`, `publishAgentConfig` (RPC wrapper).
- `agent-playground.ts` — `createPlaygroundSession`, `getPlaygroundMessages`, `addPlaygroundMessage`.

**`packages/agent-runtime/`** (new workspace package — relocated from `apps/worker`, zero behavior change):
- `src/agent-runner.ts`, `src/agent-runner.test.ts` (moved from `apps/worker/src/agents/`).
- `src/tools/*.ts` (moved from `apps/worker/src/agents/tools/`, including `search-catalog.test.ts`).
- `src/vault.ts` (moved from `apps/worker/src/lib/vault.ts`).
- `src/index.ts` — package entry re-exporting everything both `apps/worker` and `apps/api` need.

**`supabase/migrations/`**:
- `00012_agent_versions.sql`, `00013_agent_configs.sql`, `00014_agent_playground.sql`, `00015_agent_config_rls.sql`, `00016_publish_agent_config_function.sql`.

**`apps/api/src/`**:
- `services/agent-config.service.ts` — `getAgentConfigWithStatus`, `publishDraft`, `discardDraft`, `listVersions`, `getVersionWithDiff`, `restoreVersion`.
- `services/playground.service.ts` — `sendPlaygroundMessage`.
- `services/import-suggestion.service.ts` — `suggestConfigFromSystemPrompt`.
- `routes/agent-config/index.ts` — all new HTTP routes, registered in `server.ts`.

**`apps/web/src/`**:
- `app/(dashboard)/agents/[agentId]/editar/page.tsx` — the new 3-column Central de Configuração.
- `app/(dashboard)/agents/[agentId]/page.tsx` — becomes a redirect to `editar/`.
- `components/agents/config/` — new folder: `list-editor.tsx`, `tag-input.tsx`, `use-agent-config.ts` (data hook), `geral-section.tsx`, `personalidade-section.tsx`, `regras-section.tsx`, `conhecimento-section.tsx`, `playbooks-section.tsx`, `ferramentas-section.tsx`, `use-playground-session.ts`, `playground-panel.tsx`, `draft-status-bar.tsx`, `publish-dialog.tsx`, `history-panel.tsx`, `import-system-prompt-dialog.tsx`.

## Task Dependency Order

Tasks execute strictly in this order — reduces production risk by building storage → pure logic → transactional write path → read APIs → sandboxed runtime path → UI → history → migration tooling → integration, exactly as requested.

---

### Task 1: Data model migrations

**Files:**
- Create: `supabase/migrations/00012_agent_versions.sql`
- Create: `supabase/migrations/00013_agent_configs.sql`
- Create: `supabase/migrations/00014_agent_playground.sql`
- Create: `supabase/migrations/00015_agent_config_rls.sql`

**Interfaces:**
- Produces: tables `agent_versions`, `agent_configs`, `agent_playground_sessions`, `agent_playground_messages` — exact columns below, consumed by every later task.

This task only creates storage — no application code reads or writes it yet, so there is nothing to break in production. **Rollback:** if any migration fails to apply, `supabase db reset` (local) or drop the 4 tables in reverse creation order (no other table references them, so no cascade risk to existing data) — `agents` and every existing table are untouched by these files.

- [ ] **Step 1: Write `00012_agent_versions.sql`**

```sql
CREATE TABLE agent_versions (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version integer NOT NULL,
  changelog text NOT NULL DEFAULT '',
  config_snapshot jsonb NOT NULL,
  compiled_system_prompt text NOT NULL,
  model_settings jsonb NOT NULL,
  tools_config jsonb NOT NULL,
  published_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);

CREATE INDEX idx_agent_versions_agent ON agent_versions(agent_id, version DESC);
```

- [ ] **Step 2: Write `00013_agent_configs.sql`**

```sql
CREATE TABLE agent_configs (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  base_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
  identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  personality jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  knowledge jsonb NOT NULL DEFAULT '{}'::jsonb,
  playbook jsonb NOT NULL DEFAULT '{}'::jsonb,
  tools_config jsonb NOT NULL DEFAULT '{"search_knowledge": true, "search_faq": true, "send_catalog_photo": true, "create_task": true}'::jsonb,
  model_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

CREATE TRIGGER trg_agent_configs_updated_at
  BEFORE UPDATE ON agent_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 3: Write `00014_agent_playground.sql`**

```sql
CREATE TABLE agent_playground_sessions (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_playground_messages (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  session_id uuid NOT NULL REFERENCES agent_playground_sessions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_playground_sessions_agent ON agent_playground_sessions(agent_id, created_at DESC);
CREATE INDEX idx_playground_messages_session ON agent_playground_messages(session_id, created_at);
```

`organization_id` is denormalized onto `agent_playground_messages` (not just reachable via `session_id`) the same way `task_events` denormalizes it alongside `task_id` in `00010_tasks.sql` — needed for the RLS policy in Step 4 to filter directly without a join.

- [ ] **Step 4: Write `00015_agent_config_rls.sql`**

`agent_versions` deliberately gets only SELECT and INSERT policies — no UPDATE, no DELETE, for any role. This is what makes "restore never erases history" true at the database level, not just by application convention.

```sql
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_playground_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_playground_messages ENABLE ROW LEVEL SECURITY;

-- Append-only: no UPDATE/DELETE policy exists for agent_versions at all,
-- so no client (present or future, admin or browser) can alter or erase
-- a published version through PostgREST/Supabase.
CREATE POLICY "agent_versions_select" ON agent_versions
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "agent_versions_insert" ON agent_versions
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'agent_configs', 'agent_playground_sessions', 'agent_playground_messages'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY "%1$s_select" ON %1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_insert" ON %1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_update" ON %1$s FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_delete" ON %1$s FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
  END LOOP;
END $$;
```

- [ ] **Step 5: Apply migrations locally and verify**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && npx supabase db reset` (or `npx supabase migration up` if a local DB is already running from earlier work).
Expected: all 4 new migrations apply cleanly with no errors; `npx supabase db diff` afterward shows no drift.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00012_agent_versions.sql supabase/migrations/00013_agent_configs.sql supabase/migrations/00014_agent_playground.sql supabase/migrations/00015_agent_config_rls.sql
git commit -m "feat: add agent_configs/agent_versions/agent_playground tables (no app code reads them yet)"
```

---

### Task 2: Shared types and zod schemas for the modular config

**Files:**
- Create: `packages/shared/src/types/agent-config.ts`
- Modify: `packages/shared/src/types/index.ts` (add export)
- Create: `packages/shared/src/schemas/agent-config.ts`
- Modify: `packages/shared/src/schemas/index.ts` (add export)

**Interfaces:**
- Consumes: `ToolsConfig`, `LLMProvider` (existing, from `packages/shared/src/types/agent.ts` and `./organization.js`), `toolsConfigSchema` (existing, from `packages/shared/src/schemas/agent.ts`).
- Produces: every type/schema name used by every later task — `AgentConfigDraft`, `AgentVersion`, `AgentPlaygroundSession`, `AgentPlaygroundMessage`, `PlaygroundToolCall`, `updateAgentConfigSchema`, `publishAgentConfigSchema`. Exact shapes below; later tasks must use these names verbatim.

- [ ] **Step 1: Check current barrel files**

Run: `cat "/Users/weslleyvalente/Agente IA/superpowers/packages/shared/src/types/index.ts"` and `cat "/Users/weslleyvalente/Agente IA/superpowers/packages/shared/src/schemas/index.ts"` to see the existing `export * from "./agent.js"` lines you'll be adding a sibling line next to.

- [ ] **Step 2: Write `packages/shared/src/types/agent-config.ts`**

```ts
import type { LLMProvider } from "./organization.js";
import type { ToolsConfig } from "./agent.js";

export type TomDeVoz = "profissional" | "equilibrado" | "amigavel" | "divertido" | "personalizado";
export type TamanhoResposta = "curta" | "media" | "detalhada";

export interface AgentIdentity {
  nome: string;
  funcao: string;
  missao: string;
}

export interface AgentEmojisConfig {
  ativo: boolean;
  maximo: number;
  instrucao: string;
}

export interface AgentPerguntasPorVezConfig {
  maximo: number;
}

export interface AgentPosturaComercialConfig {
  tipo: string;
  instrucao: string;
}

export interface AgentPersonality {
  tom_de_voz: TomDeVoz;
  tom_de_voz_personalizado: string;
  tamanho_resposta: TamanhoResposta;
  emojis: AgentEmojisConfig;
  perguntas_por_vez: AgentPerguntasPorVezConfig;
  postura_comercial: AgentPosturaComercialConfig;
  girias_proibidas: string[];
  proatividade: string;
}

export interface AgentRuleItem {
  id: string;
  label: string;
  instrucao: string;
  ativo: boolean;
}

export interface AgentTypeRuleItem {
  id: string;
  categoria: string;
  instrucao: string;
  ativo: boolean;
}

export interface AgentPrecoDesconto {
  pode_autonomo: string;
  exige_humano: string;
  nunca_pode: string;
  observacoes: string;
}

export interface AgentObjecao {
  id: string;
  nome: string;
  como_identificar: string;
  orientacao: string;
  pergunta_diagnostico: string;
  quando_escalar: string;
  ativo: boolean;
}

export interface AgentRules {
  transferencia_para_humano: AgentRuleItem[];
  promessas_proibidas: AgentRuleItem[];
  regras_por_tipo: AgentTypeRuleItem[];
  preco_desconto: AgentPrecoDesconto;
  objecoes: AgentObjecao[];
}

export interface AgentLinkItem {
  id: string;
  titulo: string;
  url: string;
  ativo: boolean;
}

export interface AgentKnowledgeConfig {
  precos_notas: string;
  links: AgentLinkItem[];
  documentos_ativos: boolean;
  faqs_ativas: boolean;
}

export interface AgentPlaybook {
  script_atendimento: string;
}

export interface AgentModelSettings {
  provider: LLMProvider;
  model: string;
  temperature: number;
  max_tokens: number;
}

export interface AgentConfigSections {
  identity: AgentIdentity;
  personality: AgentPersonality;
  rules: AgentRules;
  knowledge: AgentKnowledgeConfig;
  playbook: AgentPlaybook;
}

export interface AgentConfigDraft extends AgentConfigSections {
  id: string;
  agent_id: string;
  organization_id: string;
  base_version_id: string | null;
  tools_config: ToolsConfig;
  model_settings: AgentModelSettings;
  updated_at: string;
  updated_by: string | null;
}

export interface AgentVersion {
  id: string;
  agent_id: string;
  organization_id: string;
  version: number;
  changelog: string;
  config_snapshot: AgentConfigSections;
  compiled_system_prompt: string;
  model_settings: AgentModelSettings;
  tools_config: ToolsConfig;
  published_by: string;
  created_at: string;
}

export interface PlaygroundToolCall {
  tool_name: string;
  input: unknown;
  output: unknown;
  mode: "real" | "simulated";
  executed_at: string;
}

export interface AgentPlaygroundSession {
  id: string;
  agent_id: string;
  organization_id: string;
  created_by: string;
  created_at: string;
}

export interface AgentPlaygroundMessage {
  id: string;
  session_id: string;
  organization_id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: PlaygroundToolCall[];
  created_at: string;
}
```

- [ ] **Step 3: Add the export to `packages/shared/src/types/index.ts`**

Add this line next to the existing `export * from "./agent.js";` line:

```ts
export * from "./agent-config.js";
```

- [ ] **Step 4: Write `packages/shared/src/schemas/agent-config.ts`**

```ts
import { z } from "zod";
import { toolsConfigSchema } from "./agent.js";

export const agentIdentitySchema = z.object({
  nome: z.string().max(100).default(""),
  funcao: z.string().max(200).default(""),
  missao: z.string().max(2000).default(""),
});

export const agentEmojisConfigSchema = z.object({
  ativo: z.boolean().default(true),
  maximo: z.number().int().min(0).max(5).default(1),
  instrucao: z.string().max(500).default(""),
});

export const agentPerguntasPorVezConfigSchema = z.object({
  maximo: z.number().int().min(1).max(5).default(1),
});

export const agentPosturaComercialConfigSchema = z.object({
  tipo: z.string().max(100).default(""),
  instrucao: z.string().max(1000).default(""),
});

export const agentPersonalitySchema = z.object({
  tom_de_voz: z.enum(["profissional", "equilibrado", "amigavel", "divertido", "personalizado"]).default("equilibrado"),
  tom_de_voz_personalizado: z.string().max(500).default(""),
  tamanho_resposta: z.enum(["curta", "media", "detalhada"]).default("curta"),
  emojis: agentEmojisConfigSchema.default({ ativo: true, maximo: 1, instrucao: "" }),
  perguntas_por_vez: agentPerguntasPorVezConfigSchema.default({ maximo: 1 }),
  postura_comercial: agentPosturaComercialConfigSchema.default({ tipo: "", instrucao: "" }),
  girias_proibidas: z.array(z.string().max(100)).default([]),
  proatividade: z.string().max(2000).default(""),
});

export const agentRuleItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().max(150),
  instrucao: z.string().max(1000),
  ativo: z.boolean().default(true),
});

export const agentTypeRuleItemSchema = z.object({
  id: z.string().min(1),
  categoria: z.string().max(100),
  instrucao: z.string().max(2000),
  ativo: z.boolean().default(true),
});

export const agentPrecoDescontoSchema = z.object({
  pode_autonomo: z.string().max(2000).default(""),
  exige_humano: z.string().max(2000).default(""),
  nunca_pode: z.string().max(2000).default(""),
  observacoes: z.string().max(2000).default(""),
});

export const agentObjecaoSchema = z.object({
  id: z.string().min(1),
  nome: z.string().max(150),
  como_identificar: z.string().max(1000).default(""),
  orientacao: z.string().max(2000).default(""),
  pergunta_diagnostico: z.string().max(500).default(""),
  quando_escalar: z.string().max(500).default(""),
  ativo: z.boolean().default(true),
});

export const agentRulesSchema = z.object({
  transferencia_para_humano: z.array(agentRuleItemSchema).default([]),
  promessas_proibidas: z.array(agentRuleItemSchema).default([]),
  regras_por_tipo: z.array(agentTypeRuleItemSchema).default([]),
  preco_desconto: agentPrecoDescontoSchema.default({
    pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "",
  }),
  objecoes: z.array(agentObjecaoSchema).default([]),
});

export const agentLinkItemSchema = z.object({
  id: z.string().min(1),
  titulo: z.string().max(150),
  url: z.string().url(),
  ativo: z.boolean().default(true),
});

export const agentKnowledgeConfigSchema = z.object({
  precos_notas: z.string().max(4000).default(""),
  links: z.array(agentLinkItemSchema).default([]),
  documentos_ativos: z.boolean().default(true),
  faqs_ativas: z.boolean().default(true),
});

export const agentPlaybookSchema = z.object({
  script_atendimento: z.string().max(10000).default(""),
});

export const agentModelSettingsSchema = z.object({
  provider: z.enum(["openai", "anthropic", "google"]),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2),
  max_tokens: z.number().int().min(1).max(16384),
});

export const updateAgentConfigSchema = z.object({
  identity: agentIdentitySchema.partial().optional(),
  personality: agentPersonalitySchema.partial().optional(),
  rules: agentRulesSchema.partial().optional(),
  knowledge: agentKnowledgeConfigSchema.partial().optional(),
  playbook: agentPlaybookSchema.partial().optional(),
  tools_config: toolsConfigSchema.partial().optional(),
  model_settings: agentModelSettingsSchema.partial().optional(),
});

export const publishAgentConfigSchema = z.object({
  changelog: z.string().min(1).max(1000),
});
```

- [ ] **Step 5: Add the export to `packages/shared/src/schemas/index.ts`**

Add this line next to the existing `export * from "./agent.js";` line:

```ts
export * from "./agent-config.js";
```

- [ ] **Step 6: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/shared typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/agent-config.ts packages/shared/src/types/index.ts packages/shared/src/schemas/agent-config.ts packages/shared/src/schemas/index.ts
git commit -m "feat(shared): add types and zod schemas for the modular agent config"
```

---

### Task 3: Database queries for configs, versions, and playground

**Files:**
- Create: `packages/database/src/queries/agent-configs.ts`
- Create: `packages/database/src/queries/agent-versions.ts`
- Create: `packages/database/src/queries/agent-playground.ts`
- Modify: `packages/database/src/queries/index.ts` (add 3 exports)

**Interfaces:**
- Consumes: `AgentConfigDraft`, `AgentVersion`, `AgentPlaygroundSession`, `AgentPlaygroundMessage`, `PlaygroundToolCall` (Task 2), `Agent` (existing, `packages/shared/src/types/agent.ts`).
- Produces: `getOrCreateAgentConfig(client, agent)`, `patchAgentConfig(client, agentId, patch, updatedBy)`, `restoreAgentConfigFromVersion(client, agentId, version)`, `getAgentVersions(client, agentId)`, `getAgentVersionById(client, versionId)`, `getLatestAgentVersion(client, agentId)`, `publishAgentConfig(client, params)`, `createPlaygroundSession(client, params)`, `getPlaygroundMessages(client, sessionId)`, `addPlaygroundMessage(client, params)` — every later backend task calls these by exact name.

This task only adds new functions — no existing query file is modified, so nothing already in production can regress. `publishAgentConfig` calls a Postgres function (`publish_agent_config`) that does not exist until Task 5; this task's own test mocks the RPC call, so it does not depend on Task 5 being done first, but this function is not actually invoked from `apps/api` until Task 5.

- [ ] **Step 1: Write `packages/database/src/queries/agent-configs.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, AgentConfigDraft, AgentVersion } from "@aula-agente/shared";

function defaultConfigSections() {
  return {
    identity: { nome: "", funcao: "", missao: "" },
    personality: {
      tom_de_voz: "equilibrado" as const,
      tom_de_voz_personalizado: "",
      tamanho_resposta: "curta" as const,
      emojis: { ativo: true, maximo: 1, instrucao: "" },
      perguntas_por_vez: { maximo: 1 },
      postura_comercial: { tipo: "", instrucao: "" },
      girias_proibidas: [] as string[],
      proatividade: "",
    },
    rules: {
      transferencia_para_humano: [],
      promessas_proibidas: [],
      regras_por_tipo: [],
      preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" },
      objecoes: [],
    },
    knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
    playbook: { script_atendimento: "" },
  };
}

export async function getOrCreateAgentConfig(
  client: SupabaseClient,
  agent: Agent
): Promise<AgentConfigDraft> {
  const { data: existing, error: fetchError } = await client
    .from("agent_configs")
    .select("*")
    .eq("agent_id", agent.id)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (existing) return existing as AgentConfigDraft;

  // Lazy-seeded on first access: identity/personality/rules/knowledge/playbook
  // start empty (filled in later via the import-suggestion flow or manual
  // editing), but model_settings/tools_config are copied from the agent's
  // current published values since those are already structured data with
  // no need for a suggestion step.
  const { data: created, error: insertError } = await client
    .from("agent_configs")
    .insert({
      agent_id: agent.id,
      organization_id: agent.organization_id,
      base_version_id: null,
      ...defaultConfigSections(),
      tools_config: agent.tools_config,
      model_settings: {
        provider: agent.provider,
        model: agent.model,
        temperature: agent.temperature,
        max_tokens: agent.max_tokens,
      },
    })
    .select()
    .single();
  if (insertError) throw insertError;
  return created as AgentConfigDraft;
}

type ConfigPatch = Partial<
  Pick<AgentConfigDraft, "identity" | "personality" | "rules" | "knowledge" | "playbook" | "tools_config" | "model_settings">
>;

export async function patchAgentConfig(
  client: SupabaseClient,
  agentId: string,
  patch: ConfigPatch,
  updatedBy: string
): Promise<AgentConfigDraft> {
  const { data, error } = await client
    .from("agent_configs")
    .update({ ...patch, updated_by: updatedBy })
    .eq("agent_id", agentId)
    .select()
    .single();
  if (error) throw error;
  return data as AgentConfigDraft;
}

export async function restoreAgentConfigFromVersion(
  client: SupabaseClient,
  agentId: string,
  version: AgentVersion
): Promise<AgentConfigDraft> {
  const { data, error } = await client
    .from("agent_configs")
    .update({
      base_version_id: version.id,
      identity: version.config_snapshot.identity,
      personality: version.config_snapshot.personality,
      rules: version.config_snapshot.rules,
      knowledge: version.config_snapshot.knowledge,
      playbook: version.config_snapshot.playbook,
      tools_config: version.tools_config,
      model_settings: version.model_settings,
    })
    .eq("agent_id", agentId)
    .select()
    .single();
  if (error) throw error;
  return data as AgentConfigDraft;
}
```

- [ ] **Step 2: Write `packages/database/src/queries/agent-versions.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentVersion } from "@aula-agente/shared";

export async function getAgentVersions(client: SupabaseClient, agentId: string): Promise<AgentVersion[]> {
  const { data, error } = await client
    .from("agent_versions")
    .select("*")
    .eq("agent_id", agentId)
    .order("version", { ascending: false });
  if (error) throw error;
  return data as AgentVersion[];
}

export async function getAgentVersionById(client: SupabaseClient, versionId: string): Promise<AgentVersion> {
  const { data, error } = await client
    .from("agent_versions")
    .select("*")
    .eq("id", versionId)
    .single();
  if (error) throw error;
  return data as AgentVersion;
}

export async function getLatestAgentVersion(
  client: SupabaseClient,
  agentId: string
): Promise<AgentVersion | null> {
  const { data, error } = await client
    .from("agent_versions")
    .select("*")
    .eq("agent_id", agentId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as AgentVersion | null;
}

export interface PublishAgentConfigParams {
  agentId: string;
  changelog: string;
  compiledSystemPrompt: string;
  configSnapshot: AgentVersion["config_snapshot"];
  modelSettings: AgentVersion["model_settings"];
  toolsConfig: AgentVersion["tools_config"];
  publishedBy: string;
}

// Calls the publish_agent_config Postgres function (created in Task 5),
// which updates `agents`, inserts this row, and updates agent_configs'
// base_version_id all inside one implicit plpgsql transaction — see
// 00016_publish_agent_config_function.sql for the atomicity guarantee.
export async function publishAgentConfig(
  client: SupabaseClient,
  params: PublishAgentConfigParams
): Promise<AgentVersion> {
  const { data, error } = await client.rpc("publish_agent_config", {
    p_agent_id: params.agentId,
    p_changelog: params.changelog,
    p_compiled_prompt: params.compiledSystemPrompt,
    p_config_snapshot: params.configSnapshot,
    p_model_settings: params.modelSettings,
    p_tools_config: params.toolsConfig,
    p_published_by: params.publishedBy,
  });
  if (error) throw error;
  return data as AgentVersion;
}
```

- [ ] **Step 3: Write `packages/database/src/queries/agent-playground.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentPlaygroundSession, AgentPlaygroundMessage, PlaygroundToolCall } from "@aula-agente/shared";

export async function createPlaygroundSession(
  client: SupabaseClient,
  params: { agentId: string; organizationId: string; createdBy: string }
): Promise<AgentPlaygroundSession> {
  const { data, error } = await client
    .from("agent_playground_sessions")
    .insert({ agent_id: params.agentId, organization_id: params.organizationId, created_by: params.createdBy })
    .select()
    .single();
  if (error) throw error;
  return data as AgentPlaygroundSession;
}

export async function getPlaygroundMessages(
  client: SupabaseClient,
  sessionId: string
): Promise<AgentPlaygroundMessage[]> {
  const { data, error } = await client
    .from("agent_playground_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as AgentPlaygroundMessage[];
}

export async function addPlaygroundMessage(
  client: SupabaseClient,
  params: {
    sessionId: string;
    organizationId: string;
    role: "user" | "assistant";
    content: string;
    toolCalls?: PlaygroundToolCall[];
  }
): Promise<AgentPlaygroundMessage> {
  const { data, error } = await client
    .from("agent_playground_messages")
    .insert({
      session_id: params.sessionId,
      organization_id: params.organizationId,
      role: params.role,
      content: params.content,
      tool_calls: params.toolCalls ?? [],
    })
    .select()
    .single();
  if (error) throw error;
  return data as AgentPlaygroundMessage;
}
```

- [ ] **Step 4: Add exports to `packages/database/src/queries/index.ts`**

Add these 3 lines next to the existing `export * from "./tasks.js";` line:

```ts
export * from "./agent-configs.js";
export * from "./agent-versions.js";
export * from "./agent-playground.js";
```

- [ ] **Step 5: Typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/database typecheck`
Expected: no errors. (`publish_agent_config` is called via `.rpc()`, a stringly-typed Supabase call — it does not need the Postgres function to exist yet for TypeScript to accept it.)

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/queries/agent-configs.ts packages/database/src/queries/agent-versions.ts packages/database/src/queries/agent-playground.ts packages/database/src/queries/index.ts
git commit -m "feat(database): add queries for agent draft config, versions, and playground"
```

---

### Task 4: Prompt Builder + diff helper + unit tests

**Files:**
- Create: `packages/shared/src/prompt-builder.ts`
- Create: `packages/shared/src/prompt-builder.test.ts`
- Create: `packages/shared/src/agent-config-diff.ts`
- Create: `packages/shared/src/agent-config-diff.test.ts`
- Modify: `packages/shared/src/index.ts` (add 2 exports)

**Interfaces:**
- Consumes: `AgentConfigSections`, `AgentIdentity`, `AgentPersonality`, `AgentRules`, `AgentKnowledgeConfig`, `AgentPlaybook` (Task 2).
- Produces: `compileSystemPrompt(config: AgentConfigSections): string`, `computeChangedSections(draft, baseSnapshot): Array<keyof AgentConfigSections>` — both pure, both called directly by Task 5 (publish) and Task 6 (draft API GET).

Both functions are pure (no I/O) — this task is the safest one to fully TDD, and neither function is wired into anything yet, so there is no production behavior to break. This is the ONLY place system-prompt text gets assembled from the modular config; `agent-runner.ts`'s `buildSystemPrompt` (which only appends date/time) is untouched and stays that way.

- [ ] **Step 1: Write the failing tests for `compileSystemPrompt`**

Create `packages/shared/src/prompt-builder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compileSystemPrompt } from "./prompt-builder.js";
import type { AgentConfigSections } from "./types/agent-config.js";

function baseConfig(overrides: Partial<AgentConfigSections> = {}): AgentConfigSections {
  return {
    identity: { nome: "", funcao: "", missao: "" },
    personality: {
      tom_de_voz: "equilibrado",
      tom_de_voz_personalizado: "",
      tamanho_resposta: "curta",
      emojis: { ativo: true, maximo: 1, instrucao: "" },
      perguntas_por_vez: { maximo: 1 },
      postura_comercial: { tipo: "", instrucao: "" },
      girias_proibidas: [],
      proatividade: "",
    },
    rules: {
      transferencia_para_humano: [],
      promessas_proibidas: [],
      regras_por_tipo: [],
      preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" },
      objecoes: [],
    },
    knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
    playbook: { script_atendimento: "" },
    ...overrides,
  };
}

describe("compileSystemPrompt", () => {
  it("compiles identity name, function, and mission", () => {
    const result = compileSystemPrompt(
      baseConfig({ identity: { nome: "Helena", funcao: "Consultora virtual", missao: "Ajudar o cliente a decidir." } })
    );
    expect(result).toContain("Nome: Helena");
    expect(result).toContain("Função: Consultora virtual");
    expect(result).toContain("Ajudar o cliente a decidir.");
  });

  it("uses the custom tone text when tom_de_voz is personalizado", () => {
    const result = compileSystemPrompt(
      baseConfig({
        personality: {
          ...baseConfig().personality,
          tom_de_voz: "personalizado",
          tom_de_voz_personalizado: "Direto e bem-humorado",
        },
      })
    );
    expect(result).toContain("Tom de voz: Direto e bem-humorado");
  });

  it("describes the emoji limit when emojis are active, and says not to use them otherwise", () => {
    const withEmojis = compileSystemPrompt(
      baseConfig({ personality: { ...baseConfig().personality, emojis: { ativo: true, maximo: 1, instrucao: "só quando fizer sentido" } } })
    );
    expect(withEmojis).toContain("no máximo 1 por mensagem. só quando fizer sentido");

    const noEmojis = compileSystemPrompt(
      baseConfig({ personality: { ...baseConfig().personality, emojis: { ativo: false, maximo: 0, instrucao: "" } } })
    );
    expect(noEmojis).toContain("Emojis: não usar.");
  });

  it("only lists active handoff triggers, promises, and category rules — inactive ones are dropped", () => {
    const result = compileSystemPrompt(
      baseConfig({
        rules: {
          transferencia_para_humano: [
            { id: "a", label: "Reclamação", instrucao: "Transferir sempre", ativo: true },
            { id: "b", label: "Desconto", instrucao: "Nunca ativo", ativo: false },
          ],
          promessas_proibidas: [{ id: "c", label: "Prazo", instrucao: "Nunca prometer prazo", ativo: true }],
          regras_por_tipo: [{ id: "d", categoria: "Consórcio", instrucao: "Explicar contemplação", ativo: true }],
          preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" },
          objecoes: [],
        },
      })
    );
    expect(result).toContain("Reclamação: Transferir sempre");
    expect(result).not.toContain("Nunca ativo");
    expect(result).toContain("Nunca prometer prazo");
    expect(result).toContain("### Consórcio");
    expect(result).toContain("Explicar contemplação");
  });

  it("compiles preço e desconto only when at least one of its fields is filled", () => {
    const empty = compileSystemPrompt(baseConfig());
    expect(empty).not.toContain("Preço e desconto");

    const filled = compileSystemPrompt(
      baseConfig({
        rules: {
          ...baseConfig().rules,
          preco_desconto: { pode_autonomo: "Preço de tabela", exige_humano: "Desconto", nunca_pode: "", observacoes: "" },
        },
      })
    );
    expect(filled).toContain("Pode informar sozinho: Preço de tabela");
    expect(filled).toContain("Exige humano: Desconto");
  });

  it("only includes active objections, with all 4 fields", () => {
    const result = compileSystemPrompt(
      baseConfig({
        rules: {
          ...baseConfig().rules,
          objecoes: [
            {
              id: "preco-alto", nome: "Preço alto", ativo: true,
              como_identificar: "Cliente diz que está caro",
              orientacao: "Descobrir se é valor total, entrada ou parcela",
              pergunta_diagnostico: "É o valor total, a entrada ou a parcela que pesa mais?",
              quando_escalar: "Se pedir desconto explícito",
            },
            { id: "x", nome: "Inativa", ativo: false, como_identificar: "", orientacao: "", pergunta_diagnostico: "", quando_escalar: "" },
          ],
        },
      })
    );
    expect(result).toContain("### Preço alto");
    expect(result).toContain("Cliente diz que está caro");
    expect(result).toContain("valor total, a entrada ou a parcela");
    expect(result).not.toContain("Inativa");
  });

  it("inlines active price notes and links but skips inactive links", () => {
    const result = compileSystemPrompt(
      baseConfig({
        knowledge: {
          precos_notas: "Consulte a tabela de referência antes de informar valores.",
          links: [
            { id: "a", titulo: "Catálogo", url: "https://example.com/catalogo", ativo: true },
            { id: "b", titulo: "Antigo", url: "https://example.com/antigo", ativo: false },
          ],
          documentos_ativos: true,
          faqs_ativas: true,
        },
      })
    );
    expect(result).toContain("Consulte a tabela de referência");
    expect(result).toContain("Catálogo: https://example.com/catalogo");
    expect(result).not.toContain("Antigo");
  });

  it("includes the playbook script when present, omits the section when empty", () => {
    const withScript = compileSystemPrompt(baseConfig({ playbook: { script_atendimento: "1. Identificar necessidade" } }));
    expect(withScript).toContain("Script de atendimento");
    expect(withScript).toContain("1. Identificar necessidade");

    const withoutScript = compileSystemPrompt(baseConfig());
    expect(withoutScript).not.toContain("Script de atendimento");
  });

  it("never leaves stray blank section headers for fully-empty sections", () => {
    const result = compileSystemPrompt(baseConfig());
    // With every field empty, only Personalidade (which always renders tone/
    // response-size/questions-per-message) should appear.
    expect(result).not.toContain("# Identidade");
    expect(result).not.toContain("# Regras");
    expect(result).not.toContain("# Preços");
    expect(result).not.toContain("# Playbook");
    expect(result).toContain("# Personalidade");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/shared test -- prompt-builder`
Expected: FAIL — `Cannot find module './prompt-builder.js'`.

- [ ] **Step 3: Write `packages/shared/src/prompt-builder.ts`**

```ts
import type {
  AgentConfigSections,
  AgentIdentity,
  AgentPersonality,
  AgentRules,
  AgentKnowledgeConfig,
  AgentPlaybook,
} from "./types/agent-config.js";

function compileIdentitySection(identity: AgentIdentity): string {
  const lines: string[] = [];
  if (identity.nome) lines.push(`Nome: ${identity.nome}`);
  if (identity.funcao) lines.push(`Função: ${identity.funcao}`);
  if (identity.missao) lines.push("", identity.missao);
  if (lines.length === 0) return "";
  return ["# Identidade", ...lines].join("\n");
}

const TOM_DE_VOZ_LABELS: Record<AgentPersonality["tom_de_voz"], string> = {
  profissional: "Profissional",
  equilibrado: "Equilibrado",
  amigavel: "Amigável",
  divertido: "Divertido",
  personalizado: "Personalizado",
};

const TAMANHO_RESPOSTA_LABELS: Record<AgentPersonality["tamanho_resposta"], string> = {
  curta: "Curta",
  media: "Média",
  detalhada: "Detalhada",
};

function compilePersonalitySection(personality: AgentPersonality): string {
  const lines = ["# Personalidade"];

  const tom =
    personality.tom_de_voz === "personalizado" && personality.tom_de_voz_personalizado
      ? personality.tom_de_voz_personalizado
      : TOM_DE_VOZ_LABELS[personality.tom_de_voz];
  lines.push(`Tom de voz: ${tom}`);
  lines.push(`Tamanho das respostas: ${TAMANHO_RESPOSTA_LABELS[personality.tamanho_resposta]}`);

  if (personality.emojis.ativo) {
    const instrucao = personality.emojis.instrucao ? ` ${personality.emojis.instrucao}` : "";
    lines.push(`Emojis: no máximo ${personality.emojis.maximo} por mensagem.${instrucao}`);
  } else {
    lines.push("Emojis: não usar.");
  }

  lines.push(`Faça no máximo ${personality.perguntas_por_vez.maximo} pergunta(s) por mensagem.`);

  if (personality.postura_comercial.tipo || personality.postura_comercial.instrucao) {
    const tipo = personality.postura_comercial.tipo ? `${personality.postura_comercial.tipo}. ` : "";
    lines.push(`Postura comercial: ${tipo}${personality.postura_comercial.instrucao}`.trim());
  }

  if (personality.girias_proibidas.length > 0) {
    lines.push(`Nunca use estas expressões: ${personality.girias_proibidas.join(", ")}.`);
  }

  if (personality.proatividade) {
    lines.push("", personality.proatividade);
  }

  return lines.join("\n");
}

function compileRulesSection(rules: AgentRules): string {
  const blocks: string[] = [];

  const handoff = rules.transferencia_para_humano.filter((r) => r.ativo);
  if (handoff.length > 0) {
    blocks.push(["## Transferência para humano", ...handoff.map((r) => `- ${r.label}: ${r.instrucao}`)].join("\n"));
  }

  const promises = rules.promessas_proibidas.filter((r) => r.ativo);
  if (promises.length > 0) {
    blocks.push(["## Promessas proibidas", ...promises.map((r) => `- ${r.instrucao}`)].join("\n"));
  }

  const byType = rules.regras_por_tipo.filter((r) => r.ativo);
  if (byType.length > 0) {
    blocks.push(
      ["## Regras por tipo de atendimento", ...byType.flatMap((r) => [`### ${r.categoria}`, r.instrucao])].join("\n")
    );
  }

  const pd = rules.preco_desconto;
  if (pd.pode_autonomo || pd.exige_humano || pd.nunca_pode || pd.observacoes) {
    const pdLines = ["## Preço e desconto"];
    if (pd.pode_autonomo) pdLines.push(`Pode informar sozinho: ${pd.pode_autonomo}`);
    if (pd.exige_humano) pdLines.push(`Exige humano: ${pd.exige_humano}`);
    if (pd.nunca_pode) pdLines.push(`Nunca pode: ${pd.nunca_pode}`);
    if (pd.observacoes) pdLines.push(`Observações: ${pd.observacoes}`);
    blocks.push(pdLines.join("\n"));
  }

  const objections = rules.objecoes.filter((o) => o.ativo);
  if (objections.length > 0) {
    blocks.push(
      [
        "## Objeções",
        ...objections.flatMap((o) => [
          `### ${o.nome}`,
          `Como identificar: ${o.como_identificar}`,
          `Orientação: ${o.orientacao}`,
          `Pergunta de diagnóstico: ${o.pergunta_diagnostico}`,
          `Quando escalar: ${o.quando_escalar}`,
        ]),
      ].join("\n")
    );
  }

  if (blocks.length === 0) return "";
  return ["# Regras", ...blocks].join("\n\n");
}

function compileKnowledgeSection(knowledge: AgentKnowledgeConfig): string {
  const blocks: string[] = [];
  if (knowledge.precos_notas) {
    blocks.push(["# Preços", knowledge.precos_notas].join("\n"));
  }
  const activeLinks = knowledge.links.filter((l) => l.ativo);
  if (activeLinks.length > 0) {
    blocks.push(["# Links úteis", ...activeLinks.map((l) => `- ${l.titulo}: ${l.url}`)].join("\n"));
  }
  return blocks.join("\n\n");
}

function compilePlaybookSection(playbook: AgentPlaybook): string {
  if (!playbook.script_atendimento) return "";
  return ["# Playbook: Script de atendimento", playbook.script_atendimento].join("\n");
}

export function compileSystemPrompt(config: AgentConfigSections): string {
  const sections = [
    compileIdentitySection(config.identity),
    compilePersonalitySection(config.personality),
    compileRulesSection(config.rules),
    compileKnowledgeSection(config.knowledge),
    compilePlaybookSection(config.playbook),
  ].filter((section) => section.trim().length > 0);

  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/shared test -- prompt-builder`
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Write the failing test for `computeChangedSections`**

Create `packages/shared/src/agent-config-diff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeChangedSections } from "./agent-config-diff.js";
import type { AgentConfigSections } from "./types/agent-config.js";

function baseSections(): AgentConfigSections {
  return {
    identity: { nome: "Helena", funcao: "", missao: "" },
    personality: {
      tom_de_voz: "equilibrado", tom_de_voz_personalizado: "", tamanho_resposta: "curta",
      emojis: { ativo: true, maximo: 1, instrucao: "" }, perguntas_por_vez: { maximo: 1 },
      postura_comercial: { tipo: "", instrucao: "" }, girias_proibidas: [], proatividade: "",
    },
    rules: {
      transferencia_para_humano: [], promessas_proibidas: [], regras_por_tipo: [],
      preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" }, objecoes: [],
    },
    knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
    playbook: { script_atendimento: "" },
  };
}

describe("computeChangedSections", () => {
  it("returns every section when there is no base snapshot yet (never published)", () => {
    expect(computeChangedSections(baseSections(), null)).toEqual([
      "identity", "personality", "rules", "knowledge", "playbook",
    ]);
  });

  it("returns an empty array when the draft is identical to the base snapshot", () => {
    expect(computeChangedSections(baseSections(), baseSections())).toEqual([]);
  });

  it("returns only the sections that actually differ", () => {
    const base = baseSections();
    const draft = { ...base, identity: { ...base.identity, nome: "Helena 2.0" } };
    expect(computeChangedSections(draft, base)).toEqual(["identity"]);
  });

  it("detects a change nested inside an array field", () => {
    const base = baseSections();
    const draft = {
      ...base,
      rules: { ...base.rules, objecoes: [{ id: "a", nome: "Preço", como_identificar: "", orientacao: "", pergunta_diagnostico: "", quando_escalar: "", ativo: true }] },
    };
    expect(computeChangedSections(draft, base)).toEqual(["rules"]);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/shared test -- agent-config-diff`
Expected: FAIL — `Cannot find module './agent-config-diff.js'`.

- [ ] **Step 7: Write `packages/shared/src/agent-config-diff.ts`**

```ts
import type { AgentConfigSections } from "./types/agent-config.js";

const SECTION_KEYS = ["identity", "personality", "rules", "knowledge", "playbook"] as const;

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function computeChangedSections(
  draft: AgentConfigSections,
  baseSnapshot: AgentConfigSections | null
): Array<(typeof SECTION_KEYS)[number]> {
  if (!baseSnapshot) return [...SECTION_KEYS];
  return SECTION_KEYS.filter((key) => !deepEqual(draft[key], baseSnapshot[key]));
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/shared test -- agent-config-diff`
Expected: PASS, all 4 tests green.

- [ ] **Step 9: Add both exports to `packages/shared/src/index.ts`**

Add these lines next to the existing `export * from "./date.js";` line:

```ts
export * from "./prompt-builder.js";
export * from "./agent-config-diff.js";
```

- [ ] **Step 10: Run the full shared package test suite and typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/shared test && pnpm --filter @aula-agente/shared typecheck`
Expected: all tests pass (including the pre-existing `date.test.ts`/`task-helpers.test.ts`/`schemas/task.test.ts`, untouched by this task), no type errors.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src/prompt-builder.ts packages/shared/src/prompt-builder.test.ts packages/shared/src/agent-config-diff.ts packages/shared/src/agent-config-diff.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add pure Prompt Builder and draft/published diff helper"
```

---

### Task 5: Publish — transactional Postgres function + API route

**⚠️ Production-risk task.** This is the first and only piece of code in the whole plan that writes to `agents.system_prompt`. Read the rollback note in Step 8 before running Step 7 against any real agent.

**Files:**
- Create: `supabase/migrations/00016_publish_agent_config_function.sql`
- Create: `apps/api/src/services/agent-config.service.ts` (publish part only — more functions added in Task 6, 16, 18)
- Create: `apps/api/src/services/agent-config.service.test.ts`
- Create: `apps/api/src/routes/agent-config/index.ts` (publish route only — more routes added in Task 6, 16, 18)
- Modify: `apps/api/src/server.ts` (register the new route file)

**Interfaces:**
- Consumes: `compileSystemPrompt` (Task 4), `getOrCreateAgentConfig`, `publishAgentConfig` (Task 3), `getAgentById` (existing, `packages/database/src/queries/agents.ts`), `publishAgentConfigSchema` (Task 2), `authMiddleware` (existing, `apps/api/src/middleware/auth.ts`).
- Produces: `publishDraft(db, agentId, changelog, publishedBy): Promise<AgentVersion>` (service function, consumed by Task 20's integration pass and reused conceptually by Task 16); `POST /agents/:agentId/config/publish` (HTTP route, consumed by Task 14's frontend Publicar button).

- [ ] **Step 1: Write `00016_publish_agent_config_function.sql`**

A plpgsql function body executes as one implicit transaction: if any statement inside raises, everything already run inside the function in this call is rolled back automatically. This is what makes "compile → update agents → insert version → update base_version_id" atomic without a hand-rolled multi-statement transaction from Node.

```sql
CREATE OR REPLACE FUNCTION publish_agent_config(
  p_agent_id uuid,
  p_changelog text,
  p_compiled_prompt text,
  p_config_snapshot jsonb,
  p_model_settings jsonb,
  p_tools_config jsonb,
  p_published_by uuid
) RETURNS agent_versions
LANGUAGE plpgsql
AS $$
DECLARE
  v_version integer;
  v_row agent_versions;
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM agent_versions WHERE agent_id = p_agent_id;

  UPDATE agents SET
    system_prompt = p_compiled_prompt,
    model = p_model_settings->>'model',
    provider = p_model_settings->>'provider',
    temperature = (p_model_settings->>'temperature')::real,
    max_tokens = (p_model_settings->>'max_tokens')::integer,
    tools_config = p_tools_config
  WHERE id = p_agent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent % not found', p_agent_id;
  END IF;

  INSERT INTO agent_versions (
    agent_id, organization_id, version, changelog, config_snapshot,
    compiled_system_prompt, model_settings, tools_config, published_by
  )
  SELECT p_agent_id, organization_id, v_version, p_changelog, p_config_snapshot,
         p_compiled_prompt, p_model_settings, p_tools_config, p_published_by
  FROM agents WHERE id = p_agent_id
  RETURNING * INTO v_row;

  UPDATE agent_configs SET base_version_id = v_row.id WHERE agent_id = p_agent_id;

  RETURN v_row;
END;
$$;
```

- [ ] **Step 2: Apply the migration**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && npx supabase migration up`
Expected: applies cleanly. No existing row in `agents` is touched by applying this migration — it only defines a function, it does not call it.

- [ ] **Step 3: Write the failing test for the service**

Create `apps/api/src/services/agent-config.service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAgentById, getOrCreateAgentConfig, publishAgentConfig } = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getOrCreateAgentConfig: vi.fn(),
  publishAgentConfig: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ getAgentById, getOrCreateAgentConfig, publishAgentConfig }));

import { publishDraft } from "./agent-config.service.js";

const baseAgent = {
  id: "agent-1",
  organization_id: "org-1",
  name: "Helena",
  description: "",
  system_prompt: "texto antigo",
  model: "gpt-4o-mini",
  provider: "openai" as const,
  temperature: 0.7,
  max_tokens: 1024,
  tools_config: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true },
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const baseDraft = {
  id: "config-1",
  agent_id: "agent-1",
  organization_id: "org-1",
  base_version_id: null,
  identity: { nome: "Helena", funcao: "Consultora virtual", missao: "" },
  personality: {
    tom_de_voz: "equilibrado" as const, tom_de_voz_personalizado: "", tamanho_resposta: "curta" as const,
    emojis: { ativo: true, maximo: 1, instrucao: "" }, perguntas_por_vez: { maximo: 1 },
    postura_comercial: { tipo: "", instrucao: "" }, girias_proibidas: [], proatividade: "",
  },
  rules: {
    transferencia_para_humano: [], promessas_proibidas: [], regras_por_tipo: [],
    preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" }, objecoes: [],
  },
  knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
  playbook: { script_atendimento: "" },
  tools_config: baseAgent.tools_config,
  model_settings: { provider: "openai" as const, model: "gpt-4o-mini", temperature: 0.7, max_tokens: 1024 },
  updated_at: "2026-01-01T00:00:00Z",
  updated_by: null,
};

describe("publishDraft", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue(baseAgent);
    getOrCreateAgentConfig.mockResolvedValue(baseDraft);
    publishAgentConfig.mockResolvedValue({ id: "version-1", version: 1 });
  });

  it("compiles the draft into a prompt and passes it, plus model/tools settings, to publishAgentConfig", async () => {
    await publishDraft({} as any, "agent-1", "Primeira publicação", "user-1");

    expect(publishAgentConfig).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agentId: "agent-1",
        changelog: "Primeira publicação",
        publishedBy: "user-1",
        modelSettings: baseDraft.model_settings,
        toolsConfig: baseDraft.tools_config,
      })
    );
    const call = publishAgentConfig.mock.calls[0][1];
    expect(call.compiledSystemPrompt).toContain("Nome: Helena");
    expect(call.compiledSystemPrompt).toContain("Função: Consultora virtual");
    expect(call.configSnapshot).toEqual({
      identity: baseDraft.identity,
      personality: baseDraft.personality,
      rules: baseDraft.rules,
      knowledge: baseDraft.knowledge,
      playbook: baseDraft.playbook,
    });
  });

  it("returns whatever publishAgentConfig returns", async () => {
    const result = await publishDraft({} as any, "agent-1", "changelog", "user-1");
    expect(result).toEqual({ id: "version-1", version: 1 });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- agent-config.service`
Expected: FAIL — `Cannot find module './agent-config.service.js'`.

- [ ] **Step 5: Write `apps/api/src/services/agent-config.service.ts`**

```ts
import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById, getOrCreateAgentConfig, publishAgentConfig } from "@aula-agente/database";
import { compileSystemPrompt } from "@aula-agente/shared";
import type { AgentVersion } from "@aula-agente/shared";

export async function publishDraft(
  db: SupabaseClient,
  agentId: string,
  changelog: string,
  publishedBy: string
): Promise<AgentVersion> {
  const agent = await getAgentById(db, agentId);
  const draft = await getOrCreateAgentConfig(db, agent);

  const configSnapshot = {
    identity: draft.identity,
    personality: draft.personality,
    rules: draft.rules,
    knowledge: draft.knowledge,
    playbook: draft.playbook,
  };

  return publishAgentConfig(db, {
    agentId,
    changelog,
    compiledSystemPrompt: compileSystemPrompt(configSnapshot),
    configSnapshot,
    modelSettings: draft.model_settings,
    toolsConfig: draft.tools_config,
    publishedBy,
  });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- agent-config.service`
Expected: PASS, both tests green.

- [ ] **Step 7: Write the publish route**

Create `apps/api/src/routes/agent-config/index.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { publishAgentConfigSchema } from "@aula-agente/shared";
import { getAdminClient, getAgentById } from "@aula-agente/database";
import { publishDraft } from "../../services/agent-config.service.js";
import { authMiddleware } from "../../middleware/auth.js";

export default async function agentConfigRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { agentId: string } }>("/agents/:agentId/config/publish", async (request, reply) => {
    const parseResult = publishAgentConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error.issues });
    }

    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const version = await publishDraft(db, request.params.agentId, parseResult.data.changelog, request.user.id);
    return reply.status(201).send(version);
  });
}
```

- [ ] **Step 8: Register the route in `server.ts`**

Modify `apps/api/src/server.ts`: add the import next to `taskRoutes` and the registration next to `server.register(taskRoutes)`:

```ts
import agentConfigRoutes from "./routes/agent-config/index.js";
```

```ts
server.register(agentConfigRoutes);
```

**Rollback plan for this step, before testing against any real agent:** the only statement that touches `agents` is inside `publish_agent_config`, and it only runs when this route is called with a real `agentId`. Before manually exercising this route against Helena's real agent row (which does not happen until Task 20), there is nothing to roll back — this task's own verification (Step 9) uses a disposable test agent, not Helena's. If you do accidentally call this route against a real agent before Task 20: `SELECT * FROM agent_versions WHERE agent_id = '<id>' ORDER BY version DESC LIMIT 1;` gives you the version just created, whose `config_snapshot`/`compiled_system_prompt` you can hand-restore into `agents.system_prompt` via a plain `UPDATE agents SET system_prompt = '<previous text>' WHERE id = '<id>';` — but since nothing before Task 20 has any UI or reason to call this against Helena's real agent, this should not happen.

- [ ] **Step 9: Manually verify against a disposable test agent (not Helena)**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api dev` (in one terminal) then, in another terminal, create a throwaway agent via the existing `/agents/new` UI or directly in Supabase Studio, note its `id`, log in as yourself to get a bearer token (`localStorage` in the browser devtools after logging into `apps/web`, key holding the Supabase session — or call Supabase's `signInWithPassword` REST endpoint directly), then:

```bash
curl -X POST http://localhost:3001/agents/<test-agent-id>/config/publish \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"changelog": "teste manual"}'
```

Expected: `201`, a JSON body with `version: 1`, and `SELECT system_prompt FROM agents WHERE id = '<test-agent-id>';` now shows compiled text (likely just `"# Personalidade\n..."` since the disposable agent's draft is all-defaults) instead of whatever it had before. `SELECT * FROM agent_versions WHERE agent_id = '<test-agent-id>';` shows exactly one row. `SELECT base_version_id FROM agent_configs WHERE agent_id = '<test-agent-id>';` matches that row's `id`. Delete the test agent afterward (`DELETE FROM agents WHERE id = '<test-agent-id>';` — cascades to its `agent_configs`/`agent_versions` rows).

- [ ] **Step 10: Run full API test suite and typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test && pnpm --filter @aula-agente/api typecheck`
Expected: all tests pass (including pre-existing `crm-sync.test.ts`, `evolution.test.ts`, `dashboard.test.ts`), no type errors.

- [ ] **Step 11: Commit**

```bash
git add supabase/migrations/00016_publish_agent_config_function.sql apps/api/src/services/agent-config.service.ts apps/api/src/services/agent-config.service.test.ts apps/api/src/routes/agent-config/index.ts apps/api/src/server.ts
git commit -m "feat(api): add transactional publish endpoint for agent config drafts"
```

---

### Task 6: Draft API — get and patch

**Files:**
- Modify: `apps/api/src/services/agent-config.service.ts` (add `getAgentConfigWithStatus`)
- Modify: `apps/api/src/services/agent-config.service.test.ts` (add its tests)
- Modify: `apps/api/src/routes/agent-config/index.ts` (add GET and PATCH routes)

**Interfaces:**
- Consumes: `getOrCreateAgentConfig`, `patchAgentConfig`, `getLatestAgentVersion` (Task 3), `computeChangedSections` (Task 4), `updateAgentConfigSchema` (Task 2).
- Produces: `getAgentConfigWithStatus(db, agentId): Promise<{ draft, latestVersion, changedSections, hasPendingChanges }>` (consumed by Task 14's draft-status bar and Task 15's Playground, which needs the current draft to compile from); `GET /agents/:agentId/config`, `PATCH /agents/:agentId/config` (consumed by every frontend module task, 10-13).

Purely additive — no existing route or exported function changes shape. Nothing in production reads these yet.

- [ ] **Step 1: Add the failing tests for `getAgentConfigWithStatus`**

Add to `apps/api/src/services/agent-config.service.test.ts`, alongside the existing `describe("publishDraft", ...)` block (extend the hoisted mock object first):

```ts
const { getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion, patchAgentConfig } = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getOrCreateAgentConfig: vi.fn(),
  publishAgentConfig: vi.fn(),
  getLatestAgentVersion: vi.fn(),
  patchAgentConfig: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion, patchAgentConfig,
}));
```

(This replaces the file's existing `vi.hoisted`/`vi.mock` pair at the top — same file, just naming every function the whole file's tests need, since `vi.mock` only accepts one call per mocked module per file.)

```ts
import { getAgentConfigWithStatus } from "./agent-config.service.js";

describe("getAgentConfigWithStatus", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue(baseAgent);
    getOrCreateAgentConfig.mockResolvedValue(baseDraft);
  });

  it("reports every section as changed when the agent has never been published", async () => {
    getLatestAgentVersion.mockResolvedValue(null);

    const result = await getAgentConfigWithStatus({} as any, "agent-1");

    expect(result.hasPendingChanges).toBe(true);
    expect(result.changedSections).toEqual(["identity", "personality", "rules", "knowledge", "playbook"]);
    expect(result.latestVersion).toBeNull();
  });

  it("reports no pending changes when the draft matches the latest published snapshot", async () => {
    getLatestAgentVersion.mockResolvedValue({
      id: "version-1",
      config_snapshot: {
        identity: baseDraft.identity, personality: baseDraft.personality, rules: baseDraft.rules,
        knowledge: baseDraft.knowledge, playbook: baseDraft.playbook,
      },
    });

    const result = await getAgentConfigWithStatus({} as any, "agent-1");

    expect(result.hasPendingChanges).toBe(false);
    expect(result.changedSections).toEqual([]);
  });

  it("reports only the sections that differ from the latest published snapshot", async () => {
    getLatestAgentVersion.mockResolvedValue({
      id: "version-1",
      config_snapshot: {
        identity: { nome: "Nome antigo", funcao: "", missao: "" },
        personality: baseDraft.personality, rules: baseDraft.rules,
        knowledge: baseDraft.knowledge, playbook: baseDraft.playbook,
      },
    });

    const result = await getAgentConfigWithStatus({} as any, "agent-1");

    expect(result.changedSections).toEqual(["identity"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- agent-config.service`
Expected: FAIL — `getAgentConfigWithStatus is not exported`.

- [ ] **Step 3: Add `getAgentConfigWithStatus` to the service**

Add to `apps/api/src/services/agent-config.service.ts` (extend the existing import line and append the function):

```ts
import { getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion } from "@aula-agente/database";
import { compileSystemPrompt, computeChangedSections } from "@aula-agente/shared";
import type { AgentConfigDraft, AgentVersion } from "@aula-agente/shared";
```

```ts
export interface AgentConfigStatus {
  draft: AgentConfigDraft;
  latestVersion: AgentVersion | null;
  changedSections: string[];
  hasPendingChanges: boolean;
}

export async function getAgentConfigWithStatus(db: SupabaseClient, agentId: string): Promise<AgentConfigStatus> {
  const agent = await getAgentById(db, agentId);
  const draft = await getOrCreateAgentConfig(db, agent);
  const latestVersion = await getLatestAgentVersion(db, agentId);

  const baseSnapshot = latestVersion?.config_snapshot ?? null;
  const changedSections = computeChangedSections(
    { identity: draft.identity, personality: draft.personality, rules: draft.rules, knowledge: draft.knowledge, playbook: draft.playbook },
    baseSnapshot
  );

  return { draft, latestVersion, changedSections, hasPendingChanges: changedSections.length > 0 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- agent-config.service`
Expected: PASS, all 5 tests green (2 from `publishDraft`, 3 new).

- [ ] **Step 5: Add GET and PATCH routes**

Add to `apps/api/src/routes/agent-config/index.ts` (extend the imports and add both routes inside the existing `agentConfigRoutes` function, before the publish route):

```ts
import { updateAgentConfigSchema, publishAgentConfigSchema } from "@aula-agente/shared";
import { getAdminClient, getAgentById, patchAgentConfig } from "@aula-agente/database";
import { publishDraft, getAgentConfigWithStatus } from "../../services/agent-config.service.js";
```

```ts
app.get<{ Params: { agentId: string } }>("/agents/:agentId/config", async (request, reply) => {
  const db = getAdminClient();
  const agent = await getAgentById(db, request.params.agentId);
  const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
  if (!membership) return reply.status(403).send({ error: "Access denied" });

  return getAgentConfigWithStatus(db, request.params.agentId);
});

app.patch<{ Params: { agentId: string } }>("/agents/:agentId/config", async (request, reply) => {
  const parseResult = updateAgentConfigSchema.safeParse(request.body);
  if (!parseResult.success) {
    return reply.status(400).send({ error: parseResult.error.issues });
  }

  const db = getAdminClient();
  const agent = await getAgentById(db, request.params.agentId);
  const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
  if (!membership) return reply.status(403).send({ error: "Access denied" });

  const draft = await patchAgentConfig(db, request.params.agentId, parseResult.data, request.user.id);
  return draft;
});
```

- [ ] **Step 6: Run full API test suite and typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test && pnpm --filter @aula-agente/api typecheck`
Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/agent-config.service.ts apps/api/src/services/agent-config.service.test.ts apps/api/src/routes/agent-config/index.ts
git commit -m "feat(api): add GET/PATCH draft config endpoints with pending-changes diff"
```

---

### Task 7: Extract agent-runner + tools + vault into `packages/agent-runtime`

**⚠️ Production-risk task.** This moves the exact code that runs Helena's real conversations. It is a mechanical relocation — no logic changes — precisely so behavior cannot change. The acceptance bar is that every test that passed before this task still passes, unchanged, after it.

**Files:**
- Create: `packages/agent-runtime/package.json`, `packages/agent-runtime/tsconfig.json`
- Create: `packages/agent-runtime/src/index.ts`
- Move: `apps/worker/src/agents/agent-runner.ts` → `packages/agent-runtime/src/agent-runner.ts`
- Move: `apps/worker/src/agents/agent-runner.test.ts` → `packages/agent-runtime/src/agent-runner.test.ts`
- Move: `apps/worker/src/agents/tools/*.ts` (all 6 files, including `search-catalog.test.ts`) → `packages/agent-runtime/src/tools/`
- Move: `apps/worker/src/lib/vault.ts` → `packages/agent-runtime/src/vault.ts`
- Modify: `apps/worker/src/workers/process-message.ts`, `apps/worker/src/lib/audio-transcription.ts`, `apps/worker/src/workers/process-document.ts` (import paths only)
- Modify: `apps/worker/package.json` (add dependency, remove now-unused ones that only served the moved code, if any — check before removing)
- Modify: `apps/api/package.json` (add dependency, needed starting Task 9)
- Delete: `apps/worker/src/agents/` directory, `apps/worker/src/lib/vault.ts`

**Interfaces:**
- Produces: everything `apps/worker` and `apps/api` need to run an agent turn, importable as `@aula-agente/agent-runtime` — `runAgent`, `buildSystemPrompt`, `formatHistoryForLLM`, `buildToolsForAgent`, `resolveApiKey`, plus every individual tool factory (`createSearchKnowledgeTool`, `createSearchFaqTool`, `createSearchCatalogTool`, `createSendVehiclePhotoTool`, `createCreateTaskTool`). Task 8 adds the `sandbox` parameter on top of this exact surface; Task 9 is the first real consumer from `apps/api`.

**Rollback plan:** every step up to and including Step 9 is reversible with `git revert` of this task's single commit (Step 10) — nothing is deployed mid-task. The critical verification is Step 8 (existing worker tests, relocated verbatim, still pass) and Step 9 (a real end-to-end message through the actual queue/worker in a local dev environment, unchanged reply). If Step 8 or Step 9 fails, do not commit — fix the import paths (the only thing that should differ from the original files) until they do.

- [ ] **Step 1: Create the new package skeleton**

Create `packages/agent-runtime/package.json`:

```json
{
  "name": "@aula-agente/agent-runtime",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "echo 'no lint configured'"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "^4.0.10",
    "@ai-sdk/google": "^4.0.10",
    "@ai-sdk/openai": "^4.0.9",
    "@aula-agente/database": "workspace:*",
    "@aula-agente/shared": "workspace:*",
    "@supabase/supabase-js": "^2.49.0",
    "ai": "^7.0.18",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

Check the exact current version numbers first — run: `cat "/Users/weslleyvalente/Agente IA/superpowers/apps/worker/package.json"` and copy the real `@ai-sdk/*`/`ai`/`zod` version strings verbatim instead of the ones above if they differ (they were current as of the last time that file was read during planning).

Create `packages/agent-runtime/tsconfig.json` (identical to `packages/database/tsconfig.json`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Move the agent runner and its test, unchanged**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
mkdir -p packages/agent-runtime/src/tools
git mv apps/worker/src/agents/agent-runner.ts packages/agent-runtime/src/agent-runner.ts
git mv apps/worker/src/agents/agent-runner.test.ts packages/agent-runtime/src/agent-runner.test.ts
git mv apps/worker/src/agents/tools/registry.ts packages/agent-runtime/src/tools/registry.ts
git mv apps/worker/src/agents/tools/search-knowledge.ts packages/agent-runtime/src/tools/search-knowledge.ts
git mv apps/worker/src/agents/tools/search-faq.ts packages/agent-runtime/src/tools/search-faq.ts
git mv apps/worker/src/agents/tools/search-catalog.ts packages/agent-runtime/src/tools/search-catalog.ts
git mv apps/worker/src/agents/tools/search-catalog.test.ts packages/agent-runtime/src/tools/search-catalog.test.ts
git mv apps/worker/src/agents/tools/send-vehicle-photo.ts packages/agent-runtime/src/tools/send-vehicle-photo.ts
git mv apps/worker/src/agents/tools/create-task.ts packages/agent-runtime/src/tools/create-task.ts
git mv apps/worker/src/lib/vault.ts packages/agent-runtime/src/vault.ts
```

`agent-runner.ts` imports `./tools/registry.js` — that relative path is unchanged by the move (both files moved together, same relative structure), so its content needs zero edits. Same for `registry.ts`'s imports of the 5 tool files (all relative, all moved together). `agent-runner.test.ts` and `search-catalog.test.ts` import only from their own sibling file and from `@aula-agente/shared` — also unchanged.

- [ ] **Step 3: Write `packages/agent-runtime/src/index.ts`**

```ts
export { runAgent, buildSystemPrompt, formatHistoryForLLM } from "./agent-runner.js";
export { buildToolsForAgent } from "./tools/registry.js";
export { createSearchKnowledgeTool } from "./tools/search-knowledge.js";
export { createSearchFaqTool } from "./tools/search-faq.js";
export { createSearchCatalogTool } from "./tools/search-catalog.js";
export { createSendVehiclePhotoTool } from "./tools/send-vehicle-photo.js";
export { createCreateTaskTool } from "./tools/create-task.js";
export { resolveApiKey } from "./vault.js";
```

- [ ] **Step 4: Update `apps/worker`'s 3 importers**

In `apps/worker/src/workers/process-message.ts`, change:

```ts
import { runAgent } from "../agents/agent-runner.js";
```

to:

```ts
import { runAgent } from "@aula-agente/agent-runtime";
```

and change:

```ts
import { resolveApiKey } from "../lib/vault.js";
```

to:

```ts
import { resolveApiKey } from "@aula-agente/agent-runtime";
```

In `apps/worker/src/lib/audio-transcription.ts`, change:

```ts
import { resolveApiKey } from "./vault.js";
```

to:

```ts
import { resolveApiKey } from "@aula-agente/agent-runtime";
```

In `apps/worker/src/workers/process-document.ts`, change:

```ts
import { resolveApiKey } from "../lib/vault.js";
```

to:

```ts
import { resolveApiKey } from "@aula-agente/agent-runtime";
```

- [ ] **Step 5: Remove the now-empty directories**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && rmdir apps/worker/src/agents/tools apps/worker/src/agents 2>/dev/null; ls apps/worker/src/lib` — confirm `vault.ts` is gone from the listing and `apps/worker/src/agents` no longer exists (`git mv` already removed the files; this just cleans up the now-empty parent directories `git mv` leaves behind).

- [ ] **Step 6: Add the new dependency to `apps/worker/package.json` and `apps/api/package.json`**

In `apps/worker/package.json`, add to `dependencies`:

```json
"@aula-agente/agent-runtime": "workspace:*",
```

The `@ai-sdk/*`, `ai`, and `zod` dependencies already in `apps/worker/package.json` stay — `process-message.ts`/`process-document.ts`/other worker code may still need `zod` etc. directly; do not remove any existing dependency in this task, only add the new one.

In `apps/api/package.json`, add to `dependencies`:

```json
"@aula-agente/agent-runtime": "workspace:*",
```

(`apps/api` doesn't call anything from it yet — this is preparation for Task 9 — but installing it now means Step 9's verification catches any workspace-linking problem immediately, in this task, rather than surfacing confusingly two tasks later.)

- [ ] **Step 7: Install and typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm install && pnpm --filter @aula-agente/agent-runtime typecheck && pnpm --filter @aula-agente/worker typecheck && pnpm --filter @aula-agente/api typecheck`
Expected: no errors. If TypeScript flags `step.toolCalls`/`tc.toolName` field names inside the moved `agent-runner.ts` (lines that were already correct before the move, at the original `agent-runner.ts:103-105`), the move introduced a real path/resolution problem — stop and fix the import graph before continuing; do not change any logic to work around a type error here, since this task must not change behavior.

- [ ] **Step 8: Run the relocated tests to verify zero behavior change**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/agent-runtime test`
Expected: PASS — the exact same test bodies as `agent-runner.test.ts` and `search-catalog.test.ts` had before the move (diff the two versions with `git show HEAD:apps/worker/src/agents/agent-runner.test.ts` if in doubt — they must be byte-identical except for the file's new path).

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/worker test`
Expected: PASS — worker's own remaining tests (e.g. `audio-transcription.test.ts`) still pass with the new import path.

- [ ] **Step 9: Manually verify one real message end-to-end in local dev**

This is the check that actually proves production behavior is unchanged. Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm dev:worker` (in one terminal) and `pnpm dev:api` (in another), with Redis and the local Supabase DB running, then send a real test message through whatever local WhatsApp-simulation path you already used earlier in this project (or trigger the webhook route directly with a sample Evolution payload, as was done earlier in this session's Playground testing against Assis — here it's our own worker, not Assis).
Expected: the worker logs `Processed message ... -> response ...`, and the agent's reply arrives exactly as it would have before this task (same tools available, same reply style) — this task changed only where the code lives, not what it does.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: extract agent-runner and tools into packages/agent-runtime (no behavior change)

Moves apps/worker/src/agents/* and apps/worker/src/lib/vault.ts into a new
packages/agent-runtime workspace package so apps/api's upcoming Playground
route can reuse the exact same LLM-calling code instead of duplicating it.
Pure relocation: agent-runner.test.ts and search-catalog.test.ts pass
unchanged, and a real message was verified end-to-end through the worker."
```

---

### Task 8: Sandbox mode for side-effect tools + tool-call trace

**⚠️ Touches the real tool registry.** The new `sandbox` parameter defaults to falsy everywhere it's threaded through, so every existing call site (`apps/worker`'s real `runAgent` call in `process-message.ts`) keeps behaving exactly as before — this is additive, not a behavior change to the real path. The test in Step 2 is what proves that.

**Files:**
- Modify: `packages/agent-runtime/src/tools/registry.ts`
- Modify: `packages/agent-runtime/src/tools/registry.test.ts` (new file — registry had no dedicated test before)
- Modify: `packages/agent-runtime/src/agent-runner.ts` (thread `sandbox` through, add `extractToolCallTrace`)
- Modify: `packages/agent-runtime/src/agent-runner.test.ts` (add tests for the new function)
- Modify: `packages/agent-runtime/src/index.ts` (export the new function and type)

**Interfaces:**
- Consumes: `PlaygroundToolCall` (Task 2), `ToolsConfig` (existing).
- Produces: `buildToolsForAgent(params: RegistryParams & { sandbox?: boolean })`, `runAgent(params: RunAgentParams & { sandbox?: boolean })` (now also returns `toolCallTrace: PlaygroundToolCall[]` alongside the existing `toolCalls: string[]`), `extractToolCallTrace(steps, sandbox): PlaygroundToolCall[]` — Task 9's Playground route reads `result.toolCallTrace` directly.

- [ ] **Step 1: Write the failing test for sandboxed tool selection**

Create `packages/agent-runtime/src/tools/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildToolsForAgent } from "./registry.js";

const baseParams = {
  organizationId: "org-1",
  agentId: "agent-1",
  toolsConfig: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true },
  apiKey: "test-key",
  conversationId: "conv-1",
  instanceId: "instance-1",
  phone: "5511999998888",
  contactId: "contact-1",
};

describe("buildToolsForAgent sandbox mode", () => {
  it("builds the same tool names in sandbox mode as in real mode", () => {
    const real = buildToolsForAgent(baseParams);
    const sandboxed = buildToolsForAgent({ ...baseParams, sandbox: true });
    expect(Object.keys(sandboxed).sort()).toEqual(Object.keys(real).sort());
  });

  it("createTask in sandbox mode never imports or calls createTaskWithDedup", async () => {
    const sandboxed = buildToolsForAgent({ ...baseParams, sandbox: true });
    const result = await sandboxed.createTask.execute!(
      { type: "outro", description: "teste", due_date: "2026-08-01", priority: "normal", reason: "teste" },
      { toolCallId: "call-1", messages: [] }
    );
    expect(result).toContain("[SIMULADO]");
  });

  it("sendVehiclePhoto in sandbox mode does not enqueue a real WhatsApp send", async () => {
    const sandboxed = buildToolsForAgent({ ...baseParams, sandbox: true });
    const result = await sandboxed.sendVehiclePhoto.execute!(
      { model: "Factor 150" },
      { toolCallId: "call-2", messages: [] }
    );
    expect(result).toContain("[SIMULADO]");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/agent-runtime test -- registry`
Expected: FAIL — `sandboxed.createTask.execute is not a function` (real `createTask` requires DB access it doesn't have here, or `sandbox` param is simply ignored today so behavior is identical to `real`, not a `[SIMULADO]` response).

- [ ] **Step 3: Add sandbox mock tools and wire the flag into `registry.ts`**

Rewrite `packages/agent-runtime/src/tools/registry.ts`:

```ts
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolsConfig } from "@aula-agente/shared";
import { TASK_TYPES, TASK_PRIORITIES } from "@aula-agente/shared";
import { createSearchKnowledgeTool } from "./search-knowledge.js";
import { createSearchFaqTool } from "./search-faq.js";
import { createSearchCatalogTool } from "./search-catalog.js";
import { createSendVehiclePhotoTool } from "./send-vehicle-photo.js";
import { createCreateTaskTool } from "./create-task.js";

interface RegistryParams {
  organizationId: string;
  agentId: string;
  toolsConfig: ToolsConfig;
  apiKey: string;
  conversationId: string;
  instanceId: string;
  phone: string;
  contactId: string;
  sandbox?: boolean;
}

function createMockCreateTaskTool() {
  return tool({
    description:
      "Simula a criação de uma tarefa de follow-up comercial. Estamos no Playground de testes — nada é gravado de verdade.",
    inputSchema: z.object({
      type: z.enum(TASK_TYPES),
      description: z.string(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      priority: z.enum(TASK_PRIORITIES).default("normal"),
      reason: z.string(),
    }),
    execute: async ({ description, due_date }) => {
      return `[SIMULADO] Tarefa seria criada: "${description}" para ${due_date}.`;
    },
  });
}

function createMockSendVehiclePhotoTool() {
  return tool({
    description:
      "Simula o envio de uma foto de veículo pelo WhatsApp. Estamos no Playground de testes — nenhuma mensagem real é enviada.",
    inputSchema: z.object({ model: z.string() }),
    execute: async ({ model }) => {
      return `[SIMULADO] Foto de "${model}" seria enviada pelo WhatsApp agora.`;
    },
  });
}

export function buildToolsForAgent(params: RegistryParams): ToolSet {
  const { organizationId, agentId, toolsConfig, apiKey, conversationId, instanceId, phone, contactId, sandbox } = params;
  const tools: ToolSet = {};

  if (toolsConfig.search_knowledge) {
    tools.searchKnowledge = createSearchKnowledgeTool(organizationId, agentId, apiKey);
  }

  if (toolsConfig.search_faq) {
    tools.searchFaq = createSearchFaqTool(agentId);
  }

  if (toolsConfig.send_catalog_photo) {
    tools.searchCatalog = createSearchCatalogTool();
    tools.sendVehiclePhoto = sandbox
      ? createMockSendVehiclePhotoTool()
      : createSendVehiclePhotoTool({ conversationId, organizationId, instanceId, phone });
  }

  if (toolsConfig.create_task) {
    tools.createTask = sandbox
      ? createMockCreateTaskTool()
      : createCreateTaskTool({ contactId, conversationId, organizationId });
  }

  return tools;
}
```

`searchKnowledge`/`searchFaq`/`searchCatalog` are unconditionally the real factories regardless of `sandbox` — they are read-only (query knowledge base, FAQs, and the external catalog API respectively) and the Playground needs realistic answers from them to be useful, per the approved spec.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/agent-runtime test -- registry`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Write the failing test for `extractToolCallTrace`**

Add to `packages/agent-runtime/src/agent-runner.test.ts`, alongside the existing `describe` blocks:

```ts
import { extractToolCallTrace } from "./agent-runner.js";

describe("extractToolCallTrace", () => {
  it("marks every tool call as real when sandbox is false", () => {
    const steps = [
      {
        toolCalls: [{ toolCallId: "1", toolName: "searchKnowledge", input: { query: "preço" } }],
        toolResults: [{ toolCallId: "1", output: "resultado" }],
      },
    ];
    const trace = extractToolCallTrace(steps, false);
    expect(trace).toEqual([
      expect.objectContaining({ tool_name: "searchKnowledge", input: { query: "preço" }, output: "resultado", mode: "real" }),
    ]);
  });

  it("marks createTask and sendVehiclePhoto as simulated when sandbox is true, but leaves search tools real", () => {
    const steps = [
      {
        toolCalls: [
          { toolCallId: "1", toolName: "searchKnowledge", input: {} },
          { toolCallId: "2", toolName: "createTask", input: {} },
        ],
        toolResults: [
          { toolCallId: "1", output: "ok" },
          { toolCallId: "2", output: "[SIMULADO] ..." },
        ],
      },
    ];
    const trace = extractToolCallTrace(steps, true);
    expect(trace.find((t) => t.tool_name === "searchKnowledge")?.mode).toBe("real");
    expect(trace.find((t) => t.tool_name === "createTask")?.mode).toBe("simulated");
  });

  it("returns an empty array when no step made any tool call", () => {
    expect(extractToolCallTrace([{ toolCalls: [], toolResults: [] }], false)).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/agent-runtime test -- agent-runner`
Expected: FAIL — `extractToolCallTrace is not exported`.

- [ ] **Step 7: Add `extractToolCallTrace` and thread `sandbox` through `runAgent`**

Modify `packages/agent-runtime/src/agent-runner.ts`. First, verify the exact shape of `result.steps` in the installed `ai` SDK version — the existing line at (pre-move) `agent-runner.ts:103-105` already proves `step.toolCalls` and `tc.toolName` are the correct field names; run `grep -n "toolResults\|toolCalls" "/Users/weslleyvalente/Agente IA/superpowers/packages/agent-runtime/node_modules/ai/dist/index.d.ts" 2>/dev/null || grep -rn "toolResults" "/Users/weslleyvalente/Agente IA/superpowers/node_modules/.pnpm/ai@"*/node_modules/ai/dist/index.d.ts 2>/dev/null | head -5` to confirm `toolResults[].output` and `toolCalls[].input` are the field names (not `.args`/`.result`, which older SDK versions used) before writing the code below — adjust field names in Step 7's code and the tests in Step 5 together if they differ, then re-run Step 6.

```ts
import type { PlaygroundToolCall } from "@aula-agente/shared";
```

```ts
interface RunAgentParams {
  agent: Agent;
  messages: Message[];
  currentMessage: Message;
  apiKey: string;
  organizationId: string;
  conversationId: string;
  instanceId: string;
  phone: string;
  contactId: string;
  sandbox?: boolean;
}

interface RunAgentResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolCalls: string[];
  toolCallTrace: PlaygroundToolCall[];
}
```

```ts
const SANDBOXED_TOOL_NAMES = new Set(["createTask", "sendVehiclePhoto"]);

export function extractToolCallTrace(
  steps: Array<{
    toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
    toolResults?: Array<{ toolCallId: string; output: unknown }>;
  }>,
  sandbox: boolean
): PlaygroundToolCall[] {
  const trace: PlaygroundToolCall[] = [];
  const executedAt = new Date().toISOString();
  for (const step of steps) {
    const outputsByCallId = new Map((step.toolResults || []).map((r) => [r.toolCallId, r.output]));
    for (const call of step.toolCalls || []) {
      trace.push({
        tool_name: call.toolName,
        input: call.input,
        output: outputsByCallId.get(call.toolCallId) ?? null,
        mode: sandbox && SANDBOXED_TOOL_NAMES.has(call.toolName) ? "simulated" : "real",
        executed_at: executedAt,
      });
    }
  }
  return trace;
}
```

Then, inside `runAgent`, pass `sandbox` to `buildToolsForAgent` and populate `toolCallTrace` on the result:

```ts
  const tools = buildToolsForAgent({
    organizationId,
    agentId: agent.id,
    toolsConfig: agent.tools_config,
    apiKey,
    conversationId,
    instanceId,
    phone,
    contactId,
    sandbox: params.sandbox,
  });
```

```ts
  return {
    text: result.text,
    model: agent.model,
    inputTokens: result.usage?.inputTokens || 0,
    outputTokens: result.usage?.outputTokens || 0,
    latencyMs,
    toolCalls,
    toolCallTrace: extractToolCallTrace(result.steps, params.sandbox ?? false),
  };
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/agent-runtime test -- agent-runner`
Expected: PASS, all tests green (the 3 pre-existing `formatHistoryForLLM`/`buildSystemPrompt` tests plus the 3 new `extractToolCallTrace` ones).

- [ ] **Step 9: Export the new function and type from the package entry**

Add to `packages/agent-runtime/src/index.ts`:

```ts
export { extractToolCallTrace } from "./agent-runner.js";
```

- [ ] **Step 10: Confirm the real worker path is unaffected**

`process-message.ts` calls `runAgent({...})` without a `sandbox` field — since the new field is optional (`sandbox?: boolean`) and every branch that checks it treats `undefined` the same as `false`, this compiles and behaves identically to before. Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/worker typecheck && pnpm --filter @aula-agente/worker test`
Expected: no errors, all pass — `process-message.ts` needed no changes for this task.

- [ ] **Step 11: Run full package test suite and typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/agent-runtime test && pnpm --filter @aula-agente/agent-runtime typecheck`
Expected: all pass, no errors.

- [ ] **Step 12: Commit**

```bash
git add packages/agent-runtime/src/tools/registry.ts packages/agent-runtime/src/tools/registry.test.ts packages/agent-runtime/src/agent-runner.ts packages/agent-runtime/src/agent-runner.test.ts packages/agent-runtime/src/index.ts
git commit -m "feat(agent-runtime): add sandbox mode for side-effect tools and tool-call trace

sandbox defaults to falsy everywhere; the real worker path (process-message.ts)
passes no sandbox flag at all, so its behavior is unchanged, verified by the
untouched pre-existing test suite still passing."
```

---

### Task 9: Playground API routes

**Files:**
- Create: `apps/api/src/services/playground.service.ts`
- Create: `apps/api/src/services/playground.service.test.ts`
- Modify: `apps/api/src/routes/agent-config/index.ts` (add 2 routes)

**Interfaces:**
- Consumes: `createPlaygroundSession`, `addPlaygroundMessage`, `getPlaygroundMessages` (Task 3), `runAgent` (Task 8, via `@aula-agente/agent-runtime`), `compileSystemPrompt` (Task 4), `getOrCreateAgentConfig` (Task 3), `resolveApiKey` (Task 7).
- Produces: `sendPlaygroundMessage(db, params): Promise<AgentPlaygroundMessage>` (service); `POST /agents/:agentId/playground/sessions`, `POST /agents/:agentId/playground/sessions/:sessionId/messages` (consumed by Task 15's Playground UI).

This is the first task where the draft's compiled prompt actually runs against a real LLM — but only from a brand-new route nothing in production calls, using `sandbox: true` so no real WhatsApp/task side effect can occur even if a bug elsewhere let this route be reached unexpectedly.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/playground.service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAgentById, getOrCreateAgentConfig, addPlaygroundMessage, getPlaygroundMessages, resolveApiKey, runAgent } = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getOrCreateAgentConfig: vi.fn(),
  addPlaygroundMessage: vi.fn(),
  getPlaygroundMessages: vi.fn(),
  resolveApiKey: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ getAgentById, getOrCreateAgentConfig, addPlaygroundMessage, getPlaygroundMessages }));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey, runAgent }));

import { sendPlaygroundMessage } from "./playground.service.js";

const baseAgent = {
  id: "agent-1", organization_id: "org-1", name: "Helena", description: "",
  system_prompt: "publicado", model: "gpt-4o-mini", provider: "openai" as const,
  temperature: 0.7, max_tokens: 1024,
  tools_config: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true },
  is_active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

const baseDraft = {
  id: "config-1", agent_id: "agent-1", organization_id: "org-1", base_version_id: null,
  identity: { nome: "Helena", funcao: "", missao: "" },
  personality: {
    tom_de_voz: "equilibrado" as const, tom_de_voz_personalizado: "", tamanho_resposta: "curta" as const,
    emojis: { ativo: true, maximo: 1, instrucao: "" }, perguntas_por_vez: { maximo: 1 },
    postura_comercial: { tipo: "", instrucao: "" }, girias_proibidas: [], proatividade: "",
  },
  rules: {
    transferencia_para_humano: [], promessas_proibidas: [], regras_por_tipo: [],
    preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" }, objecoes: [],
  },
  knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
  playbook: { script_atendimento: "" },
  tools_config: baseAgent.tools_config,
  model_settings: { provider: "openai" as const, model: "gpt-4o-mini", temperature: 0.7, max_tokens: 1024 },
  updated_at: "2026-01-01T00:00:00Z", updated_by: null,
};

describe("sendPlaygroundMessage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue(baseAgent);
    getOrCreateAgentConfig.mockResolvedValue(baseDraft);
    getPlaygroundMessages.mockResolvedValue([]);
    resolveApiKey.mockResolvedValue("test-key");
    runAgent.mockResolvedValue({
      text: "Olá! Como posso ajudar?", model: "gpt-4o-mini", inputTokens: 10, outputTokens: 5,
      latencyMs: 100, toolCalls: [], toolCallTrace: [],
    });
    addPlaygroundMessage.mockImplementation((_db: unknown, params: any) =>
      Promise.resolve({ id: "msg-1", session_id: params.sessionId, organization_id: params.organizationId, role: params.role, content: params.content, tool_calls: params.toolCalls ?? [], created_at: "2026-01-01T00:00:00Z" })
    );
  });

  it("always calls runAgent with sandbox: true, never false or omitted", async () => {
    await sendPlaygroundMessage({} as any, {
      agentId: "agent-1", organizationId: "org-1", sessionId: "session-1", content: "Oi",
    });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ sandbox: true }));
  });

  it("compiles the draft (not the published system_prompt) as the system prompt for the run", async () => {
    await sendPlaygroundMessage({} as any, {
      agentId: "agent-1", organizationId: "org-1", sessionId: "session-1", content: "Oi",
    });

    const callArg = runAgent.mock.calls[0][0];
    expect(callArg.agent.system_prompt).not.toBe("publicado");
  });

  it("saves both the user message and the assistant reply, with the tool trace on the assistant message", async () => {
    runAgent.mockResolvedValue({
      text: "Resposta", model: "gpt-4o-mini", inputTokens: 1, outputTokens: 1, latencyMs: 1,
      toolCalls: ["searchKnowledge"],
      toolCallTrace: [{ tool_name: "searchKnowledge", input: {}, output: "ok", mode: "real", executed_at: "2026-01-01T00:00:00Z" }],
    });

    const result = await sendPlaygroundMessage({} as any, {
      agentId: "agent-1", organizationId: "org-1", sessionId: "session-1", content: "Oi",
    });

    expect(addPlaygroundMessage).toHaveBeenCalledWith({}, expect.objectContaining({ role: "user", content: "Oi" }));
    expect(addPlaygroundMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        role: "assistant",
        content: "Resposta",
        toolCalls: [expect.objectContaining({ tool_name: "searchKnowledge", mode: "real" })],
      })
    );
    expect(result.content).toBe("Resposta");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- playground.service`
Expected: FAIL — `Cannot find module './playground.service.js'`.

- [ ] **Step 3: Write `apps/api/src/services/playground.service.ts`**

The Playground never touches real `conversations`/`wa_contacts` rows, so it passes synthetic, obviously-fake IDs for the context fields `runAgent` needs (`conversationId`, `instanceId`, `phone`, `contactId`) — those only matter to the two mocked-in-sandbox tools (`sendVehiclePhoto`, `createTask`), which never actually use them for real I/O when `sandbox: true`.

```ts
import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById, getOrCreateAgentConfig, addPlaygroundMessage, getPlaygroundMessages } from "@aula-agente/database";
import { resolveApiKey, runAgent } from "@aula-agente/agent-runtime";
import { compileSystemPrompt } from "@aula-agente/shared";
import type { AgentPlaygroundMessage, Message } from "@aula-agente/shared";

interface SendPlaygroundMessageParams {
  agentId: string;
  organizationId: string;
  sessionId: string;
  content: string;
}

function toRunnerHistory(messages: AgentPlaygroundMessage[]): Message[] {
  return messages.map((m) => ({
    id: m.id,
    conversation_id: "playground",
    organization_id: m.organization_id,
    evolution_message_id: null,
    role: m.role === "user" ? "contact" : "agent",
    content: m.content,
    media_url: null,
    media_type: null,
    metadata: null,
    created_at: m.created_at,
  }));
}

export async function sendPlaygroundMessage(
  db: SupabaseClient,
  params: SendPlaygroundMessageParams
): Promise<AgentPlaygroundMessage> {
  const agent = await getAgentById(db, params.agentId);
  const draft = await getOrCreateAgentConfig(db, agent);
  const priorMessages = await getPlaygroundMessages(db, params.sessionId);

  await addPlaygroundMessage(db, {
    sessionId: params.sessionId,
    organizationId: params.organizationId,
    role: "user",
    content: params.content,
  });

  const compiledPrompt = compileSystemPrompt({
    identity: draft.identity,
    personality: draft.personality,
    rules: draft.rules,
    knowledge: draft.knowledge,
    playbook: draft.playbook,
  });

  const apiKey = await resolveApiKey(params.organizationId, draft.model_settings.provider);

  const result = await runAgent({
    agent: { ...agent, system_prompt: compiledPrompt, ...draft.model_settings, tools_config: draft.tools_config },
    messages: toRunnerHistory(priorMessages),
    currentMessage: {
      id: "playground-current", conversation_id: "playground", organization_id: params.organizationId,
      evolution_message_id: null, role: "contact", content: params.content,
      media_url: null, media_type: null, metadata: null, created_at: new Date().toISOString(),
    },
    apiKey,
    organizationId: params.organizationId,
    conversationId: "playground",
    instanceId: "playground",
    phone: "0000000000",
    contactId: "playground",
    sandbox: true,
  });

  return addPlaygroundMessage(db, {
    sessionId: params.sessionId,
    organizationId: params.organizationId,
    role: "assistant",
    content: result.text,
    toolCalls: result.toolCallTrace,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- playground.service`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Add the 2 playground routes**

Add to `apps/api/src/routes/agent-config/index.ts` (extend imports and add routes before the publish route):

```ts
import { getAdminClient, getAgentById, createPlaygroundSession, getPlaygroundMessages } from "@aula-agente/database";
import { sendPlaygroundMessage } from "../../services/playground.service.js";
```

```ts
app.post<{ Params: { agentId: string } }>("/agents/:agentId/playground/sessions", async (request, reply) => {
  const db = getAdminClient();
  const agent = await getAgentById(db, request.params.agentId);
  const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
  if (!membership) return reply.status(403).send({ error: "Access denied" });

  const session = await createPlaygroundSession(db, {
    agentId: request.params.agentId,
    organizationId: agent.organization_id,
    createdBy: request.user.id,
  });
  return reply.status(201).send(session);
});

app.post<{ Params: { agentId: string; sessionId: string }; Body: { content: string } }>(
  "/agents/:agentId/playground/sessions/:sessionId/messages",
  async (request, reply) => {
    const { content } = request.body ?? {};
    if (!content || typeof content !== "string") {
      return reply.status(400).send({ error: "content is required" });
    }

    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    const message = await sendPlaygroundMessage(db, {
      agentId: request.params.agentId,
      organizationId: agent.organization_id,
      sessionId: request.params.sessionId,
      content,
    });
    return reply.status(201).send(message);
  }
);

app.get<{ Params: { agentId: string; sessionId: string } }>(
  "/agents/:agentId/playground/sessions/:sessionId/messages",
  async (request, reply) => {
    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return getPlaygroundMessages(db, request.params.sessionId);
  }
);
```

- [ ] **Step 6: Run full API test suite and typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test && pnpm --filter @aula-agente/api typecheck`
Expected: all pass, no errors.

- [ ] **Step 7: Manually verify no real side effects, against a disposable test agent**

With `apps/api` running locally, create a session and send a message that would trigger `create_task` on the disposable test agent from Task 5 (e.g. "Pode me ligar amanhã às 10h, vou te passar meus dados"), then check `SELECT count(*) FROM tasks WHERE organization_id = '<test org>';` before and after — the count must not change. Check `agent_playground_messages.tool_calls` for that session instead — it should contain an entry with `"mode": "simulated"` and content starting with `[SIMULADO]`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/playground.service.ts apps/api/src/services/playground.service.test.ts apps/api/src/routes/agent-config/index.ts
git commit -m "feat(api): add Playground routes running the draft config in sandbox mode"
```

---

### Task 10: Frontend scaffold — routing, shared editors, Geral section

**Files:**
- Create: `apps/web/src/components/agents/config/use-agent-config.ts`
- Create: `apps/web/src/components/agents/config/list-editor.tsx`
- Create: `apps/web/src/components/agents/config/tag-input.tsx`
- Create: `apps/web/src/components/agents/config/geral-section.tsx`
- Create: `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/agents/[agentId]/page.tsx` (becomes a redirect)

**Interfaces:**
- Consumes: `AgentConfigDraft`, `AgentModelSettings` (Task 2), `apiFetch` (existing, `apps/web/src/lib/api.ts`), `useOrganization` (existing).
- Produces: `useAgentConfig(agentId)` returning `{ status, loading, patch, refetch }` (consumed by Tasks 11-15); `<ListEditor>` and `<TagInput>` generic components (consumed by Tasks 11-13); the `editar/` route itself, which Tasks 11-15 progressively extend with more sections and tabs.

No existing route or component is deleted in this task — the old `/agents/[agentId]` page becomes a redirect, so any bookmark or link to it keeps working.

- [ ] **Step 1: Write the draft-fetching hook**

Create `apps/web/src/components/agents/config/use-agent-config.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { AgentConfigDraft, AgentVersion } from "@aula-agente/shared";

export interface AgentConfigStatus {
  draft: AgentConfigDraft;
  latestVersion: AgentVersion | null;
  changedSections: string[];
  hasPendingChanges: boolean;
}

type ConfigPatch = Partial<
  Pick<AgentConfigDraft, "identity" | "personality" | "rules" | "knowledge" | "playbook" | "tools_config" | "model_settings">
>;

export function useAgentConfig(agentId: string) {
  const [status, setStatus] = useState<AgentConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    const data = (await apiFetch(`/agents/${agentId}/config`)) as AgentConfigStatus;
    setStatus(data);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const patch = useCallback(
    async (body: ConfigPatch) => {
      await apiFetch(`/agents/${agentId}/config`, { method: "PATCH", body: JSON.stringify(body) });
      await refetch();
    },
    [agentId, refetch]
  );

  return { status, loading, patch, refetch };
}
```

- [ ] **Step 2: Write the generic list editor**

Create `apps/web/src/components/agents/config/list-editor.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Trash2, Plus } from "lucide-react";

interface ListEditorField<T> {
  key: keyof T;
  label: string;
  type: "text" | "textarea";
}

interface ListEditorProps<T extends { id: string; ativo: boolean }> {
  items: T[];
  fields: ListEditorField<T>[];
  titleKey: keyof T;
  emptyItem: () => T;
  onChange: (items: T[]) => void;
  addLabel: string;
}

export function ListEditor<T extends { id: string; ativo: boolean }>({
  items,
  fields,
  titleKey,
  emptyItem,
  onChange,
  addLabel,
}: ListEditorProps<T>) {
  const updateItem = (index: number, patch: Partial<T>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };
  const removeItem = (index: number) => onChange(items.filter((_, i) => i !== index));
  const addItem = () => onChange([...items, emptyItem()]);

  return (
    <div className="space-y-4">
      {items.map((item, index) => (
        <Card key={item.id}>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center justify-between">
              <p className="font-medium">{String(item[titleKey]) || "(sem título)"}</p>
              <div className="flex items-center gap-2">
                <Switch checked={item.ativo} onCheckedChange={(v) => updateItem(index, { ativo: v } as Partial<T>)} />
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeItem(index)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {fields.map((field) => (
              <div key={String(field.key)} className="space-y-1">
                <Label>{field.label}</Label>
                {field.type === "textarea" ? (
                  <Textarea
                    value={String(item[field.key] ?? "")}
                    onChange={(e) => updateItem(index, { [field.key]: e.target.value } as Partial<T>)}
                  />
                ) : (
                  <Input
                    value={String(item[field.key] ?? "")}
                    onChange={(e) => updateItem(index, { [field.key]: e.target.value } as Partial<T>)}
                  />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
      <Button type="button" variant="outline" onClick={addItem}>
        <Plus className="mr-2 h-4 w-4" /> {addLabel}
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Write the tag input**

Create `apps/web/src/components/agents/config/tag-input.tsx`:

```tsx
"use client";

import { useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

export function TagInput({ tags, onChange, placeholder }: TagInputProps) {
  const [draft, setDraft] = useState("");

  const commitDraft = () => {
    const value = draft.trim();
    if (value && !tags.includes(value)) onChange([...tags, value]);
    setDraft("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitDraft();
    }
  };

  return (
    <div className="space-y-2">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1">
              {tag}
              <button type="button" onClick={() => onChange(tags.filter((t) => t !== tag))} aria-label={`Remover ${tag}`}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={handleKeyDown} onBlur={commitDraft} placeholder={placeholder} />
    </div>
  );
}
```

- [ ] **Step 4: Write the Geral section (Identidade + Modelo)**

Create `apps/web/src/components/agents/config/geral-section.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AgentConfigDraft, AgentModelSettings } from "@aula-agente/shared";

const PROVIDER_LABELS: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google" };
const MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  anthropic: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
  google: ["gemini-2.0-flash", "gemini-2.0-flash-lite"],
};

interface GeralSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { identity?: AgentConfigDraft["identity"]; model_settings?: AgentModelSettings }) => Promise<void>;
}

export function GeralSection({ draft, onPatch }: GeralSectionProps) {
  const [identity, setIdentity] = useState(draft.identity);
  const [modelSettings, setModelSettings] = useState(draft.model_settings);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Identidade</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input value={identity.nome} onChange={(e) => setIdentity({ ...identity, nome: e.target.value })} onBlur={() => onPatch({ identity })} />
          </div>
          <div className="space-y-2">
            <Label>Função</Label>
            <Input value={identity.funcao} onChange={(e) => setIdentity({ ...identity, funcao: e.target.value })} onBlur={() => onPatch({ identity })} />
          </div>
          <div className="space-y-2">
            <Label>Missão / instruções principais</Label>
            <Textarea rows={8} value={identity.missao} onChange={(e) => setIdentity({ ...identity, missao: e.target.value })} onBlur={() => onPatch({ identity })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Modelo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Provider</Label>
              <Select
                value={modelSettings.provider}
                onValueChange={(v) => {
                  if (!v) return;
                  const next = { ...modelSettings, provider: v as AgentModelSettings["provider"], model: MODELS[v][0] };
                  setModelSettings(next);
                  onPatch({ model_settings: next });
                }}
              >
                <SelectTrigger>
                  <SelectValue>{(value: string) => PROVIDER_LABELS[value] ?? value}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Modelo</Label>
              <Select
                value={modelSettings.model}
                onValueChange={(v) => {
                  if (!v) return;
                  const next = { ...modelSettings, model: v };
                  setModelSettings(next);
                  onPatch({ model_settings: next });
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(MODELS[modelSettings.provider] || []).map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Temperatura ({modelSettings.temperature})</Label>
              <Input
                type="range" min="0" max="2" step="0.1"
                value={modelSettings.temperature}
                onChange={(e) => setModelSettings({ ...modelSettings, temperature: Number(e.target.value) })}
                onMouseUp={() => onPatch({ model_settings: modelSettings })}
              />
            </div>
            <div className="space-y-2">
              <Label>Max Tokens</Label>
              <Input
                type="number"
                value={modelSettings.max_tokens}
                onChange={(e) => setModelSettings({ ...modelSettings, max_tokens: Number(e.target.value) })}
                onBlur={() => onPatch({ model_settings: modelSettings })}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

Every field saves `onBlur` (or `onMouseUp` for the range slider) rather than on every keystroke — this matches the granularity the PATCH endpoint expects (one section object per call) without spamming the API on every character typed, while still feeling immediate since there's no separate "Save" button per field.

- [ ] **Step 5: Write the new page**

Create `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAgentConfig } from "@/components/agents/config/use-agent-config";
import { GeralSection } from "@/components/agents/config/geral-section";

const SECTIONS = [{ key: "geral", label: "Geral" }] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

export default function AgentEditarPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { status, loading, patch } = useAgentConfig(agentId);
  const [activeSection, setActiveSection] = useState<SectionKey>("geral");

  if (loading || !status) return <div className="p-6">Carregando configuração...</div>;

  return (
    <div className="grid grid-cols-[200px_1fr] gap-6">
      <nav className="space-y-1">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActiveSection(s.key)}
            className={cn(
              "block w-full rounded-md px-3 py-2 text-left text-sm",
              activeSection === s.key ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
            )}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div>{activeSection === "geral" && <GeralSection draft={status.draft} onPatch={patch} />}</div>
    </div>
  );
}
```

- [ ] **Step 6: Turn the old page into a redirect**

Replace the entire contents of `apps/web/src/app/(dashboard)/agents/[agentId]/page.tsx` with:

```tsx
"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function AgentPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/agents/${agentId}/editar`);
  }, [agentId, router]);

  return null;
}
```

The old form (`AgentForm`, `system_prompt` textarea, tool switches) is not deleted yet — it's simply no longer linked to from anywhere new. `apps/web/src/components/agents/agent-form.tsx` and the `/agents/new` creation flow are untouched by this task (creating a brand-new agent still needs a `system_prompt` — Task 20 addresses whether/how that changes; out of scope here).

- [ ] **Step 7: Typecheck and manually verify in the browser**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/web typecheck`
Expected: no errors.

Run: `pnpm dev:web` and `pnpm dev:api`, then in the browser navigate to `/agents/<any-existing-agent-id>` — it should immediately redirect to `/agents/<id>/editar`, which loads the Geral section pre-filled from whatever `agent_configs` row gets lazy-created (empty Nome/Função/Missão the first time, current provider/model/temperature/max_tokens copied from the agent's published values). Edit the Nome field, click elsewhere (blur), then reload the page — the edited value must persist (proves the PATCH round-trip works).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/agents/config apps/web/src/app/\(dashboard\)/agents/\[agentId\]/editar apps/web/src/app/\(dashboard\)/agents/\[agentId\]/page.tsx
git commit -m "feat(web): add Central de Configuração scaffold with Geral (Identidade + Modelo) section"
```

---

### Task 11: Frontend — Personalidade section

**Files:**
- Create: `apps/web/src/components/agents/config/personalidade-section.tsx`
- Modify: `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx` (add to `SECTIONS` and the switch)

**Interfaces:**
- Consumes: `AgentPersonality` (Task 2), `TagInput` (Task 10).
- Produces: nothing new consumed elsewhere — this is a leaf UI module.

- [ ] **Step 1: Write the Personalidade section**

Create `apps/web/src/components/agents/config/personalidade-section.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagInput } from "./tag-input";
import type { AgentConfigDraft, AgentPersonality } from "@aula-agente/shared";

const TOM_LABELS: Record<AgentPersonality["tom_de_voz"], string> = {
  profissional: "Profissional", equilibrado: "Equilibrado", amigavel: "Amigável",
  divertido: "Divertido", personalizado: "Personalizado",
};
const TAMANHO_LABELS: Record<AgentPersonality["tamanho_resposta"], string> = {
  curta: "Curta", media: "Média", detalhada: "Detalhada",
};

interface PersonalidadeSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { personality: AgentPersonality }) => Promise<void>;
}

export function PersonalidadeSection({ draft, onPatch }: PersonalidadeSectionProps) {
  const [personality, setPersonality] = useState(draft.personality);

  const save = (next: AgentPersonality) => {
    setPersonality(next);
    onPatch({ personality: next });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Tom de voz e tamanho das respostas</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Tom de voz</Label>
              <Select value={personality.tom_de_voz} onValueChange={(v) => v && save({ ...personality, tom_de_voz: v as AgentPersonality["tom_de_voz"] })}>
                <SelectTrigger><SelectValue>{(value: string) => TOM_LABELS[value as AgentPersonality["tom_de_voz"]]}</SelectValue></SelectTrigger>
                <SelectContent>
                  {Object.entries(TOM_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Tamanho das respostas</Label>
              <Select value={personality.tamanho_resposta} onValueChange={(v) => v && save({ ...personality, tamanho_resposta: v as AgentPersonality["tamanho_resposta"] })}>
                <SelectTrigger><SelectValue>{(value: string) => TAMANHO_LABELS[value as AgentPersonality["tamanho_resposta"]]}</SelectValue></SelectTrigger>
                <SelectContent>
                  {Object.entries(TAMANHO_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {personality.tom_de_voz === "personalizado" && (
            <div className="space-y-2">
              <Label>Descreva o tom personalizado</Label>
              <Textarea
                value={personality.tom_de_voz_personalizado}
                onChange={(e) => setPersonality({ ...personality, tom_de_voz_personalizado: e.target.value })}
                onBlur={() => save(personality)}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Emojis</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Ativo</Label>
            <Switch checked={personality.emojis.ativo} onCheckedChange={(v) => save({ ...personality, emojis: { ...personality.emojis, ativo: v } })} />
          </div>
          <div className="space-y-2">
            <Label>Máximo por mensagem</Label>
            <Input
              type="number" min={0} max={5}
              value={personality.emojis.maximo}
              onChange={(e) => setPersonality({ ...personality, emojis: { ...personality.emojis, maximo: Number(e.target.value) } })}
              onBlur={() => save(personality)}
            />
          </div>
          <div className="space-y-2">
            <Label>Instrução adicional</Label>
            <Input
              value={personality.emojis.instrucao}
              placeholder="Ex.: no máximo um emoji quando realmente fizer sentido"
              onChange={(e) => setPersonality({ ...personality, emojis: { ...personality.emojis, instrucao: e.target.value } })}
              onBlur={() => save(personality)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Perguntas por vez</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label>Máximo de perguntas por mensagem</Label>
            <Input
              type="number" min={1} max={5}
              value={personality.perguntas_por_vez.maximo}
              onChange={(e) => setPersonality({ ...personality, perguntas_por_vez: { maximo: Number(e.target.value) } })}
              onBlur={() => save(personality)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Postura comercial</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Tipo</Label>
            <Input
              value={personality.postura_comercial.tipo}
              placeholder="Ex.: Consultiva / qualificadora"
              onChange={(e) => setPersonality({ ...personality, postura_comercial: { ...personality.postura_comercial, tipo: e.target.value } })}
              onBlur={() => save(personality)}
            />
          </div>
          <div className="space-y-2">
            <Label>Instrução</Label>
            <Textarea
              value={personality.postura_comercial.instrucao}
              placeholder="Ajudar o cliente a decidir; não pressionar; não forçar venda; entender antes de oferecer."
              onChange={(e) => setPersonality({ ...personality, postura_comercial: { ...personality.postura_comercial, instrucao: e.target.value } })}
              onBlur={() => save(personality)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Gírias e expressões proibidas</CardTitle></CardHeader>
        <CardContent>
          <TagInput
            tags={personality.girias_proibidas}
            onChange={(tags) => save({ ...personality, girias_proibidas: tags })}
            placeholder="Digite uma expressão e pressione Enter"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Proatividade</CardTitle></CardHeader>
        <CardContent>
          <Textarea
            rows={6}
            value={personality.proatividade}
            onChange={(e) => setPersonality({ ...personality, proatividade: e.target.value })}
            onBlur={() => save(personality)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the page's left nav**

Modify `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`:

```tsx
import { PersonalidadeSection } from "@/components/agents/config/personalidade-section";
```

```tsx
const SECTIONS = [
  { key: "geral", label: "Geral" },
  { key: "personalidade", label: "Personalidade" },
] as const;
```

```tsx
{activeSection === "personalidade" && <PersonalidadeSection draft={status.draft} onPatch={patch} />}
```

(add this line right after the existing `{activeSection === "geral" && ...}` line, inside the same `<div>`)

- [ ] **Step 3: Typecheck and manually verify**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/web typecheck`
Expected: no errors.

In the browser, open the Personalidade section: switch Tom de voz to "Personalizado" and confirm the extra textarea appears; toggle Emojis off and confirm the max/instruction fields are still editable (they just won't be compiled into the prompt when inactive, per Task 4's `compileIdentitySection`... actually `compilePersonalitySection` — verify against Task 4's code); add and remove a couple of gírias tags; reload the page and confirm everything persisted.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agents/config/personalidade-section.tsx "apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx"
git commit -m "feat(web): add Personalidade section to Central de Configuração"
```

---

### Task 12: Frontend — Regras section

**Files:**
- Create: `apps/web/src/components/agents/config/regras-section.tsx`
- Modify: `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx` (add to `SECTIONS` and the switch)

**Interfaces:**
- Consumes: `AgentRules`, `AgentRuleItem`, `AgentTypeRuleItem`, `AgentObjecao` (Task 2), `ListEditor` (Task 10).
- Produces: nothing new consumed elsewhere — leaf UI module.

- [ ] **Step 1: Write the Regras section**

Create `apps/web/src/components/agents/config/regras-section.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ListEditor } from "./list-editor";
import type { AgentConfigDraft, AgentRules } from "@aula-agente/shared";

interface RegrasSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { rules: AgentRules }) => Promise<void>;
}

export function RegrasSection({ draft, onPatch }: RegrasSectionProps) {
  const [rules, setRules] = useState(draft.rules);

  const save = (next: AgentRules) => {
    setRules(next);
    onPatch({ rules: next });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Transferência para humano</CardTitle></CardHeader>
        <CardContent>
          <ListEditor
            items={rules.transferencia_para_humano}
            titleKey="label"
            fields={[
              { key: "label", label: "Gatilho", type: "text" },
              { key: "instrucao", label: "O que a Helena deve fazer/dizer", type: "textarea" },
            ]}
            emptyItem={() => ({ id: crypto.randomUUID(), label: "", instrucao: "", ativo: true })}
            onChange={(items) => save({ ...rules, transferencia_para_humano: items })}
            addLabel="+ Novo gatilho"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Promessas proibidas</CardTitle></CardHeader>
        <CardContent>
          <ListEditor
            items={rules.promessas_proibidas}
            titleKey="label"
            fields={[
              { key: "label", label: "Título", type: "text" },
              { key: "instrucao", label: "Regra", type: "textarea" },
            ]}
            emptyItem={() => ({ id: crypto.randomUUID(), label: "", instrucao: "", ativo: true })}
            onChange={(items) => save({ ...rules, promessas_proibidas: items })}
            addLabel="+ Nova promessa proibida"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Regras por tipo de atendimento</CardTitle></CardHeader>
        <CardContent>
          <ListEditor
            items={rules.regras_por_tipo}
            titleKey="categoria"
            fields={[
              { key: "categoria", label: "Categoria", type: "text" },
              { key: "instrucao", label: "Instruções específicas", type: "textarea" },
            ]}
            emptyItem={() => ({ id: crypto.randomUUID(), categoria: "", instrucao: "", ativo: true })}
            onChange={(items) => save({ ...rules, regras_por_tipo: items })}
            addLabel="+ Nova categoria"
          />
          <p className="mt-2 text-sm text-muted-foreground">
            Sugestões de categoria: Consórcio, Financiamento, Moto 0 km, Moto seminova, Carro seminovo, Carta contemplada, Oficina, Peças, Outros.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Preço e desconto</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Pode fazer autonomamente</Label>
            <Textarea
              value={rules.preco_desconto.pode_autonomo}
              onChange={(e) => setRules({ ...rules, preco_desconto: { ...rules.preco_desconto, pode_autonomo: e.target.value } })}
              onBlur={() => save(rules)}
            />
          </div>
          <div className="space-y-2">
            <Label>Exige humano</Label>
            <Textarea
              value={rules.preco_desconto.exige_humano}
              onChange={(e) => setRules({ ...rules, preco_desconto: { ...rules.preco_desconto, exige_humano: e.target.value } })}
              onBlur={() => save(rules)}
            />
          </div>
          <div className="space-y-2">
            <Label>Nunca pode fazer</Label>
            <Textarea
              value={rules.preco_desconto.nunca_pode}
              onChange={(e) => setRules({ ...rules, preco_desconto: { ...rules.preco_desconto, nunca_pode: e.target.value } })}
              onBlur={() => save(rules)}
            />
          </div>
          <div className="space-y-2">
            <Label>Observações</Label>
            <Textarea
              value={rules.preco_desconto.observacoes}
              onChange={(e) => setRules({ ...rules, preco_desconto: { ...rules.preco_desconto, observacoes: e.target.value } })}
              onBlur={() => save(rules)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Objeções</CardTitle></CardHeader>
        <CardContent>
          <ListEditor
            items={rules.objecoes}
            titleKey="nome"
            fields={[
              { key: "nome", label: "Nome (ex.: Preço alto)", type: "text" },
              { key: "como_identificar", label: "Como identificar", type: "textarea" },
              { key: "orientacao", label: "Orientação de resposta", type: "textarea" },
              { key: "pergunta_diagnostico", label: "Pergunta de diagnóstico", type: "text" },
              { key: "quando_escalar", label: "Quando transferir para humano", type: "text" },
            ]}
            emptyItem={() => ({
              id: crypto.randomUUID(), nome: "", como_identificar: "", orientacao: "",
              pergunta_diagnostico: "", quando_escalar: "", ativo: true,
            })}
            onChange={(items) => save({ ...rules, objecoes: items })}
            addLabel="+ Nova objeção"
          />
        </CardContent>
      </Card>
    </div>
  );
}
```

Every `AgentObjecao`'s `id` is a stable UUID generated once, at creation, and never regenerated on edit — this is what the approved spec means by preparing objection data for future measurement of which objections come up most often in conversations: a future feature can log that stable `id`, not the mutable `nome` text, alongside a conversation.

- [ ] **Step 2: Wire it into the page**

Modify `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`:

```tsx
import { RegrasSection } from "@/components/agents/config/regras-section";
```

```tsx
const SECTIONS = [
  { key: "geral", label: "Geral" },
  { key: "personalidade", label: "Personalidade" },
  { key: "regras", label: "Regras" },
] as const;
```

```tsx
{activeSection === "regras" && <RegrasSection draft={status.draft} onPatch={patch} />}
```

- [ ] **Step 3: Typecheck and manually verify**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/web typecheck`
Expected: no errors.

In the browser: add a handoff trigger, a forbidden promise, a category rule, and an objection; toggle one item's Ativo switch off; remove one item entirely; reload and confirm all of it persisted, including the inactive-but-still-saved item.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agents/config/regras-section.tsx "apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx"
git commit -m "feat(web): add Regras section to Central de Configuração"
```

---

### Task 13: Frontend — Conhecimento, Playbooks, and Ferramentas sections

**Files:**
- Create: `apps/web/src/components/agents/config/conhecimento-section.tsx`
- Create: `apps/web/src/components/agents/config/playbooks-section.tsx`
- Create: `apps/web/src/components/agents/config/ferramentas-section.tsx`
- Modify: `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx` (add all three to `SECTIONS` and the switch)

**Interfaces:**
- Consumes: `AgentKnowledgeConfig`, `AgentLinkItem`, `AgentPlaybook` (Task 2), `ListEditor` (Task 10), `DocumentUpload`, `FaqManager` (existing, `apps/web/src/components/agents/`), `ToolsConfig` (existing).
- Produces: nothing new consumed elsewhere — leaf UI modules.

- [ ] **Step 1: Write the Conhecimento section, reusing the existing document/FAQ components verbatim**

Create `apps/web/src/components/agents/config/conhecimento-section.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DocumentUpload } from "@/components/agents/document-upload";
import { FaqManager } from "@/components/agents/faq-manager";
import { ListEditor } from "./list-editor";
import type { AgentConfigDraft, AgentKnowledgeConfig, KnowledgeDocument, KnowledgeFaq } from "@aula-agente/shared";

interface ConhecimentoSectionProps {
  agentId: string;
  draft: AgentConfigDraft;
  onPatch: (patch: { knowledge: AgentKnowledgeConfig }) => Promise<void>;
}

export function ConhecimentoSection({ agentId, draft, onPatch }: ConhecimentoSectionProps) {
  const [knowledge, setKnowledge] = useState(draft.knowledge);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [faqs, setFaqs] = useState<KnowledgeFaq[]>([]);

  const fetchDocsAndFaqs = useCallback(async () => {
    const supabase = createClient();
    const [docsResult, faqsResult] = await Promise.all([
      supabase.from("knowledge_documents").select("*").eq("agent_id", agentId).order("created_at", { ascending: false }),
      supabase.from("knowledge_faqs").select("*").eq("agent_id", agentId).order("created_at", { ascending: false }),
    ]);
    setDocuments((docsResult.data as KnowledgeDocument[]) || []);
    setFaqs((faqsResult.data as KnowledgeFaq[]) || []);
  }, [agentId]);

  useEffect(() => {
    fetchDocsAndFaqs();
  }, [fetchDocsAndFaqs]);

  const save = (next: AgentKnowledgeConfig) => {
    setKnowledge(next);
    onPatch({ knowledge: next });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Base de Conhecimento</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Ativa para este agente</Label>
            <Switch checked={knowledge.documentos_ativos} onCheckedChange={(v) => save({ ...knowledge, documentos_ativos: v })} />
          </div>
          <DocumentUpload agentId={agentId} documents={documents} onRefresh={fetchDocsAndFaqs} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>FAQ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Ativa para este agente</Label>
            <Switch checked={knowledge.faqs_ativas} onCheckedChange={(v) => save({ ...knowledge, faqs_ativas: v })} />
          </div>
          <FaqManager agentId={agentId} faqs={faqs} onRefresh={fetchDocsAndFaqs} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Preços</CardTitle></CardHeader>
        <CardContent>
          <Textarea
            rows={6}
            value={knowledge.precos_notas}
            placeholder="Notas de preço sempre visíveis para o agente (faixas de referência, condições gerais)."
            onChange={(e) => setKnowledge({ ...knowledge, precos_notas: e.target.value })}
            onBlur={() => save(knowledge)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Links</CardTitle></CardHeader>
        <CardContent>
          <ListEditor
            items={knowledge.links}
            titleKey="titulo"
            fields={[
              { key: "titulo", label: "Título", type: "text" },
              { key: "url", label: "URL", type: "text" },
            ]}
            emptyItem={() => ({ id: crypto.randomUUID(), titulo: "", url: "", ativo: true })}
            onChange={(items) => save({ ...knowledge, links: items })}
            addLabel="+ Novo link"
          />
        </CardContent>
      </Card>
    </div>
  );
}
```

`documentos_ativos`/`faqs_ativas` are stored on the draft and compiled by nothing today (Task 4's Prompt Builder never inlines document/FAQ content — they stay tool-retrieved) — they exist so a future "load knowledge selectively" pass (mentioned as preparation-only in the approved spec, not built this round) has a place to read an on/off signal per knowledge source without a schema change.

- [ ] **Step 2: Write the Playbooks section**

Create `apps/web/src/components/agents/config/playbooks-section.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentConfigDraft, AgentPlaybook } from "@aula-agente/shared";

interface PlaybooksSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { playbook: AgentPlaybook }) => Promise<void>;
}

export function PlaybooksSection({ draft, onPatch }: PlaybooksSectionProps) {
  const [playbook, setPlaybook] = useState(draft.playbook);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Script de atendimento</CardTitle>
      </CardHeader>
      <CardContent>
        <Textarea
          rows={16}
          value={playbook.script_atendimento}
          placeholder={"1. Identificação da necessidade\n2. Qualificação\n3. Direcionamento\n4. Próximo passo"}
          onChange={(e) => setPlaybook({ script_atendimento: e.target.value })}
          onBlur={() => onPatch({ playbook })}
        />
        <p className="mt-2 text-sm text-muted-foreground">
          Playbooks futuros por tipo de atendimento (Consórcio, Financiamento, Venda de moto, Carta contemplada,
          Follow-up) já têm espaço reservado no modelo de dados — não são criados nesta etapa, apenas este script
          único de atendimento geral, migrado sem inventar novo conteúdo.
        </p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Write the Ferramentas section**

Create `apps/web/src/components/agents/config/ferramentas-section.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentConfigDraft, ToolsConfig } from "@aula-agente/shared";

interface ToolRow {
  key: keyof ToolsConfig;
  title: string;
  description: string;
}

const TOOL_ROWS: ToolRow[] = [
  { key: "search_knowledge", title: "Busca na Base de Conhecimento", description: "Permite ao agente buscar em documentos enviados" },
  { key: "search_faq", title: "Busca de FAQs", description: "Permite ao agente consultar perguntas frequentes" },
  { key: "send_catalog_photo", title: "Catálogo de Veículos", description: "Permite ao agente buscar veículos e enviar fotos pelo WhatsApp" },
  { key: "create_task", title: "Criar tarefas de follow-up", description: "Permite ao agente criar tarefas de acompanhamento comercial em Tarefas" },
];

interface FerramentasSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { tools_config: ToolsConfig }) => Promise<void>;
}

export function FerramentasSection({ draft, onPatch }: FerramentasSectionProps) {
  const [toolsConfig, setToolsConfig] = useState(draft.tools_config);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ferramentas</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {TOOL_ROWS.map((row) => (
          <div key={row.key} className="flex items-center justify-between">
            <div>
              <p className="font-medium">{row.title}</p>
              <p className="text-sm text-muted-foreground">{row.description}</p>
            </div>
            <Switch
              checked={toolsConfig[row.key]}
              onCheckedChange={(v) => {
                const next = { ...toolsConfig, [row.key]: v };
                setToolsConfig(next);
                onPatch({ tools_config: next });
              }}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
```

This lists exactly the 4 tools that exist in the backend registry (Task 7's `packages/agent-runtime`) — no invented tool row is added, matching the approved spec's "não inventar integrações."

- [ ] **Step 4: Wire all three into the page**

Modify `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`:

```tsx
import { ConhecimentoSection } from "@/components/agents/config/conhecimento-section";
import { PlaybooksSection } from "@/components/agents/config/playbooks-section";
import { FerramentasSection } from "@/components/agents/config/ferramentas-section";
```

```tsx
const SECTIONS = [
  { key: "geral", label: "Geral" },
  { key: "personalidade", label: "Personalidade" },
  { key: "regras", label: "Regras" },
  { key: "conhecimento", label: "Conhecimento" },
  { key: "playbooks", label: "Playbooks" },
  { key: "ferramentas", label: "Ferramentas" },
] as const;
```

```tsx
{activeSection === "conhecimento" && <ConhecimentoSection agentId={agentId} draft={status.draft} onPatch={patch} />}
{activeSection === "playbooks" && <PlaybooksSection draft={status.draft} onPatch={patch} />}
{activeSection === "ferramentas" && <FerramentasSection draft={status.draft} onPatch={patch} />}
```

- [ ] **Step 5: Typecheck and manually verify**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/web typecheck`
Expected: no errors.

In the browser: confirm the existing document upload and FAQ manager still work exactly as they did on the old `/agents/[agentId]/knowledge` page (same components, same behavior) — upload a test document, add a test FAQ, confirm both appear; type a script into Playbooks and reload to confirm it persisted; toggle each of the 4 tool switches and reload to confirm persistence.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/agents/config/conhecimento-section.tsx apps/web/src/components/agents/config/playbooks-section.tsx apps/web/src/components/agents/config/ferramentas-section.tsx "apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx"
git commit -m "feat(web): add Conhecimento, Playbooks, and Ferramentas sections to Central de Configuração"
```

---

### Task 14: Draft status bar — discard and publish

**Files:**
- Modify: `apps/api/src/services/agent-config.service.ts` (add `discardDraft`)
- Modify: `apps/api/src/services/agent-config.service.test.ts` (add its tests)
- Modify: `apps/api/src/routes/agent-config/index.ts` (add `POST /agents/:agentId/config/discard`)
- Create: `apps/web/src/components/agents/config/draft-status-bar.tsx`
- Create: `apps/web/src/components/agents/config/publish-dialog.tsx`
- Modify: `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx` (render the status bar)

**Interfaces:**
- Consumes: `restoreAgentConfigFromVersion`, `getLatestAgentVersion` (Task 3), `AgentConfigStatus` (Task 10).
- Produces: `POST /agents/:agentId/config/discard` (HTTP route); `<DraftStatusBar>`, consumed directly by the page.

"Descartar" means: copy the latest published version's snapshot back over the draft (same mechanism Task 16's restore uses) — there is no separate staging copy beyond `agent_configs` itself, since every section save (Tasks 10-13) already patches it directly. If the agent has never been published, there is nothing to discard to, so the button is disabled in that state.

- [ ] **Step 1: Write the failing test for `discardDraft`**

Add to `apps/api/src/services/agent-config.service.test.ts` (extend the hoisted mock with `restoreAgentConfigFromVersion` and `getLatestAgentVersion` is already present from Task 6):

```ts
const { getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion, patchAgentConfig, restoreAgentConfigFromVersion } = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getOrCreateAgentConfig: vi.fn(),
  publishAgentConfig: vi.fn(),
  getLatestAgentVersion: vi.fn(),
  patchAgentConfig: vi.fn(),
  restoreAgentConfigFromVersion: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion, patchAgentConfig, restoreAgentConfigFromVersion,
}));
```

```ts
import { discardDraft } from "./agent-config.service.js";

describe("discardDraft", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("restores the draft from the latest published version when one exists", async () => {
    const version = { id: "version-1", version: 2 };
    getLatestAgentVersion.mockResolvedValue(version);
    restoreAgentConfigFromVersion.mockResolvedValue(baseDraft);

    const result = await discardDraft({} as any, "agent-1");

    expect(restoreAgentConfigFromVersion).toHaveBeenCalledWith({}, "agent-1", version);
    expect(result).toEqual(baseDraft);
  });

  it("throws when the agent has never been published — nothing to discard to", async () => {
    getLatestAgentVersion.mockResolvedValue(null);
    await expect(discardDraft({} as any, "agent-1")).rejects.toThrow(/never been published/i);
    expect(restoreAgentConfigFromVersion).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- agent-config.service`
Expected: FAIL — `discardDraft is not exported`.

- [ ] **Step 3: Add `discardDraft` to the service**

Add to `apps/api/src/services/agent-config.service.ts` (extend the import and append):

```ts
import { getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion, restoreAgentConfigFromVersion } from "@aula-agente/database";
```

```ts
export async function discardDraft(db: SupabaseClient, agentId: string): Promise<AgentConfigDraft> {
  const latestVersion = await getLatestAgentVersion(db, agentId);
  if (!latestVersion) {
    throw new Error("This agent has never been published — there is nothing to discard to.");
  }
  return restoreAgentConfigFromVersion(db, agentId, latestVersion);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- agent-config.service`
Expected: PASS, all tests green.

- [ ] **Step 5: Add the discard route**

Add to `apps/api/src/routes/agent-config/index.ts` (extend imports and add the route):

```ts
import { discardDraft } from "../../services/agent-config.service.js";
```

```ts
app.post<{ Params: { agentId: string } }>("/agents/:agentId/config/discard", async (request, reply) => {
  const db = getAdminClient();
  const agent = await getAgentById(db, request.params.agentId);
  const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
  if (!membership) return reply.status(403).send({ error: "Access denied" });

  try {
    const draft = await discardDraft(db, request.params.agentId);
    return draft;
  } catch (err) {
    return reply.status(409).send({ error: (err as Error).message });
  }
});
```

- [ ] **Step 6: Run full API test suite and typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test && pnpm --filter @aula-agente/api typecheck`
Expected: all pass, no errors.

- [ ] **Step 7: Write the publish dialog**

Create `apps/web/src/components/agents/config/publish-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";

const SECTION_LABELS: Record<string, string> = {
  identity: "Identidade", personality: "Personalidade", rules: "Regras", knowledge: "Conhecimento", playbook: "Playbook",
};

interface PublishDialogProps {
  agentId: string;
  changedSections: string[];
  onPublished: () => Promise<void>;
}

export function PublishDialog({ agentId, changedSections, onPublished }: PublishDialogProps) {
  const [changelog, setChangelog] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [open, setOpen] = useState(false);

  const handlePublish = async () => {
    setPublishing(true);
    try {
      await apiFetch(`/agents/${agentId}/config/publish`, {
        method: "POST",
        body: JSON.stringify({ changelog }),
      });
      setChangelog("");
      setOpen(false);
      await onPublished();
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button disabled={changedSections.length === 0}>Publicar</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publicar alterações</DialogTitle>
          <DialogDescription>
            Isto atualiza a Helena que atende no WhatsApp agora. Seções alteradas: {changedSections.map((s) => SECTION_LABELS[s] ?? s).join(", ") || "nenhuma"}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Changelog</Label>
          <Textarea value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="O que mudou e por quê" />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancelar</Button>} />
          <Button onClick={handlePublish} disabled={publishing || !changelog.trim()}>
            {publishing ? "Publicando..." : "Publicar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`changelog` is required (`publishAgentConfigSchema` from Task 2 has `.min(1)`) — the Publish button inside the dialog stays disabled until something is typed, matching the server-side validation instead of letting a user hit a 400 first.

- [ ] **Step 8: Write the draft status bar**

Create `apps/web/src/components/agents/config/draft-status-bar.tsx`:

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import { PublishDialog } from "./publish-dialog";
import type { AgentConfigStatus } from "./use-agent-config";

interface DraftStatusBarProps {
  agentId: string;
  status: AgentConfigStatus;
  onPublished: () => Promise<void>;
}

export function DraftStatusBar({ agentId, status, onPublished }: DraftStatusBarProps) {
  const [discarding, setDiscarding] = useState(false);

  const handleDiscard = async () => {
    setDiscarding(true);
    try {
      await apiFetch(`/agents/${agentId}/config/discard`, { method: "POST" });
      await onPublished();
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-2">
      <Badge variant={status.hasPendingChanges ? "default" : "secondary"}>
        {status.hasPendingChanges
          ? `${status.changedSections.length} alteração(ões) não publicada(s)`
          : "Tudo publicado"}
      </Badge>
      <div className="flex items-center gap-2">
        <Dialog>
          <DialogTrigger render={<Button variant="outline" disabled={!status.latestVersion || discarding}>Descartar</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Descartar alterações?</DialogTitle>
              <DialogDescription>
                O rascunho volta para o que está publicado atualmente (versão {status.latestVersion?.version}). Isso não pode ser desfeito.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">Cancelar</Button>} />
              <DialogClose render={<Button variant="destructive" onClick={handleDiscard}>Descartar</Button>} />
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <PublishDialog agentId={agentId} changedSections={status.changedSections} onPublished={onPublished} />
      </div>
    </div>
  );
}
```

There is no dedicated `AlertDialog` primitive in the design system (confirmed during the architecture exploration) — the discard confirmation reuses the plain `Dialog` component, exactly like every other confirmation in this codebase would have to.

- [ ] **Step 9: Render the status bar in the page**

Modify `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`:

```tsx
import { DraftStatusBar } from "@/components/agents/config/draft-status-bar";
```

```tsx
return (
  <div className="space-y-6">
    <DraftStatusBar agentId={agentId} status={status} onPublished={refetch} />
    <div className="grid grid-cols-[200px_1fr] gap-6">
      {/* ... existing nav + section content unchanged ... */}
    </div>
  </div>
);
```

- [ ] **Step 10: Typecheck and manually verify end-to-end**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/web typecheck`
Expected: no errors.

Against the disposable test agent from Task 5 (still not Helena): edit the Nome field, confirm the bar shows "1 alteração(ões) não publicada(s)" mentioning Identidade; click Publicar, type a changelog, confirm; the bar should flip to "Tudo publicado". Edit Nome again, then click Descartar and confirm — the field should revert to the just-published value and the bar returns to "Tudo publicado" without a new version being created (`SELECT count(*) FROM agent_versions WHERE agent_id = '<test-agent-id>';` stays the same as after the Publicar click).

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/agent-config.service.ts apps/api/src/services/agent-config.service.test.ts apps/api/src/routes/agent-config/index.ts apps/web/src/components/agents/config/draft-status-bar.tsx apps/web/src/components/agents/config/publish-dialog.tsx "apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx"
git commit -m "feat: add discard/publish flow with pending-changes indicator"
```

---

### Task 15: Frontend — Playground panel

**Files:**
- Create: `apps/web/src/components/agents/config/use-playground-session.ts`
- Create: `apps/web/src/components/agents/config/playground-panel.tsx`
- Modify: `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx` (wrap in `Tabs`: Editar / Playground; dock the panel in a 3rd grid column on large screens)

**Interfaces:**
- Consumes: `AgentPlaygroundMessage`, `PlaygroundToolCall` (Task 2), `apiFetch` (existing), `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` (existing, `apps/web/src/components/ui/tabs.tsx` — its first real usage anywhere in the app).
- Produces: `usePlaygroundSession(agentId)` (consumed by the page, and by Task 17's page modification, so the same conversation persists when switching to the Editar tab's docked panel and back).

- [ ] **Step 1: Write the Playground session hook**

Create `apps/web/src/components/agents/config/use-playground-session.ts`:

```ts
"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { AgentPlaygroundMessage } from "@aula-agente/shared";

export function usePlaygroundSession(agentId: string) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentPlaygroundMessage[]>([]);
  const [sending, setSending] = useState(false);

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    const session = (await apiFetch(`/agents/${agentId}/playground/sessions`, { method: "POST" })) as { id: string };
    setSessionId(session.id);
    return session.id;
  }, [agentId, sessionId]);

  const sendMessage = useCallback(
    async (content: string) => {
      setSending(true);
      try {
        const id = await ensureSession();
        const optimisticUser: AgentPlaygroundMessage = {
          id: `local-${Date.now()}`, session_id: id, organization_id: "",
          role: "user", content, tool_calls: [], created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimisticUser]);

        const assistantMessage = (await apiFetch(`/agents/${agentId}/playground/sessions/${id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content }),
        })) as AgentPlaygroundMessage;
        setMessages((prev) => [...prev, assistantMessage]);
      } finally {
        setSending(false);
      }
    },
    [agentId, ensureSession]
  );

  const reset = useCallback(() => {
    setSessionId(null);
    setMessages([]);
  }, []);

  return { messages, sendMessage, sending, reset };
}
```

- [ ] **Step 2: Write the Playground panel**

Create `apps/web/src/components/agents/config/playground-panel.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { RotateCcw, Send } from "lucide-react";
import type { usePlaygroundSession } from "./use-playground-session";

interface PlaygroundPanelProps {
  playground: ReturnType<typeof usePlaygroundSession>;
}

export function PlaygroundPanel({ playground }: PlaygroundPanelProps) {
  const { messages, sendMessage, sending, reset } = playground;
  const [draft, setDraft] = useState("");

  const handleSend = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setDraft("");
    await sendMessage(content);
  };

  return (
    <div className="flex h-full min-h-[400px] flex-col rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <p className="text-sm font-medium">Playground</p>
        <Button type="button" variant="ghost" size="icon-sm" onClick={reset} title="Nova conversa">
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">Mande uma mensagem como se fosse um lead.</p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
              )}
            >
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
              {message.tool_calls.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-current/20 pt-2">
                  {message.tool_calls.map((call, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs opacity-80">
                      <Badge variant={call.mode === "simulated" ? "secondary" : "outline"} className="text-[10px]">
                        {call.mode === "simulated" ? "SIMULADO" : "REAL"}
                      </Badge>
                      <span>{call.tool_name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t p-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Mande uma mensagem como se fosse um lead..."
          disabled={sending}
        />
        <Button type="button" size="icon" onClick={handleSend} disabled={sending}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
```

Each tool-call badge reads `call.mode` directly off the `PlaygroundToolCall` the backend saved (Task 8/9) — "SIMULADO" vs "REAL" is never inferred client-side, it's exactly what the server recorded.

- [ ] **Step 3: Wrap the page in Tabs and dock the Playground**

Replace the full contents of `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAgentConfig } from "@/components/agents/config/use-agent-config";
import { usePlaygroundSession } from "@/components/agents/config/use-playground-session";
import { DraftStatusBar } from "@/components/agents/config/draft-status-bar";
import { PlaygroundPanel } from "@/components/agents/config/playground-panel";
import { GeralSection } from "@/components/agents/config/geral-section";
import { PersonalidadeSection } from "@/components/agents/config/personalidade-section";
import { RegrasSection } from "@/components/agents/config/regras-section";
import { ConhecimentoSection } from "@/components/agents/config/conhecimento-section";
import { PlaybooksSection } from "@/components/agents/config/playbooks-section";
import { FerramentasSection } from "@/components/agents/config/ferramentas-section";

const SECTIONS = [
  { key: "geral", label: "Geral" },
  { key: "personalidade", label: "Personalidade" },
  { key: "regras", label: "Regras" },
  { key: "conhecimento", label: "Conhecimento" },
  { key: "playbooks", label: "Playbooks" },
  { key: "ferramentas", label: "Ferramentas" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

export default function AgentEditarPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { status, loading, patch, refetch } = useAgentConfig(agentId);
  const [activeSection, setActiveSection] = useState<SectionKey>("geral");
  const playground = usePlaygroundSession(agentId);

  if (loading || !status) return <div className="p-6">Carregando configuração...</div>;

  return (
    <div className="flex h-full flex-col gap-4">
      <DraftStatusBar agentId={agentId} status={status} onPublished={refetch} />
      <Tabs defaultValue="editar" className="flex-1">
        <TabsList variant="line">
          <TabsTrigger value="editar">Editar</TabsTrigger>
          <TabsTrigger value="playground">Playground</TabsTrigger>
        </TabsList>

        <TabsContent value="editar">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[200px_1fr_360px]">
            <nav className="space-y-1">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setActiveSection(s.key)}
                  className={cn(
                    "block w-full rounded-md px-3 py-2 text-left text-sm",
                    activeSection === s.key ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
                  )}
                >
                  {s.label}
                </button>
              ))}
            </nav>
            <div>
              {activeSection === "geral" && <GeralSection draft={status.draft} onPatch={patch} />}
              {activeSection === "personalidade" && <PersonalidadeSection draft={status.draft} onPatch={patch} />}
              {activeSection === "regras" && <RegrasSection draft={status.draft} onPatch={patch} />}
              {activeSection === "conhecimento" && <ConhecimentoSection agentId={agentId} draft={status.draft} onPatch={patch} />}
              {activeSection === "playbooks" && <PlaybooksSection draft={status.draft} onPatch={patch} />}
              {activeSection === "ferramentas" && <FerramentasSection draft={status.draft} onPatch={patch} />}
            </div>
            <div className="hidden lg:block">
              <PlaygroundPanel playground={playground} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="playground">
          <PlaygroundPanel playground={playground} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

On large screens (`lg:` breakpoint, matching Tailwind's default `1024px`), the Playground is docked as a 3rd grid column inside the "Editar" tab itself, so you can edit and test side by side without switching tabs — exactly the Assis-inspired layout from the approved spec. On narrower screens that 3rd column is hidden (`hidden lg:block`) and the standalone "Playground" tab is the way to reach it. Both use the same `usePlaygroundSession` instance from this one page component, so the test conversation is identical either way — switching tabs never loses your Playground history.

- [ ] **Step 4: Typecheck and manually verify**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/web typecheck`
Expected: no errors.

In the browser, on a wide window: confirm the Playground column appears docked to the right of the Editar tab's content. Send "Não sei qual moto escolher, pode me ajudar?" against the disposable test agent (draft still mostly empty from earlier tasks — any reply, even a generic one, proves the wiring works) and confirm a reply appears. Narrow the browser window below 1024px: the docked column disappears; click the "Playground" tab and confirm the same conversation (same messages) is still there. Click "Nova conversa" and confirm the message list clears and a fresh session starts on the next send.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agents/config/use-playground-session.ts apps/web/src/components/agents/config/playground-panel.tsx "apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx"
git commit -m "feat(web): add Playground panel, docked on wide screens and as its own tab on narrow ones"
```

---

### Task 16: Backend — version list, detail with diff, and restore

**Files:**
- Modify: `apps/api/src/services/agent-config.service.ts` (add `listVersions`, `getVersionWithDiff`, `restoreVersion`)
- Modify: `apps/api/src/services/agent-config.service.test.ts` (add tests)
- Modify: `apps/api/src/routes/agent-config/index.ts` (add 3 routes)

**Interfaces:**
- Consumes: `getAgentVersions`, `getAgentVersionById`, `restoreAgentConfigFromVersion` (Task 3), `computeChangedSections` (Task 4).
- Produces: `GET /agents/:agentId/versions`, `GET /agents/:agentId/versions/:versionId`, `POST /agents/:agentId/versions/:versionId/restore` (consumed by Task 17's Histórico UI).

Restoring copies a version's snapshot onto the draft (same `restoreAgentConfigFromVersion` Task 14's discard already uses with the *latest* version) — it never modifies or deletes the `agent_versions` row being restored from. There is still no UPDATE/DELETE RLS policy on `agent_versions` (Task 1) to make that true even if application code ever tried.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/services/agent-config.service.test.ts` (extend the hoisted mock with `getAgentVersions`, `getAgentVersionById`):

```ts
const {
  getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion,
  patchAgentConfig, restoreAgentConfigFromVersion, getAgentVersions, getAgentVersionById,
} = vi.hoisted(() => ({
  getAgentById: vi.fn(), getOrCreateAgentConfig: vi.fn(), publishAgentConfig: vi.fn(),
  getLatestAgentVersion: vi.fn(), patchAgentConfig: vi.fn(), restoreAgentConfigFromVersion: vi.fn(),
  getAgentVersions: vi.fn(), getAgentVersionById: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion,
  patchAgentConfig, restoreAgentConfigFromVersion, getAgentVersions, getAgentVersionById,
}));
```

```ts
import { listVersions, getVersionWithDiff, restoreVersion } from "./agent-config.service.js";

const emptySections = {
  identity: { nome: "", funcao: "", missao: "" },
  personality: baseDraft.personality,
  rules: baseDraft.rules,
  knowledge: baseDraft.knowledge,
  playbook: baseDraft.playbook,
};

describe("listVersions", () => {
  it("returns whatever getAgentVersions returns, newest first (that ordering lives in the query itself)", async () => {
    getAgentVersions.mockResolvedValue([{ id: "v2", version: 2 }, { id: "v1", version: 1 }]);
    const result = await listVersions({} as any, "agent-1");
    expect(result).toEqual([{ id: "v2", version: 2 }, { id: "v1", version: 1 }]);
  });
});

describe("getVersionWithDiff", () => {
  it("diffs the requested version against the one immediately before it", async () => {
    const older = { id: "v1", version: 1, config_snapshot: emptySections };
    const newer = { id: "v2", version: 2, config_snapshot: { ...emptySections, identity: { nome: "Helena", funcao: "", missao: "" } } };
    getAgentVersionById.mockResolvedValue(newer);
    getAgentVersions.mockResolvedValue([newer, older]);

    const result = await getVersionWithDiff({} as any, "agent-1", "v2");

    expect(result.version).toEqual(newer);
    expect(result.changedSections).toEqual(["identity"]);
  });

  it("treats every section as changed when diffing the very first version", async () => {
    const onlyVersion = { id: "v1", version: 1, config_snapshot: emptySections };
    getAgentVersionById.mockResolvedValue(onlyVersion);
    getAgentVersions.mockResolvedValue([onlyVersion]);

    const result = await getVersionWithDiff({} as any, "agent-1", "v1");

    expect(result.changedSections).toEqual(["identity", "personality", "rules", "knowledge", "playbook"]);
  });
});

describe("restoreVersion", () => {
  it("restores the given version's snapshot onto the draft", async () => {
    const version = { id: "v1", version: 1, config_snapshot: emptySections };
    getAgentVersionById.mockResolvedValue(version);
    restoreAgentConfigFromVersion.mockResolvedValue(baseDraft);

    const result = await restoreVersion({} as any, "agent-1", "v1");

    expect(restoreAgentConfigFromVersion).toHaveBeenCalledWith({}, "agent-1", version);
    expect(result).toEqual(baseDraft);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- agent-config.service`
Expected: FAIL — `listVersions is not exported`.

- [ ] **Step 3: Add the 3 functions to the service**

Add to `apps/api/src/services/agent-config.service.ts` (extend the import and append):

```ts
import { getAgentById, getOrCreateAgentConfig, publishAgentConfig, getLatestAgentVersion, restoreAgentConfigFromVersion, getAgentVersions, getAgentVersionById } from "@aula-agente/database";
```

```ts
export async function listVersions(db: SupabaseClient, agentId: string): Promise<AgentVersion[]> {
  return getAgentVersions(db, agentId);
}

export interface VersionWithDiff {
  version: AgentVersion;
  changedSections: string[];
}

export async function getVersionWithDiff(db: SupabaseClient, agentId: string, versionId: string): Promise<VersionWithDiff> {
  const version = await getAgentVersionById(db, versionId);
  const allVersions = await getAgentVersions(db, agentId);
  const previous = allVersions.find((v) => v.version === version.version - 1) ?? null;

  const changedSections = computeChangedSections(version.config_snapshot, previous?.config_snapshot ?? null);
  return { version, changedSections };
}

export async function restoreVersion(db: SupabaseClient, agentId: string, versionId: string): Promise<AgentConfigDraft> {
  const version = await getAgentVersionById(db, versionId);
  return restoreAgentConfigFromVersion(db, agentId, version);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- agent-config.service`
Expected: PASS, all tests green.

- [ ] **Step 5: Add the 3 routes**

Add to `apps/api/src/routes/agent-config/index.ts` (extend imports and add routes):

```ts
import { listVersions, getVersionWithDiff, restoreVersion } from "../../services/agent-config.service.js";
```

```ts
app.get<{ Params: { agentId: string } }>("/agents/:agentId/versions", async (request, reply) => {
  const db = getAdminClient();
  const agent = await getAgentById(db, request.params.agentId);
  const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
  if (!membership) return reply.status(403).send({ error: "Access denied" });

  return listVersions(db, request.params.agentId);
});

app.get<{ Params: { agentId: string; versionId: string } }>(
  "/agents/:agentId/versions/:versionId",
  async (request, reply) => {
    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return getVersionWithDiff(db, request.params.agentId, request.params.versionId);
  }
);

app.post<{ Params: { agentId: string; versionId: string } }>(
  "/agents/:agentId/versions/:versionId/restore",
  async (request, reply) => {
    const db = getAdminClient();
    const agent = await getAgentById(db, request.params.agentId);
    const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
    if (!membership) return reply.status(403).send({ error: "Access denied" });

    return restoreVersion(db, request.params.agentId, request.params.versionId);
  }
);
```

- [ ] **Step 6: Run full API test suite and typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test && pnpm --filter @aula-agente/api typecheck`
Expected: all pass, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/agent-config.service.ts apps/api/src/services/agent-config.service.test.ts apps/api/src/routes/agent-config/index.ts
git commit -m "feat(api): add version list/detail-with-diff/restore endpoints"
```

---

### Task 17: Frontend — Histórico tab

**Files:**
- Create: `apps/web/src/components/agents/config/history-panel.tsx`
- Modify: `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx` (add the 3rd tab)

**Interfaces:**
- Consumes: `AgentVersion` (Task 2), `GET /agents/:agentId/versions`, `GET /agents/:agentId/versions/:versionId`, `POST /agents/:agentId/versions/:versionId/restore` (Task 16).
- Produces: `<HistoryPanel>`, consumed directly by the page's 3rd tab.

Restoring a version through this UI only ever changes the draft (`agent_configs`) — the page's existing `refetch` (from `useAgentConfig`, Task 10) reloads the draft afterward, and the Draft Status Bar (Task 14) will then show pending changes if the restored version differs from what's currently published, exactly like any other draft edit. No version is ever deleted or edited from here.

- [ ] **Step 1: Write the History panel**

Create `apps/web/src/components/agents/config/history-panel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogClose,
} from "@/components/ui/dialog";
import type { AgentVersion } from "@aula-agente/shared";

const SECTION_LABELS: Record<string, string> = {
  identity: "Identidade", personality: "Personalidade", rules: "Regras", knowledge: "Conhecimento", playbook: "Playbook",
};

interface HistoryPanelProps {
  agentId: string;
  onRestored: () => Promise<void>;
}

export function HistoryPanel({ agentId, onRestored }: HistoryPanelProps) {
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);
  const [changedSections, setChangedSections] = useState<string[]>([]);
  const [restoring, setRestoring] = useState(false);

  const fetchVersions = useCallback(async () => {
    const data = (await apiFetch(`/agents/${agentId}/versions`)) as AgentVersion[];
    setVersions(data);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const openDiff = async (versionId: string) => {
    const detail = (await apiFetch(`/agents/${agentId}/versions/${versionId}`)) as { changedSections: string[] };
    setChangedSections(detail.changedSections);
    setOpenVersionId(versionId);
  };

  const handleRestore = async () => {
    if (!openVersionId) return;
    setRestoring(true);
    try {
      await apiFetch(`/agents/${agentId}/versions/${openVersionId}/restore`, { method: "POST" });
      setOpenVersionId(null);
      await onRestored();
    } finally {
      setRestoring(false);
    }
  };

  if (loading) return <p className="text-sm text-muted-foreground">Carregando histórico...</p>;
  if (versions.length === 0) return <p className="text-sm text-muted-foreground">Nenhuma versão publicada ainda.</p>;

  return (
    <div className="space-y-3">
      {versions.map((version) => (
        <Card key={version.id}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">v{version.version}</CardTitle>
              <Badge variant="outline">{new Date(version.created_at).toLocaleString("pt-BR")}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">{version.changelog}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => openDiff(version.id)}>
              Ver e restaurar
            </Button>
          </CardContent>
        </Card>
      ))}

      <Dialog open={openVersionId !== null} onOpenChange={(open) => !open && setOpenVersionId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restaurar esta versão para o rascunho?</DialogTitle>
            <DialogDescription>
              {changedSections.length > 0
                ? `Seções desta versão em relação à anterior: ${changedSections.map((s) => SECTION_LABELS[s] ?? s).join(", ")}.`
                : "Esta versão é idêntica à anterior."}{" "}
              Isso substitui o rascunho atual — não publica nada sozinho, e não apaga nenhuma versão.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancelar</Button>} />
            <Button onClick={handleRestore} disabled={restoring}>
              {restoring ? "Restaurando..." : "Restaurar para o rascunho"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: Add the Histórico tab to the page**

Modify `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`:

```tsx
import { HistoryPanel } from "@/components/agents/config/history-panel";
```

```tsx
<TabsList variant="line">
  <TabsTrigger value="editar">Editar</TabsTrigger>
  <TabsTrigger value="playground">Playground</TabsTrigger>
  <TabsTrigger value="historico">Histórico</TabsTrigger>
</TabsList>
```

(add the 3rd `TabsTrigger` to the existing list)

```tsx
<TabsContent value="historico">
  <HistoryPanel agentId={agentId} onRestored={refetch} />
</TabsContent>
```

(add this as a 3rd `TabsContent`, sibling to the existing `editar`/`playground` ones)

- [ ] **Step 3: Typecheck and manually verify end-to-end**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/web typecheck`
Expected: no errors.

Against the disposable test agent: open Histórico, confirm every version published so far (from Tasks 5 and 14's manual verifications) appears, newest first, each with its changelog text. Click "Ver e restaurar" on an older version, confirm the diff dialog lists the right changed sections, click Restaurar, confirm the Draft Status Bar now shows pending changes and the Geral section's Nome field shows that older version's value. `SELECT count(*) FROM agent_versions WHERE agent_id = '<test-agent-id>';` must be unchanged by the restore (no new version, none deleted).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agents/config/history-panel.tsx "apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx"
git commit -m "feat(web): add Histórico tab with per-version diff and restore-to-draft"
```

---

### Task 18: Backend — import-suggestion for the current System Prompt

**Files:**
- Modify: `packages/agent-runtime/src/agent-runner.ts` (export the already-existing `createModel`)
- Modify: `packages/agent-runtime/src/index.ts` (export it)
- Modify: `packages/shared/src/schemas/agent-config.ts` (add `importSuggestionSchema`)
- Create: `apps/api/src/services/import-suggestion.service.ts`
- Create: `apps/api/src/services/import-suggestion.service.test.ts`
- Modify: `apps/api/src/routes/agent-config/index.ts` (add the route)

**Interfaces:**
- Consumes: `createModel`, `resolveApiKey` (Task 7/this task), `AgentConfigSections` (Task 2), `getAgentById` (existing).
- Produces: `suggestConfigFromSystemPrompt(db, agentId): Promise<AgentConfigSections>` (pure suggestion, writes nothing); `POST /agents/:agentId/config/import-suggestion` (consumed by Task 19's review screen).

This endpoint never writes to `agent_configs` or `agents` — it only returns a proposal. Applying it to the draft is a separate, ordinary `PATCH /agents/:agentId/config` call (Task 6) that only fires when a human clicks "Aplicar ao rascunho" in Task 19's UI, satisfying the approved spec's "sem classificação automática silenciosa."

- [ ] **Step 1: Export `createModel` from the agent runtime**

In `packages/agent-runtime/src/agent-runner.ts`, change:

```ts
function createModel(provider: LLMProvider, modelName: string, apiKey: string) {
```

to:

```ts
export function createModel(provider: LLMProvider, modelName: string, apiKey: string) {
```

Add to `packages/agent-runtime/src/index.ts`:

```ts
export { createModel } from "./agent-runner.js";
```

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/agent-runtime test && pnpm --filter @aula-agente/agent-runtime typecheck`
Expected: all pass — adding `export` to an already-used internal function cannot change its behavior, only its visibility.

- [ ] **Step 2: Add `importSuggestionSchema`**

Add to `packages/shared/src/schemas/agent-config.ts`, at the end of the file:

```ts
export const importSuggestionSchema = z.object({
  identity: agentIdentitySchema,
  personality: agentPersonalitySchema,
  rules: agentRulesSchema,
  knowledge: agentKnowledgeConfigSchema,
  playbook: agentPlaybookSchema,
});
```

- [ ] **Step 3: Write the failing test for the suggestion service**

Create `apps/api/src/services/import-suggestion.service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAgentById, resolveApiKey, createModel } = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  resolveApiKey: vi.fn(),
  createModel: vi.fn(),
}));
const { generateObject } = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock("@aula-agente/database", () => ({ getAgentById }));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey, createModel }));
vi.mock("ai", () => ({ generateObject }));

import { suggestConfigFromSystemPrompt } from "./import-suggestion.service.js";

const baseAgent = {
  id: "agent-1", organization_id: "org-1", name: "Helena", description: "",
  system_prompt: "Você é Helena, consultora da Moto & Trilha. Faça no máximo uma pergunta por vez.",
  model: "gpt-4o-mini", provider: "openai" as const, temperature: 0.7, max_tokens: 1024,
  tools_config: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true },
  is_active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

const suggestedObject = {
  identity: { nome: "Helena", funcao: "Consultora da Moto & Trilha", missao: "" },
  personality: {
    tom_de_voz: "equilibrado", tom_de_voz_personalizado: "", tamanho_resposta: "curta",
    emojis: { ativo: true, maximo: 1, instrucao: "" }, perguntas_por_vez: { maximo: 1 },
    postura_comercial: { tipo: "", instrucao: "" }, girias_proibidas: [], proatividade: "",
  },
  rules: {
    transferencia_para_humano: [], promessas_proibidas: [], regras_por_tipo: [],
    preco_desconto: { pode_autonomo: "", exige_humano: "", nunca_pode: "", observacoes: "" }, objecoes: [],
  },
  knowledge: { precos_notas: "", links: [], documentos_ativos: true, faqs_ativas: true },
  playbook: { script_atendimento: "" },
};

describe("suggestConfigFromSystemPrompt", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAgentById.mockResolvedValue(baseAgent);
    resolveApiKey.mockResolvedValue("test-key");
    createModel.mockReturnValue("mock-model" as any);
    generateObject.mockResolvedValue({ object: suggestedObject });
  });

  it("never writes anything — it only returns the model's suggestion", async () => {
    const result = await suggestConfigFromSystemPrompt({} as any, "agent-1");
    expect(result).toEqual(suggestedObject);
  });

  it("includes the agent's current system_prompt text in the prompt sent to the model", async () => {
    await suggestConfigFromSystemPrompt({} as any, "agent-1");
    const call = generateObject.mock.calls[0][0];
    expect(call.prompt).toContain(baseAgent.system_prompt);
  });

  it("resolves the API key using the agent's own provider, not a hardcoded one", async () => {
    await suggestConfigFromSystemPrompt({} as any, "agent-1");
    expect(resolveApiKey).toHaveBeenCalledWith("org-1", "openai");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- import-suggestion.service`
Expected: FAIL — `Cannot find module './import-suggestion.service.js'`.

- [ ] **Step 5: Write `apps/api/src/services/import-suggestion.service.ts`**

```ts
import { generateObject } from "ai";
import type { SupabaseClient } from "@aula-agente/database";
import { getAgentById } from "@aula-agente/database";
import { createModel, resolveApiKey } from "@aula-agente/agent-runtime";
import { importSuggestionSchema } from "@aula-agente/shared";
import type { AgentConfigSections } from "@aula-agente/shared";

export async function suggestConfigFromSystemPrompt(db: SupabaseClient, agentId: string): Promise<AgentConfigSections> {
  const agent = await getAgentById(db, agentId);
  const apiKey = await resolveApiKey(agent.organization_id, agent.provider);
  const model = createModel(agent.provider, agent.model, apiKey);

  const { object } = await generateObject({
    model,
    schema: importSuggestionSchema,
    prompt: [
      `Você vai analisar o texto de configuração (system prompt) abaixo de um agente de atendimento via WhatsApp chamado "${agent.name}" e sugerir como dividir esse conteúdo em seções estruturadas.`,
      "",
      "- identity: nome, função e missão/instruções principais.",
      "- personality: tom de voz, tamanho das respostas, regras de emoji, máximo de perguntas por mensagem, postura comercial, gírias proibidas, e regras de proatividade.",
      "- rules: gatilhos de transferência para humano, promessas proibidas, regras por tipo de atendimento, política de preço e desconto, e objeções comuns já descritas no texto.",
      "- knowledge: notas de preço e links úteis mencionados no texto (não invente links).",
      "- playbook: o fluxo processual de atendimento (identificação, qualificação, direcionamento, próximo passo), se descrito.",
      "",
      "Preserve o significado original — não invente informações que não estejam no texto. Se uma seção não tiver conteúdo correspondente, deixe os campos vazios ou com os valores padrão.",
      "",
      "Texto atual:",
      agent.system_prompt,
    ].join("\n"),
  });

  return object;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test -- import-suggestion.service`
Expected: PASS, all 3 tests green.

- [ ] **Step 7: Add the route**

Add to `apps/api/src/routes/agent-config/index.ts` (extend imports and add the route):

```ts
import { suggestConfigFromSystemPrompt } from "../../services/import-suggestion.service.js";
```

```ts
app.post<{ Params: { agentId: string } }>("/agents/:agentId/config/import-suggestion", async (request, reply) => {
  const db = getAdminClient();
  const agent = await getAgentById(db, request.params.agentId);
  const membership = request.user.memberships.find((m) => m.organization_id === agent.organization_id);
  if (!membership) return reply.status(403).send({ error: "Access denied" });

  const suggestion = await suggestConfigFromSystemPrompt(db, request.params.agentId);
  return { currentSystemPrompt: agent.system_prompt, suggestion };
});
```

- [ ] **Step 8: Run full API test suite and typecheck**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/api test && pnpm --filter @aula-agente/api typecheck`
Expected: all pass, no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/agent-runtime/src/agent-runner.ts packages/agent-runtime/src/index.ts packages/shared/src/schemas/agent-config.ts apps/api/src/services/import-suggestion.service.ts apps/api/src/services/import-suggestion.service.test.ts apps/api/src/routes/agent-config/index.ts
git commit -m "feat(api): add LLM-assisted import-suggestion endpoint for the current System Prompt (proposal only, writes nothing)"
```

---

### Task 19: Frontend — "Importar configuração atual" review screen

**Files:**
- Create: `apps/web/src/components/agents/config/import-system-prompt-dialog.tsx`
- Modify: `apps/web/src/components/agents/config/geral-section.tsx` (render the dialog trigger, thread a refetch callback)
- Modify: `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx` (pass `refetch` down to `GeralSection`)

**Interfaces:**
- Consumes: `AgentConfigSections` (Task 2), `POST /agents/:agentId/config/import-suggestion`, `PATCH /agents/:agentId/config` (Task 18/6).
- Produces: `<ImportSystemPromptDialog>`, consumed by `GeralSection`.

Nothing is written until the user clicks "Aplicar ao rascunho" inside this dialog — opening it only calls the read-only suggestion endpoint. This is the one and only place classification of the old System Prompt happens, and it always shows the proposal for review first, per the approved spec.

- [ ] **Step 1: Write the review dialog**

Create `apps/web/src/components/agents/config/import-system-prompt-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import type { AgentConfigSections } from "@aula-agente/shared";

interface ImportSystemPromptDialogProps {
  agentId: string;
  onApplied: () => Promise<void>;
}

export function ImportSystemPromptDialog({ agentId, onApplied }: ImportSystemPromptDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currentSystemPrompt, setCurrentSystemPrompt] = useState("");
  const [suggestion, setSuggestion] = useState<AgentConfigSections | null>(null);
  const [applying, setApplying] = useState(false);

  const handleOpenChange = async (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen && !suggestion) {
      setLoading(true);
      const data = (await apiFetch(`/agents/${agentId}/config/import-suggestion`, { method: "POST" })) as {
        currentSystemPrompt: string;
        suggestion: AgentConfigSections;
      };
      setCurrentSystemPrompt(data.currentSystemPrompt);
      setSuggestion(data.suggestion);
      setLoading(false);
    }
  };

  const handleApply = async () => {
    if (!suggestion) return;
    setApplying(true);
    try {
      await apiFetch(`/agents/${agentId}/config`, {
        method: "PATCH",
        body: JSON.stringify({
          identity: suggestion.identity,
          personality: suggestion.personality,
          rules: suggestion.rules,
          knowledge: suggestion.knowledge,
          playbook: suggestion.playbook,
        }),
      });
      setOpen(false);
      setSuggestion(null);
      await onApplied();
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button type="button" variant="outline">Importar configuração atual</Button>} />
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Importar configuração atual</DialogTitle>
          <DialogDescription>
            A IA sugere como dividir o texto publicado hoje entre Identidade, Personalidade, Regras, Conhecimento e
            Playbook. Revise e edite antes de aplicar — nada é salvo até você clicar em "Aplicar ao rascunho".
          </DialogDescription>
        </DialogHeader>

        {loading || !suggestion ? (
          <p className="text-sm text-muted-foreground">Analisando o texto atual...</p>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Texto atual (system prompt publicado)</Label>
              <Textarea readOnly rows={20} value={currentSystemPrompt} className="font-mono text-xs" />
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Identidade — Nome</Label>
                <Input
                  value={suggestion.identity.nome}
                  onChange={(e) => setSuggestion({ ...suggestion, identity: { ...suggestion.identity, nome: e.target.value } })}
                />
              </div>
              <div className="space-y-2">
                <Label>Identidade — Função</Label>
                <Input
                  value={suggestion.identity.funcao}
                  onChange={(e) => setSuggestion({ ...suggestion, identity: { ...suggestion.identity, funcao: e.target.value } })}
                />
              </div>
              <div className="space-y-2">
                <Label>Identidade — Missão</Label>
                <Textarea
                  rows={4}
                  value={suggestion.identity.missao}
                  onChange={(e) => setSuggestion({ ...suggestion, identity: { ...suggestion.identity, missao: e.target.value } })}
                />
              </div>
              <div className="space-y-2">
                <Label>Playbook — Script de atendimento</Label>
                <Textarea
                  rows={6}
                  value={suggestion.playbook.script_atendimento}
                  onChange={(e) => setSuggestion({ ...suggestion, playbook: { script_atendimento: e.target.value } })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Personalidade, Regras e Conhecimento completos ficam disponíveis para ajuste fino nas próprias abas
                depois de aplicar — aqui você revisa o essencial antes de decidir.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline">Cancelar</Button>} />
          <Button type="button" onClick={handleApply} disabled={!suggestion || applying}>
            {applying ? "Aplicando..." : "Aplicar ao rascunho"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Add the trigger to the Geral section**

Modify `apps/web/src/components/agents/config/geral-section.tsx`:

```tsx
import { ImportSystemPromptDialog } from "./import-system-prompt-dialog";
```

```tsx
interface GeralSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { identity?: AgentConfigDraft["identity"]; model_settings?: AgentModelSettings }) => Promise<void>;
  agentId: string;
  onImported: () => Promise<void>;
}

export function GeralSection({ draft, onPatch, agentId, onImported }: GeralSectionProps) {
```

Inside the returned JSX, add the dialog trigger right above the "Identidade" `Card` (as a sibling `div` wrapping both):

```tsx
<div className="flex justify-end">
  <ImportSystemPromptDialog agentId={agentId} onApplied={onImported} />
</div>
```

- [ ] **Step 3: Pass `agentId`/`refetch` down from the page**

Modify `apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx`, the line rendering `GeralSection`:

```tsx
{activeSection === "geral" && <GeralSection draft={status.draft} onPatch={patch} agentId={agentId} onImported={refetch} />}
```

- [ ] **Step 4: Typecheck and manually verify against the disposable test agent**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/web typecheck`
Expected: no errors.

Temporarily set the test agent's `system_prompt` to a short realistic paragraph (`UPDATE agents SET system_prompt = 'Você é a Léa, atende a loja X, seja educada e faça só uma pergunta por vez.' WHERE id = '<test-agent-id>';`), open Geral, click "Importar configuração atual", confirm the left side shows that exact text and the right side shows a plausible Nome/Função guess; edit the suggested Nome, click "Aplicar ao rascunho"; confirm the Draft Status Bar now shows pending changes and the Geral section's own Nome field reflects your edited value. Confirm `agents.system_prompt` for the test agent is unchanged by this whole flow (it only changes on the next real Publicar).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agents/config/import-system-prompt-dialog.tsx apps/web/src/components/agents/config/geral-section.tsx "apps/web/src/app/(dashboard)/agents/[agentId]/editar/page.tsx"
git commit -m "feat(web): add reviewable import-from-System-Prompt screen"
```

---

### Task 20: Integration — full regression pass and Helena's real first migration

**⚠️ Highest production-risk task in the plan.** Everything up to here was verified only against a disposable test agent. This task is the first and only time the real Helena agent's draft gets published, replacing `agents.system_prompt` for real.

**Files:** none created — this task is verification plus one real data migration, done through the UI built in Tasks 10-19.

**Rollback plan (prepare before Step 4):** before publishing anything for the real agent, capture its exact current state:

```sql
SELECT system_prompt, model, provider, temperature, max_tokens, tools_config
FROM agents WHERE id = '<real-agent-id>';
```

Save that output to a local file (e.g. `/tmp/helena-pre-migration-snapshot.txt`). If anything looks wrong after publishing (Step 5), the fastest fix is `POST /agents/<real-agent-id>/versions/<the-version-just-created>/restore` is the wrong direction (it would restore the NEW state) — instead, hand-run:

```sql
UPDATE agents SET
  system_prompt = '<saved value>', model = '<saved value>', provider = '<saved value>',
  temperature = <saved value>, max_tokens = <saved value>, tools_config = '<saved value>'::jsonb
WHERE id = '<real-agent-id>';
```

using the exact values captured above. This is a plain, single-table `UPDATE` — safe and immediate. Do not proceed past Step 4 without having this snapshot saved.

- [ ] **Step 1: Run every package's full test suite**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && pnpm --filter @aula-agente/shared test && pnpm --filter @aula-agente/database typecheck && pnpm --filter @aula-agente/agent-runtime test && pnpm --filter @aula-agente/worker test && pnpm --filter @aula-agente/api test && pnpm --filter @aula-agente/web typecheck`
Expected: everything passes, no errors. This is the whole-branch regression gate before touching real data.

- [ ] **Step 2: Confirm the real worker path is byte-for-byte the pre-project code path**

Run: `cd "/Users/weslleyvalente/Agente IA/superpowers" && git diff main -- apps/worker/src/workers/process-message.ts`
Expected: the only changes in this file across the whole plan are the two import-path lines from Task 7 (`@aula-agente/agent-runtime` instead of relative paths) — no logic line inside `process-message.ts` itself was ever touched. This is the file that runs every real WhatsApp message; confirming its diff is import-paths-only is the strongest evidence production behavior is unchanged.

- [ ] **Step 3: Identify the real, live agent to migrate**

Run, against the production (or production-mirroring) database:

```sql
SELECT a.id, a.name, a.is_active, ei.instance_name
FROM agents a
JOIN evolution_instances ei ON ei.active_agent_id = a.id
WHERE ei.instance_name IS NOT NULL;
```

This lists every agent actually wired to a live WhatsApp number. Confirm with your human partner which row is the real "Helena" for Moto e Trilha before continuing — do not guess from the name alone if more than one row comes back.

- [ ] **Step 4: Save the rollback snapshot**

Run the `SELECT` from the "Rollback plan" note above against the confirmed real agent id, and save its output somewhere durable outside the repo (a password-manager note, a private doc — not committed to git, since it's live production configuration).

- [ ] **Step 5: Migrate the real agent through the UI, exactly as tested on the disposable agent**

Navigate to `/agents/<real-agent-id>/editar` in the deployed (or locally-pointed-at-production, per your usual workflow) `apps/web`. Click "Importar configuração atual" (Task 19), review the suggestion carefully section by section against the actual current prompt shown on the left, edit anything that looks wrong or incomplete, then close the dialog with "Aplicar ao rascunho". Walk through Personalidade, Regras, Conhecimento, Playbook, Ferramentas and fill in/correct anything the suggestion missed or got wrong — this is a manual review step, not something to rubber-stamp.

- [ ] **Step 6: Test extensively in the Playground before publishing**

Using the docked Playground (Task 15), replay realistic conversations covering every existing tool: a knowledge-base question, an FAQ question, a vehicle/catalog question, and a message that should trigger `create_task` — confirm each produces a sensible reply and that the `create_task`/catalog-photo tool calls show the `SIMULADO` badge (proving they didn't touch real data even here). Compare replies against what the real Helena currently says in actual WhatsApp conversations (check `/inbox` for recent real transcripts) — the compiled draft should behave at least as well, ideally better (this was the whole point), never worse.

- [ ] **Step 7: Publish**

Only once Step 6 looks right: click Publicar, write a real changelog (e.g. "Primeira publicação da Central de Configuração — migração do system prompt original"), confirm.

- [ ] **Step 8: Verify in production immediately after publishing**

`SELECT system_prompt FROM agents WHERE id = '<real-agent-id>';` should now show the compiled text. Send (or wait for) one real WhatsApp message to Helena's real number and confirm the reply is sensible — same live verification approach used earlier in this project when re-testing Helena's script fix on the Assis platform, except this time against our own system.

- [ ] **Step 9: Full tool regression against the now-live agent**

Over the next real conversations (or by prompting deliberately as a test customer on the real WhatsApp number, being mindful this is a real channel), confirm each of the 4 tools still fires correctly and for real: a knowledge-base answer cites plausible content, an FAQ answer matches a real stored FAQ, a vehicle question triggers a real catalog photo send, and a follow-up-worthy message creates a real row in `tasks` (`SELECT * FROM tasks WHERE organization_id = '<org-id>' ORDER BY created_at DESC LIMIT 5;`).

- [ ] **Step 10: Commit a short note (no code change) recording the migration**

```bash
cd "/Users/weslleyvalente/Agente IA/superpowers"
git commit --allow-empty -m "chore: migrate Helena's real agent to the Central de Configuração (published v1 of the compiled config)"
```

---

### Task 21: Final safety checklist

**Files:** none — this task only verifies claims already established by earlier tasks and records the result.

Report each item with the concrete evidence for it, not just a checkmark:

- [ ] **1. WhatsApp continues using only the published configuration.**
  Evidence: `apps/worker/src/workers/process-message.ts` and `packages/agent-runtime/src/agent-runner.ts` read `agent.system_prompt`/`agent.tools_config`/`agent.model`/`agent.provider`/`agent.temperature`/`agent.max_tokens` off the `agents` row only (`getAgentById`, Task 7's untouched logic) — grep to confirm neither file imports `agent_configs` or `agent_versions` at all: `grep -rn "agent_configs\|agent_versions" packages/agent-runtime/src apps/worker/src`. Expected: no matches. The only writer of `agents.system_prompt` is `publish_agent_config` (Task 5), called only from the publish route, called only by a human clicking Publicar.

- [ ] **2. The draft never affects production before publishing.**
  Evidence: `grep -rn "from(\"agents\")" apps/api/src/services/agent-config.service.ts apps/api/src/services/playground.service.ts`. Expected: no matches — every draft read/write in these two services goes through `agent_configs` (via `getOrCreateAgentConfig`/`patchAgentConfig`/`restoreAgentConfigFromVersion`), never touching the `agents` table directly. The one exception, `publishDraft`/`publish_agent_config`, is Task 5's explicit, deliberate, transactional write — not an accidental one.

- [ ] **3. The Playground never creates a real side effect.**
  Evidence: `grep -n "sandbox" apps/api/src/services/playground.service.ts`. Expected: `sandbox: true` is hardcoded in the one `runAgent(...)` call inside `sendPlaygroundMessage` — there is no code path in this service that can call `runAgent` without it. Cross-reference Task 8's registry logic: `create_task` and `send_catalog_photo` are the only tools with real-world side effects, and both branch to their `createMock*Tool()` variant whenever `sandbox` is true, unconditionally. Task 9's and Task 20's manual verifications already confirmed zero new rows in `tasks` and no real WhatsApp sends from Playground-triggered tool calls.

- [ ] **4. Restore never erases history.**
  Evidence: `grep -n "CREATE POLICY" supabase/migrations/00015_agent_config_rls.sql | grep agent_versions`. Expected: exactly 2 lines (`agent_versions_select`, `agent_versions_insert`) — no `agent_versions_update`/`agent_versions_delete` policy exists anywhere in the migrations. Restoring (Task 14's discard, Task 16/17's version restore) always calls `restoreAgentConfigFromVersion`, which only ever `UPDATE`s `agent_configs` — grep to confirm: `grep -n "agent_versions" packages/database/src/queries/agent-configs.ts`. Expected: no matches (that file never touches `agent_versions` at all, only reads its snapshot data that was passed in as a parameter).

- [ ] **5. No existing tool stopped working.**
  Evidence: Task 7's Step 8 (relocated `agent-runner.test.ts`/`search-catalog.test.ts` passing unchanged), Task 8's Step 10 (worker typecheck/test passing with zero changes to `process-message.ts`), and Task 20's Step 9 (live regression of all 4 tools — `search_knowledge`, `search_faq`, `send_catalog_photo`, `create_task` — against the real, now-migrated Helena agent) together cover this end to end: the code path is provably unchanged, and the real behavior was independently re-verified after the real publish.

- [ ] **Write the final report**

Summarize the 5 items above with their evidence in a message to the user (or a short note in the PR/commit description if this work is being merged via a branch) — this is the deliverable the user explicitly asked for "ao final," not just an internal implementer note.

