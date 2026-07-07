# Fase 1: Fundação — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configurar o monorepo Turborepo com todos os packages compartilhados, Docker Compose, schema Supabase completo (tabelas + RLS + vault + pgvector), e conexão Redis.

**Architecture:** Monorepo com Turborepo gerenciando 3 apps (api, worker, web) e 3 packages (shared, database, queue). Supabase Cloud como banco managed. Redis local via Docker.

**Tech Stack:** TypeScript, Turborepo, pnpm, Docker Compose, Supabase (PostgreSQL + pgvector + pgsodium), Redis 7, Zod, BullMQ

---

### Task 1: Inicializar Monorepo com Turborepo + pnpm

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `.nvmrc`

- [ ] **Step 1: Inicializar package.json raiz**

```bash
pnpm init
```

- [ ] **Step 2: Criar configuração do workspace pnpm**

Criar `pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Instalar Turborepo como devDependency**

```bash
pnpm add -D turbo
```

- [ ] **Step 4: Criar turbo.json**

Criar `turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    }
  }
}
```

- [ ] **Step 5: Atualizar package.json raiz com scripts**

Editar `package.json`:
```json
{
  "name": "aula-agente",
  "private": true,
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "lint": "turbo lint",
    "test": "turbo test",
    "typecheck": "turbo typecheck",
    "dev:api": "turbo dev --filter=@aula-agente/api",
    "dev:worker": "turbo dev --filter=@aula-agente/worker",
    "dev:web": "turbo dev --filter=@aula-agente/web"
  },
  "devDependencies": {
    "turbo": "^2.5.0"
  },
  "packageManager": "pnpm@9.15.0"
}
```

- [ ] **Step 6: Criar .nvmrc**

Criar `.nvmrc`:
```
20
```

- [ ] **Step 7: Criar .gitignore**

Criar `.gitignore`:
```gitignore
node_modules/
dist/
.turbo/
.next/
.env
.env.local
*.log
.DS_Store
```

- [ ] **Step 8: Criar .env.example**

Criar `.env.example`:
```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Redis
REDIS_URL=redis://localhost:6379

# Evolution API
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=your-evolution-api-key

# LLM Providers (fallback global — tenants configuram os seus no dashboard)
OPENAI_API_KEY=sk-your-openai-key
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
GOOGLE_AI_API_KEY=your-google-key

# App
API_PORT=3001
WEBHOOK_SECRET=your-webhook-secret
```

- [ ] **Step 9: Criar estrutura de diretórios**

```bash
mkdir -p apps/api apps/worker apps/web packages/shared packages/database packages/queue
```

- [ ] **Step 10: Commit**

```bash
git add .
git commit -m "feat: initialize monorepo with turborepo and pnpm workspaces"
```

---

### Task 2: Package `@aula-agente/shared` — Tipos, Constantes e Validações

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/types/organization.ts`
- Create: `packages/shared/src/types/agent.ts`
- Create: `packages/shared/src/types/conversation.ts`
- Create: `packages/shared/src/types/message.ts`
- Create: `packages/shared/src/types/contact.ts`
- Create: `packages/shared/src/types/evolution.ts`
- Create: `packages/shared/src/types/knowledge.ts`
- Create: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/schemas/organization.ts`
- Create: `packages/shared/src/schemas/agent.ts`
- Create: `packages/shared/src/schemas/conversation.ts`
- Create: `packages/shared/src/schemas/message.ts`
- Create: `packages/shared/src/schemas/contact.ts`
- Create: `packages/shared/src/schemas/evolution.ts`
- Create: `packages/shared/src/schemas/knowledge.ts`
- Create: `packages/shared/src/schemas/index.ts`

- [ ] **Step 1: Criar package.json do shared**

Criar `packages/shared/package.json`:
```json
{
  "name": "@aula-agente/shared",
  "version": "0.0.1",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "echo 'no lint configured'"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "dependencies": {
    "zod": "^3.24.0"
  }
}
```

- [ ] **Step 2: Criar tsconfig.json do shared**

Criar `packages/shared/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
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

- [ ] **Step 3: Criar tipos de Organization**

Criar `packages/shared/src/types/organization.ts`:
```typescript
export type OrganizationPlan = "free" | "pro" | "enterprise";

export type MemberRole = "owner" | "admin" | "agent";

export type InvitationStatus = "pending" | "accepted" | "expired";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: OrganizationPlan;
  settings: OrganizationSettings;
  created_at: string;
  updated_at: string;
}

export interface OrganizationSettings {
  max_documents: number;
  max_agents: number;
  max_instances: number;
}

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: MemberRole;
  created_at: string;
  updated_at: string;
}

export interface OrganizationInvitation {
  id: string;
  organization_id: string;
  email: string;
  role: Exclude<MemberRole, "owner">;
  invited_by: string;
  status: InvitationStatus;
  expires_at: string;
  created_at: string;
}

export interface OrganizationSecret {
  id: string;
  organization_id: string;
  provider: LLMProvider;
  encrypted_key: string;
  created_at: string;
  updated_at: string;
}

export type LLMProvider = "openai" | "anthropic" | "google";
```

- [ ] **Step 4: Criar tipos de Agent**

Criar `packages/shared/src/types/agent.ts`:
```typescript
import type { LLMProvider } from "./organization";

export interface Agent {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  provider: LLMProvider;
  temperature: number;
  max_tokens: number;
  tools_config: ToolsConfig;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
}
```

- [ ] **Step 5: Criar tipos de Contact**

Criar `packages/shared/src/types/contact.ts`:
```typescript
export interface Contact {
  id: string;
  organization_id: string;
  phone: string;
  name: string | null;
  photo_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 6: Criar tipos de Conversation**

Criar `packages/shared/src/types/conversation.ts`:
```typescript
export type ConversationStatus = "open" | "waiting" | "resolved" | "closed";

export interface Conversation {
  id: string;
  organization_id: string;
  agent_id: string;
  evolution_instance_id: string;
  contact_id: string;
  status: ConversationStatus;
  is_human_takeover: boolean;
  human_takeover_at: string | null;
  assigned_to: string | null;
  tags: string[];
  last_message_at: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationNote {
  id: string;
  conversation_id: string;
  organization_id: string;
  user_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationMetrics {
  id: string;
  conversation_id: string;
  organization_id: string;
  first_response_time_ms: number | null;
  resolution_time_ms: number | null;
  message_count: number;
  human_messages_count: number;
  satisfaction_rating: number | null;
  created_at: string;
}
```

- [ ] **Step 7: Criar tipos de Message**

Criar `packages/shared/src/types/message.ts`:
```typescript
export type MessageRole = "contact" | "agent" | "human_agent" | "system";

export type MediaType = "text" | "image" | "audio" | "video" | "document" | "sticker" | "location";

export interface Message {
  id: string;
  conversation_id: string;
  organization_id: string;
  evolution_message_id: string | null;
  role: MessageRole;
  content: string;
  media_url: string | null;
  media_type: MediaType | null;
  metadata: MessageMetadata | null;
  created_at: string;
}

export interface MessageMetadata {
  model?: string;
  tokens_used?: number;
  latency_ms?: number;
  tool_calls?: string[];
}
```

- [ ] **Step 8: Criar tipos de Evolution**

Criar `packages/shared/src/types/evolution.ts`:
```typescript
export type InstanceStatus = "connected" | "disconnected" | "connecting";

export interface EvolutionInstance {
  id: string;
  organization_id: string;
  instance_name: string;
  instance_id: string;
  status: InstanceStatus;
  phone_number: string | null;
  webhook_url: string | null;
  active_agent_id: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 9: Criar tipos de Knowledge**

Criar `packages/shared/src/types/knowledge.ts`:
```typescript
export type DocumentStatus = "processing" | "ready" | "error";

export type DocumentFileType = "pdf" | "txt" | "md" | "docx" | "csv";

export interface KnowledgeDocument {
  id: string;
  agent_id: string;
  organization_id: string;
  title: string;
  file_name: string;
  file_url: string;
  file_type: DocumentFileType;
  file_size_bytes: number;
  status: DocumentStatus;
  error_message: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunk {
  id: string;
  document_id: string;
  organization_id: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
  chunk_index: number;
  created_at: string;
}

export interface KnowledgeFaq {
  id: string;
  agent_id: string;
  organization_id: string;
  question: string;
  answer: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 10: Criar barrel export dos tipos**

Criar `packages/shared/src/types/index.ts`:
```typescript
export * from "./organization";
export * from "./agent";
export * from "./contact";
export * from "./conversation";
export * from "./message";
export * from "./evolution";
export * from "./knowledge";
```

- [ ] **Step 11: Criar constantes**

Criar `packages/shared/src/constants.ts`:
```typescript
export const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

export const ALLOWED_DOCUMENT_TYPES = ["pdf", "txt", "md", "docx", "csv"] as const;

export const ALLOWED_DOCUMENT_MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
};

export const CONVERSATION_STATUSES = ["open", "waiting", "resolved", "closed"] as const;

export const MESSAGE_ROLES = ["contact", "agent", "human_agent", "system"] as const;

export const MEMBER_ROLES = ["owner", "admin", "agent"] as const;

export const LLM_PROVIDERS = ["openai", "anthropic", "google"] as const;

export const INSTANCE_STATUSES = ["connected", "disconnected", "connecting"] as const;

export const HUMAN_TAKEOVER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export const EMBEDDING_DIMENSION = 1536;

export const DEFAULT_AGENT_SETTINGS = {
  temperature: 0.7,
  max_tokens: 1024,
  model: "gpt-4o-mini",
  provider: "openai" as const,
};

export const QUEUE_NAMES = {
  PROCESS_MESSAGE: "process-message",
  SEND_MESSAGE: "send-message",
  PROCESS_DOCUMENT: "process-document",
  TAKEOVER_TIMEOUT: "takeover-timeout",
} as const;
```

- [ ] **Step 12: Criar schemas Zod — Organization**

Criar `packages/shared/src/schemas/organization.ts`:
```typescript
import { z } from "zod";

export const organizationSettingsSchema = z.object({
  max_documents: z.number().int().positive().default(100),
  max_agents: z.number().int().positive().default(5),
  max_instances: z.number().int().positive().default(3),
});

export const createOrganizationSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
  plan: z.enum(["free", "pro", "enterprise"]).default("free"),
  settings: organizationSettingsSchema.optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "agent"]),
});
```

- [ ] **Step 13: Criar schemas Zod — Agent**

Criar `packages/shared/src/schemas/agent.ts`:
```typescript
import { z } from "zod";

export const toolsConfigSchema = z.object({
  search_knowledge: z.boolean().default(true),
  search_faq: z.boolean().default(true),
});

export const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  system_prompt: z.string().min(1).max(10000),
  model: z.string().min(1),
  provider: z.enum(["openai", "anthropic", "google"]),
  temperature: z.number().min(0).max(2).default(0.7),
  max_tokens: z.number().int().min(1).max(16384).default(1024),
  tools_config: toolsConfigSchema.default({ search_knowledge: true, search_faq: true }),
});

export const updateAgentSchema = createAgentSchema.partial();
```

- [ ] **Step 14: Criar schemas Zod — Conversation**

Criar `packages/shared/src/schemas/conversation.ts`:
```typescript
import { z } from "zod";

export const updateConversationSchema = z.object({
  status: z.enum(["open", "waiting", "resolved", "closed"]).optional(),
  is_human_takeover: z.boolean().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export const createConversationNoteSchema = z.object({
  content: z.string().min(1).max(5000),
});
```

- [ ] **Step 15: Criar schemas Zod — Message**

Criar `packages/shared/src/schemas/message.ts`:
```typescript
import { z } from "zod";

export const sendMessageSchema = z.object({
  conversation_id: z.string().uuid(),
  content: z.string().min(1).max(10000),
});
```

- [ ] **Step 16: Criar schemas Zod — Contact**

Criar `packages/shared/src/schemas/contact.ts`:
```typescript
import { z } from "zod";

export const upsertContactSchema = z.object({
  phone: z.string().min(10).max(20),
  name: z.string().max(200).nullable().default(null),
  photo_url: z.string().url().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});
```

- [ ] **Step 17: Criar schemas Zod — Evolution**

Criar `packages/shared/src/schemas/evolution.ts`:
```typescript
import { z } from "zod";

export const createInstanceSchema = z.object({
  instance_name: z.string().min(1).max(100),
});

export const updateInstanceSchema = z.object({
  active_agent_id: z.string().uuid().nullable().optional(),
});

export const evolutionWebhookPayloadSchema = z.object({
  event: z.string(),
  instance: z.string(),
  data: z.object({
    key: z.object({
      remoteJid: z.string(),
      fromMe: z.boolean(),
      id: z.string(),
    }),
    message: z.object({
      conversation: z.string().optional(),
      imageMessage: z.object({ caption: z.string().optional() }).optional(),
      audioMessage: z.object({}).optional(),
      videoMessage: z.object({ caption: z.string().optional() }).optional(),
      documentMessage: z.object({ fileName: z.string().optional() }).optional(),
      stickerMessage: z.object({}).optional(),
      locationMessage: z.object({
        degreesLatitude: z.number().optional(),
        degreesLongitude: z.number().optional(),
      }).optional(),
    }).passthrough().optional(),
    messageType: z.string(),
    pushName: z.string().optional(),
    messageTimestamp: z.number().optional(),
  }),
});
```

- [ ] **Step 18: Criar schemas Zod — Knowledge**

Criar `packages/shared/src/schemas/knowledge.ts`:
```typescript
import { z } from "zod";
import { ALLOWED_DOCUMENT_TYPES, MAX_DOCUMENT_SIZE_BYTES } from "../constants";

export const uploadDocumentSchema = z.object({
  title: z.string().min(1).max(200),
  agent_id: z.string().uuid(),
});

export const validateDocumentFile = z.object({
  file_name: z.string().min(1),
  file_size_bytes: z.number().int().positive().max(MAX_DOCUMENT_SIZE_BYTES),
  file_type: z.enum(ALLOWED_DOCUMENT_TYPES),
});

export const createFaqSchema = z.object({
  agent_id: z.string().uuid(),
  question: z.string().min(1).max(1000),
  answer: z.string().min(1).max(5000),
});

export const updateFaqSchema = z.object({
  question: z.string().min(1).max(1000).optional(),
  answer: z.string().min(1).max(5000).optional(),
  is_active: z.boolean().optional(),
});
```

- [ ] **Step 19: Criar barrel export dos schemas**

Criar `packages/shared/src/schemas/index.ts`:
```typescript
export * from "./organization";
export * from "./agent";
export * from "./conversation";
export * from "./message";
export * from "./contact";
export * from "./evolution";
export * from "./knowledge";
```

- [ ] **Step 20: Criar index.ts principal**

Criar `packages/shared/src/index.ts`:
```typescript
export * from "./types/index";
export * from "./schemas/index";
export * from "./constants";
```

- [ ] **Step 21: Instalar dependências e verificar tipagem**

```bash
cd packages/shared && pnpm install && pnpm typecheck
```

- [ ] **Step 22: Commit**

```bash
git add packages/shared/
git commit -m "feat: add @aula-agente/shared package with types, schemas, and constants"
```

---

### Task 3: Package `@aula-agente/database` — Supabase Client + Queries

**Files:**
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/src/index.ts`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/admin.ts`
- Create: `packages/database/src/queries/organizations.ts`
- Create: `packages/database/src/queries/agents.ts`
- Create: `packages/database/src/queries/contacts.ts`
- Create: `packages/database/src/queries/conversations.ts`
- Create: `packages/database/src/queries/messages.ts`
- Create: `packages/database/src/queries/evolution-instances.ts`
- Create: `packages/database/src/queries/knowledge.ts`
- Create: `packages/database/src/queries/index.ts`

- [ ] **Step 1: Criar package.json**

Criar `packages/database/package.json`:
```json
{
  "name": "@aula-agente/database",
  "version": "0.0.1",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "echo 'no lint configured'"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.49.0",
    "@aula-agente/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Criar tsconfig.json**

Criar `packages/database/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
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

- [ ] **Step 3: Criar client.ts (browser/anon)**

Criar `packages/database/src/client.ts`:
```typescript
import { createClient } from "@supabase/supabase-js";

export function createSupabaseClient(url: string, anonKey: string) {
  return createClient(url, anonKey);
}
```

- [ ] **Step 4: Criar admin.ts (service_role)**

Criar `packages/database/src/admin.ts`:
```typescript
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let adminClient: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  adminClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return adminClient;
}
```

- [ ] **Step 5: Criar queries/organizations.ts**

Criar `packages/database/src/queries/organizations.ts`:
```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Organization, OrganizationMember, OrganizationInvitation } from "@aula-agente/shared";

export async function getOrganizationById(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("organizations")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as Organization;
}

export async function getOrganizationBySlug(client: SupabaseClient, slug: string) {
  const { data, error } = await client
    .from("organizations")
    .select("*")
    .eq("slug", slug)
    .single();
  if (error) throw error;
  return data as Organization;
}

export async function getOrganizationMembers(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("organization_members")
    .select("*")
    .eq("organization_id", organizationId);
  if (error) throw error;
  return data as OrganizationMember[];
}

export async function getUserOrganizations(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("organization_members")
    .select("*, organizations(*)")
    .eq("user_id", userId);
  if (error) throw error;
  return data;
}

export async function createOrganization(
  client: SupabaseClient,
  org: Pick<Organization, "name" | "slug" | "plan" | "settings">,
  userId: string
) {
  const { data: orgData, error: orgError } = await client
    .from("organizations")
    .insert(org)
    .select()
    .single();
  if (orgError) throw orgError;

  const { error: memberError } = await client.from("organization_members").insert({
    organization_id: orgData.id,
    user_id: userId,
    role: "owner",
  });
  if (memberError) throw memberError;

  return orgData as Organization;
}

export async function createInvitation(
  client: SupabaseClient,
  invitation: Pick<OrganizationInvitation, "organization_id" | "email" | "role" | "invited_by">
) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("organization_invitations")
    .insert({ ...invitation, status: "pending", expires_at: expiresAt })
    .select()
    .single();
  if (error) throw error;
  return data as OrganizationInvitation;
}
```

- [ ] **Step 6: Criar queries/agents.ts**

Criar `packages/database/src/queries/agents.ts`:
```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent } from "@aula-agente/shared";

export async function getAgentsByOrganization(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("agents")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as Agent[];
}

export async function getAgentById(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("agents")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as Agent;
}

export async function createAgent(
  client: SupabaseClient,
  agent: Omit<Agent, "id" | "created_at" | "updated_at">
) {
  const { data, error } = await client
    .from("agents")
    .insert(agent)
    .select()
    .single();
  if (error) throw error;
  return data as Agent;
}

export async function updateAgent(client: SupabaseClient, id: string, updates: Partial<Agent>) {
  const { data, error } = await client
    .from("agents")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as Agent;
}

export async function deleteAgent(client: SupabaseClient, id: string) {
  const { error } = await client.from("agents").delete().eq("id", id);
  if (error) throw error;
}
```

- [ ] **Step 7: Criar queries/contacts.ts**

Criar `packages/database/src/queries/contacts.ts`:
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
    .from("contacts")
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
  const { data, error } = await client.from("contacts").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Contact;
}
```

- [ ] **Step 8: Criar queries/conversations.ts**

Criar `packages/database/src/queries/conversations.ts`:
```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Conversation, ConversationNote, ConversationMetrics } from "@aula-agente/shared";

export async function getConversationsByOrganization(
  client: SupabaseClient,
  organizationId: string,
  status?: string
) {
  let query = client
    .from("conversations")
    .select("*, contacts(*)")
    .eq("organization_id", organizationId)
    .order("last_message_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function getConversationById(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("conversations")
    .select("*, contacts(*), agents(name)")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

export async function findOpenConversation(
  client: SupabaseClient,
  contactId: string,
  agentId: string
) {
  const { data, error } = await client
    .from("conversations")
    .select("*")
    .eq("contact_id", contactId)
    .eq("agent_id", agentId)
    .in("status", ["open", "waiting"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Conversation | null;
}

export async function createConversation(
  client: SupabaseClient,
  conversation: Omit<Conversation, "id" | "created_at" | "updated_at">
) {
  const { data, error } = await client
    .from("conversations")
    .insert(conversation)
    .select()
    .single();
  if (error) throw error;
  return data as Conversation;
}

export async function updateConversation(
  client: SupabaseClient,
  id: string,
  updates: Partial<Conversation>
) {
  const { data, error } = await client
    .from("conversations")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as Conversation;
}

export async function getExpiredTakeovers(client: SupabaseClient, timeoutMs: number) {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const { data, error } = await client
    .from("conversations")
    .select("*")
    .eq("is_human_takeover", true)
    .lt("human_takeover_at", cutoff);
  if (error) throw error;
  return data as Conversation[];
}

export async function addConversationNote(
  client: SupabaseClient,
  note: Omit<ConversationNote, "id" | "created_at" | "updated_at">
) {
  const { data, error } = await client
    .from("conversation_notes")
    .insert(note)
    .select()
    .single();
  if (error) throw error;
  return data as ConversationNote;
}

export async function getConversationNotes(client: SupabaseClient, conversationId: string) {
  const { data, error } = await client
    .from("conversation_notes")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as ConversationNote[];
}
```

- [ ] **Step 9: Criar queries/messages.ts**

Criar `packages/database/src/queries/messages.ts`:
```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "@aula-agente/shared";

export async function getMessagesByConversation(
  client: SupabaseClient,
  conversationId: string,
  limit = 50
) {
  const { data, error } = await client
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data as Message[];
}

export async function getRecentMessages(
  client: SupabaseClient,
  conversationId: string,
  limit = 20
) {
  const { data, error } = await client
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as Message[]).reverse();
}

export async function createMessage(
  client: SupabaseClient,
  message: Omit<Message, "id" | "created_at">
) {
  const { data, error } = await client
    .from("messages")
    .insert(message)
    .select()
    .single();
  if (error) throw error;
  return data as Message;
}

export async function messageExistsByEvolutionId(
  client: SupabaseClient,
  evolutionMessageId: string
) {
  const { data, error } = await client
    .from("messages")
    .select("id")
    .eq("evolution_message_id", evolutionMessageId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
```

- [ ] **Step 10: Criar queries/evolution-instances.ts**

Criar `packages/database/src/queries/evolution-instances.ts`:
```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionInstance } from "@aula-agente/shared";

export async function getInstancesByOrganization(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client
    .from("evolution_instances")
    .select("*, agents:active_agent_id(id, name)")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function getInstanceById(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("evolution_instances")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as EvolutionInstance;
}

export async function getInstanceByInstanceId(client: SupabaseClient, instanceId: string) {
  const { data, error } = await client
    .from("evolution_instances")
    .select("*")
    .eq("instance_id", instanceId)
    .single();
  if (error) throw error;
  return data as EvolutionInstance;
}

export async function createInstance(
  client: SupabaseClient,
  instance: Pick<EvolutionInstance, "organization_id" | "instance_name" | "instance_id" | "webhook_url">
) {
  const { data, error } = await client
    .from("evolution_instances")
    .insert({ ...instance, status: "disconnected" })
    .select()
    .single();
  if (error) throw error;
  return data as EvolutionInstance;
}

export async function updateInstance(
  client: SupabaseClient,
  id: string,
  updates: Partial<EvolutionInstance>
) {
  const { data, error } = await client
    .from("evolution_instances")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as EvolutionInstance;
}

export async function deleteInstance(client: SupabaseClient, id: string) {
  const { error } = await client.from("evolution_instances").delete().eq("id", id);
  if (error) throw error;
}
```

- [ ] **Step 11: Criar queries/knowledge.ts**

Criar `packages/database/src/queries/knowledge.ts`:
```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeDocument, KnowledgeFaq } from "@aula-agente/shared";

export async function getDocumentsByAgent(client: SupabaseClient, agentId: string) {
  const { data, error } = await client
    .from("knowledge_documents")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as KnowledgeDocument[];
}

export async function getDocumentById(client: SupabaseClient, id: string) {
  const { data, error } = await client
    .from("knowledge_documents")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as KnowledgeDocument;
}

export async function createDocument(
  client: SupabaseClient,
  doc: Omit<KnowledgeDocument, "id" | "created_at" | "updated_at" | "chunk_count" | "error_message">
) {
  const { data, error } = await client
    .from("knowledge_documents")
    .insert({ ...doc, chunk_count: 0 })
    .select()
    .single();
  if (error) throw error;
  return data as KnowledgeDocument;
}

export async function updateDocument(
  client: SupabaseClient,
  id: string,
  updates: Partial<KnowledgeDocument>
) {
  const { data, error } = await client
    .from("knowledge_documents")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as KnowledgeDocument;
}

export async function deleteDocument(client: SupabaseClient, id: string) {
  await client.from("knowledge_chunks").delete().eq("document_id", id);
  const { error } = await client.from("knowledge_documents").delete().eq("id", id);
  if (error) throw error;
}

export async function insertChunks(
  client: SupabaseClient,
  chunks: Array<{
    document_id: string;
    organization_id: string;
    content: string;
    metadata: Record<string, unknown>;
    embedding: number[];
    chunk_index: number;
  }>
) {
  const { error } = await client.from("knowledge_chunks").insert(chunks);
  if (error) throw error;
}

export async function searchKnowledgeChunks(
  client: SupabaseClient,
  organizationId: string,
  agentId: string,
  embedding: number[],
  limit = 5
) {
  const { data, error } = await client.rpc("search_knowledge_chunks", {
    query_embedding: embedding,
    match_count: limit,
    filter_organization_id: organizationId,
    filter_agent_id: agentId,
  });
  if (error) throw error;
  return data as Array<{ id: string; content: string; similarity: number }>;
}

export async function getFaqsByAgent(client: SupabaseClient, agentId: string) {
  const { data, error } = await client
    .from("knowledge_faqs")
    .select("*")
    .eq("agent_id", agentId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as KnowledgeFaq[];
}

export async function createFaq(
  client: SupabaseClient,
  faq: Omit<KnowledgeFaq, "id" | "created_at" | "updated_at">
) {
  const { data, error } = await client
    .from("knowledge_faqs")
    .insert(faq)
    .select()
    .single();
  if (error) throw error;
  return data as KnowledgeFaq;
}

export async function updateFaq(
  client: SupabaseClient,
  id: string,
  updates: Partial<KnowledgeFaq>
) {
  const { data, error } = await client
    .from("knowledge_faqs")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as KnowledgeFaq;
}

export async function deleteFaq(client: SupabaseClient, id: string) {
  const { error } = await client.from("knowledge_faqs").delete().eq("id", id);
  if (error) throw error;
}
```

- [ ] **Step 12: Criar barrel exports**

Criar `packages/database/src/queries/index.ts`:
```typescript
export * from "./organizations";
export * from "./agents";
export * from "./contacts";
export * from "./conversations";
export * from "./messages";
export * from "./evolution-instances";
export * from "./knowledge";
```

Criar `packages/database/src/index.ts`:
```typescript
export { createSupabaseClient } from "./client";
export { getAdminClient } from "./admin";
export * from "./queries/index";
```

- [ ] **Step 13: Instalar dependências e verificar tipagem**

```bash
cd packages/database && pnpm install && pnpm typecheck
```

- [ ] **Step 14: Commit**

```bash
git add packages/database/
git commit -m "feat: add @aula-agente/database package with supabase client and queries"
```

---

### Task 4: Package `@aula-agente/queue` — Definições BullMQ

**Files:**
- Create: `packages/queue/package.json`
- Create: `packages/queue/tsconfig.json`
- Create: `packages/queue/src/index.ts`
- Create: `packages/queue/src/connection.ts`
- Create: `packages/queue/src/queues.ts`
- Create: `packages/queue/src/types.ts`

- [ ] **Step 1: Criar package.json**

Criar `packages/queue/package.json`:
```json
{
  "name": "@aula-agente/queue",
  "version": "0.0.1",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "echo 'no lint configured'"
  },
  "dependencies": {
    "bullmq": "^5.30.0",
    "ioredis": "^5.4.0",
    "@aula-agente/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Criar tsconfig.json**

Criar `packages/queue/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
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

- [ ] **Step 3: Criar connection.ts**

Criar `packages/queue/src/connection.ts`:
```typescript
import IORedis from "ioredis";

let connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (connection) return connection;

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  return connection;
}
```

- [ ] **Step 4: Criar types.ts**

Criar `packages/queue/src/types.ts`:
```typescript
export interface ProcessMessageJobData {
  conversationId: string;
  messageId: string;
  agentId: string;
  organizationId: string;
}

export interface SendMessageJobData {
  conversationId: string;
  messageId: string;
  instanceId: string;
  phone: string;
  content: string;
  organizationId: string;
}

export interface ProcessDocumentJobData {
  documentId: string;
  organizationId: string;
  agentId: string;
}

export interface TakeoverTimeoutJobData {
  // no data needed — scans all expired takeovers
}
```

- [ ] **Step 5: Criar queues.ts**

Criar `packages/queue/src/queues.ts`:
```typescript
import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@aula-agente/shared";
import { getRedisConnection } from "./connection";
import type {
  ProcessMessageJobData,
  SendMessageJobData,
  ProcessDocumentJobData,
  TakeoverTimeoutJobData,
} from "./types";

let processMessageQueue: Queue<ProcessMessageJobData> | null = null;
let sendMessageQueue: Queue<SendMessageJobData> | null = null;
let processDocumentQueue: Queue<ProcessDocumentJobData> | null = null;
let takeoverTimeoutQueue: Queue<TakeoverTimeoutJobData> | null = null;

export function getProcessMessageQueue() {
  if (!processMessageQueue) {
    processMessageQueue = new Queue<ProcessMessageJobData>(QUEUE_NAMES.PROCESS_MESSAGE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return processMessageQueue;
}

export function getSendMessageQueue() {
  if (!sendMessageQueue) {
    sendMessageQueue = new Queue<SendMessageJobData>(QUEUE_NAMES.SEND_MESSAGE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return sendMessageQueue;
}

export function getProcessDocumentQueue() {
  if (!processDocumentQueue) {
    processDocumentQueue = new Queue<ProcessDocumentJobData>(QUEUE_NAMES.PROCESS_DOCUMENT, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    });
  }
  return processDocumentQueue;
}

export function getTakeoverTimeoutQueue() {
  if (!takeoverTimeoutQueue) {
    takeoverTimeoutQueue = new Queue<TakeoverTimeoutJobData>(QUEUE_NAMES.TAKEOVER_TIMEOUT, {
      connection: getRedisConnection(),
    });
  }
  return takeoverTimeoutQueue;
}
```

- [ ] **Step 6: Criar index.ts**

Criar `packages/queue/src/index.ts`:
```typescript
export { getRedisConnection } from "./connection";
export {
  getProcessMessageQueue,
  getSendMessageQueue,
  getProcessDocumentQueue,
  getTakeoverTimeoutQueue,
} from "./queues";
export type {
  ProcessMessageJobData,
  SendMessageJobData,
  ProcessDocumentJobData,
  TakeoverTimeoutJobData,
} from "./types";
```

- [ ] **Step 7: Instalar dependências e verificar tipagem**

```bash
cd packages/queue && pnpm install && pnpm typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/queue/
git commit -m "feat: add @aula-agente/queue package with BullMQ queue definitions"
```

---

### Task 5: Supabase Schema — Migrations SQL

**Files:**
- Create: `supabase/migrations/00001_enable_extensions.sql`
- Create: `supabase/migrations/00002_organizations.sql`
- Create: `supabase/migrations/00003_contacts.sql`
- Create: `supabase/migrations/00004_agents.sql`
- Create: `supabase/migrations/00005_evolution_instances.sql`
- Create: `supabase/migrations/00006_knowledge.sql`
- Create: `supabase/migrations/00007_conversations.sql`
- Create: `supabase/migrations/00008_rls_policies.sql`
- Create: `supabase/migrations/00009_functions.sql`

- [ ] **Step 1: Criar diretório de migrations**

```bash
mkdir -p supabase/migrations
```

- [ ] **Step 2: Criar migration — Extensions**

Criar `supabase/migrations/00001_enable_extensions.sql`:
```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pgsodium";
```

- [ ] **Step 3: Criar migration — Organizations**

Criar `supabase/migrations/00002_organizations.sql`:
```sql
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  settings jsonb NOT NULL DEFAULT '{"max_documents": 100, "max_agents": 5, "max_instances": 3}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'agent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, user_id)
);

CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'agent')),
  invited_by uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_secrets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google')),
  encrypted_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, provider)
);

CREATE INDEX idx_org_members_user ON organization_members(user_id);
CREATE INDEX idx_org_members_org ON organization_members(organization_id);
CREATE INDEX idx_org_invitations_email ON organization_invitations(email, status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_org_members_updated_at
  BEFORE UPDATE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_org_secrets_updated_at
  BEFORE UPDATE ON organization_secrets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 4: Criar migration — Contacts**

Criar `supabase/migrations/00003_contacts.sql`:
```sql
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone text NOT NULL,
  name text,
  photo_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, phone)
);

CREATE INDEX idx_contacts_org_phone ON contacts(organization_id, phone);

CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 5: Criar migration — Agents**

Criar `supabase/migrations/00004_agents.sql`:
```sql
CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  system_prompt text NOT NULL,
  model text NOT NULL DEFAULT 'gpt-4o-mini',
  provider text NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai', 'anthropic', 'google')),
  temperature real NOT NULL DEFAULT 0.7 CHECK (temperature >= 0 AND temperature <= 2),
  max_tokens integer NOT NULL DEFAULT 1024 CHECK (max_tokens > 0 AND max_tokens <= 16384),
  tools_config jsonb NOT NULL DEFAULT '{"search_knowledge": true, "search_faq": true}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agents_org ON agents(organization_id);

CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 6: Criar migration — Evolution Instances**

Criar `supabase/migrations/00005_evolution_instances.sql`:
```sql
CREATE TABLE evolution_instances (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  instance_name text NOT NULL,
  instance_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'connecting')),
  phone_number text,
  webhook_url text,
  active_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_evolution_instances_org ON evolution_instances(organization_id);
CREATE INDEX idx_evolution_instances_instance_id ON evolution_instances(instance_id);

CREATE TRIGGER trg_evolution_instances_updated_at
  BEFORE UPDATE ON evolution_instances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 7: Criar migration — Knowledge**

Criar `supabase/migrations/00006_knowledge.sql`:
```sql
CREATE TABLE knowledge_documents (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  file_name text NOT NULL,
  file_url text NOT NULL,
  file_type text NOT NULL CHECK (file_type IN ('pdf', 'txt', 'md', 'docx', 'csv')),
  file_size_bytes integer NOT NULL CHECK (file_size_bytes > 0),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error')),
  error_message text,
  chunk_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536) NOT NULL,
  chunk_index integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_faqs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_docs_agent ON knowledge_documents(agent_id);
CREATE INDEX idx_knowledge_docs_org ON knowledge_documents(organization_id);
CREATE INDEX idx_knowledge_chunks_doc ON knowledge_chunks(document_id);
CREATE INDEX idx_knowledge_chunks_org ON knowledge_chunks(organization_id);
CREATE INDEX idx_knowledge_faqs_agent ON knowledge_faqs(agent_id);
CREATE INDEX idx_knowledge_faqs_org ON knowledge_faqs(organization_id);

-- HNSW index for vector similarity search
CREATE INDEX idx_knowledge_chunks_embedding ON knowledge_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TRIGGER trg_knowledge_docs_updated_at
  BEFORE UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_knowledge_faqs_updated_at
  BEFORE UPDATE ON knowledge_faqs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 8: Criar migration — Conversations & Messages**

Criar `supabase/migrations/00007_conversations.sql`:
```sql
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  evolution_instance_id uuid NOT NULL REFERENCES evolution_instances(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'resolved', 'closed')),
  is_human_takeover boolean NOT NULL DEFAULT false,
  human_takeover_at timestamptz,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  tags text[] NOT NULL DEFAULT '{}',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  evolution_message_id text,
  role text NOT NULL CHECK (role IN ('contact', 'agent', 'human_agent', 'system')),
  content text NOT NULL DEFAULT '',
  media_url text,
  media_type text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_notes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_metrics (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_response_time_ms integer,
  resolution_time_ms integer,
  message_count integer NOT NULL DEFAULT 0,
  human_messages_count integer NOT NULL DEFAULT 0,
  satisfaction_rating integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_conversations_org_last_msg ON conversations(organization_id, last_message_at DESC);
CREATE INDEX idx_conversations_org_status ON conversations(organization_id, status);
CREATE INDEX idx_conversations_contact ON conversations(contact_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE UNIQUE INDEX idx_messages_evolution_id ON messages(evolution_message_id) WHERE evolution_message_id IS NOT NULL;
CREATE INDEX idx_conversation_notes_org ON conversation_notes(organization_id);
CREATE INDEX idx_conversation_metrics_org ON conversation_metrics(organization_id);

-- Triggers
CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_conversation_notes_updated_at
  BEFORE UPDATE ON conversation_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

- [ ] **Step 9: Criar migration — RLS Policies**

Criar `supabase/migrations/00008_rls_policies.sql`:
```sql
-- Enable RLS on all tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_metrics ENABLE ROW LEVEL SECURITY;

-- Helper function: get user's organization IDs
CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF uuid AS $$
  SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Organizations: user can see orgs they belong to
CREATE POLICY "org_select" ON organizations
  FOR SELECT USING (id IN (SELECT get_user_org_ids()));

CREATE POLICY "org_insert" ON organizations
  FOR INSERT WITH CHECK (true);  -- any authenticated user can create

CREATE POLICY "org_update" ON organizations
  FOR UPDATE USING (id IN (
    SELECT organization_id FROM organization_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ));

-- Organization Members
CREATE POLICY "org_members_select" ON organization_members
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));

CREATE POLICY "org_members_insert" ON organization_members
  FOR INSERT WITH CHECK (organization_id IN (
    SELECT organization_id FROM organization_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ));

CREATE POLICY "org_members_delete" ON organization_members
  FOR DELETE USING (organization_id IN (
    SELECT organization_id FROM organization_members
    WHERE user_id = auth.uid() AND role = 'owner'
  ));

-- Invitations
CREATE POLICY "invitations_select" ON organization_invitations
  FOR SELECT USING (
    organization_id IN (SELECT get_user_org_ids())
    OR email = (SELECT email FROM auth.users WHERE id = auth.uid())
  );

CREATE POLICY "invitations_insert" ON organization_invitations
  FOR INSERT WITH CHECK (organization_id IN (
    SELECT organization_id FROM organization_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ));

-- Secrets: only owner/admin can manage
CREATE POLICY "secrets_select" ON organization_secrets
  FOR SELECT USING (organization_id IN (
    SELECT organization_id FROM organization_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ));

CREATE POLICY "secrets_all" ON organization_secrets
  FOR ALL USING (organization_id IN (
    SELECT organization_id FROM organization_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ));

-- Generic org-scoped policy for remaining tables
-- Each table has organization_id, user can access if member of that org
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'contacts', 'agents', 'evolution_instances',
    'knowledge_documents', 'knowledge_chunks', 'knowledge_faqs',
    'conversations', 'messages', 'conversation_notes', 'conversation_metrics'
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

- [ ] **Step 10: Criar migration — Functions**

Criar `supabase/migrations/00009_functions.sql`:
```sql
-- Vector similarity search for knowledge chunks
CREATE OR REPLACE FUNCTION search_knowledge_chunks(
  query_embedding vector(1536),
  match_count int DEFAULT 5,
  filter_organization_id uuid DEFAULT NULL,
  filter_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks kc
  JOIN knowledge_documents kd ON kd.id = kc.document_id
  WHERE
    (filter_organization_id IS NULL OR kc.organization_id = filter_organization_id)
    AND (filter_agent_id IS NULL OR kd.agent_id = filter_agent_id)
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Function to handle new user accepting invitation
CREATE OR REPLACE FUNCTION accept_invitation(invitation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  inv record;
BEGIN
  SELECT * INTO inv FROM organization_invitations
  WHERE id = invitation_id AND status = 'pending' AND expires_at > now();

  IF inv IS NULL THEN
    RAISE EXCEPTION 'Invalid or expired invitation';
  END IF;

  INSERT INTO organization_members (organization_id, user_id, role)
  VALUES (inv.organization_id, auth.uid(), inv.role);

  UPDATE organization_invitations SET status = 'accepted' WHERE id = invitation_id;
END;
$$;
```

- [ ] **Step 11: Commit**

```bash
git add supabase/
git commit -m "feat: add supabase migrations with full schema, RLS policies, and functions"
```

---

### Task 6: Docker Compose + App Bootstraps

**Files:**
- Create: `docker-compose.yml`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/Dockerfile`
- Create: `apps/api/src/server.ts`
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/Dockerfile`
- Create: `apps/worker/src/index.ts`
- Create: `apps/worker/healthcheck.js`

- [ ] **Step 1: Criar docker-compose.yml**

Criar `docker-compose.yml`:
```yaml
services:
  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    ports:
      - "3001:3001"
    env_file: .env
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped

  worker:
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
    env_file: .env
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "healthcheck.js"]
      interval: 30s
      timeout: 10s
      retries: 3
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  redis_data:
```

- [ ] **Step 2: Criar apps/api/package.json**

Criar `apps/api/package.json`:
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
    "lint": "echo 'no lint configured'"
  },
  "dependencies": {
    "fastify": "^5.2.0",
    "@fastify/cors": "^11.0.0",
    "@fastify/multipart": "^9.0.0",
    "dotenv": "^16.4.0",
    "@aula-agente/shared": "workspace:*",
    "@aula-agente/database": "workspace:*",
    "@aula-agente/queue": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 3: Criar apps/api/tsconfig.json**

Criar `apps/api/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
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

- [ ] **Step 4: Criar apps/api/src/server.ts (bootstrap mínimo)**

Criar `apps/api/src/server.ts`:
```typescript
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";

const server = Fastify({ logger: true });

server.register(cors, { origin: true });

server.get("/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

const start = async () => {
  const port = parseInt(process.env.API_PORT || "3001", 10);
  await server.listen({ port, host: "0.0.0.0" });
  server.log.info(`API server running on port ${port}`);
};

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Criar apps/api/Dockerfile**

Criar `apps/api/Dockerfile`:
```dockerfile
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY apps/api/ apps/api/

# Build
RUN pnpm turbo build --filter=@aula-agente/api

WORKDIR /app/apps/api
RUN apk add --no-cache curl
EXPOSE 3001
CMD ["node", "dist/server.js"]
```

- [ ] **Step 6: Criar apps/worker/package.json**

Criar `apps/worker/package.json`:
```json
{
  "name": "@aula-agente/worker",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "echo 'no lint configured'"
  },
  "dependencies": {
    "bullmq": "^5.30.0",
    "ioredis": "^5.4.0",
    "dotenv": "^16.4.0",
    "@aula-agente/shared": "workspace:*",
    "@aula-agente/database": "workspace:*",
    "@aula-agente/queue": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 7: Criar apps/worker/tsconfig.json**

Criar `apps/worker/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
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

- [ ] **Step 8: Criar apps/worker/src/index.ts (bootstrap mínimo)**

Criar `apps/worker/src/index.ts`:
```typescript
import "dotenv/config";
import { getRedisConnection } from "@aula-agente/queue";

async function main() {
  const redis = getRedisConnection();

  redis.on("connect", () => {
    console.log("Worker connected to Redis");
  });

  redis.on("error", (err) => {
    console.error("Redis connection error:", err);
  });

  console.log("Worker started. Waiting for jobs...");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down worker...");
    await redis.quit();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
```

- [ ] **Step 9: Criar apps/worker/healthcheck.js**

Criar `apps/worker/healthcheck.js`:
```javascript
const net = require("net");

// Check Redis connection as health indicator
const client = net.createConnection({ host: "redis", port: 6379 }, () => {
  client.end();
  process.exit(0);
});

client.on("error", () => {
  process.exit(1);
});

setTimeout(() => {
  process.exit(1);
}, 3000);
```

- [ ] **Step 10: Criar apps/worker/Dockerfile**

Criar `apps/worker/Dockerfile`:
```dockerfile
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/queue/package.json packages/queue/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY apps/worker/ apps/worker/

# Build
RUN pnpm turbo build --filter=@aula-agente/worker

WORKDIR /app/apps/worker
COPY apps/worker/healthcheck.js .
EXPOSE 3002
CMD ["node", "dist/index.js"]
```

- [ ] **Step 11: Instalar todas as dependências do monorepo**

```bash
pnpm install
```

- [ ] **Step 12: Verificar tipagem de todo o monorepo**

```bash
pnpm typecheck
```

- [ ] **Step 13: Testar API server localmente**

```bash
pnpm dev:api
# Em outro terminal: curl http://localhost:3001/health
# Expected: {"status":"ok","timestamp":"..."}
```

- [ ] **Step 14: Commit**

```bash
git add docker-compose.yml apps/api/ apps/worker/
git commit -m "feat: add docker-compose, api server bootstrap, and worker bootstrap"
```

---

### Task 7: Verificação Final da Fase 1

- [ ] **Step 1: Verificar estrutura de arquivos**

```bash
find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './.turbo/*' | sort
```

Esperado: todos os arquivos das tasks anteriores presentes.

- [ ] **Step 2: Verificar typecheck de todo o monorepo**

```bash
pnpm typecheck
```

Esperado: sem erros.

- [ ] **Step 3: Verificar que Docker Compose está válido**

```bash
docker compose config --quiet
```

Esperado: sem erros de syntax.

- [ ] **Step 4: Commit final se houver ajustes**

```bash
git add -A && git status
# Se houver mudanças:
git commit -m "chore: phase 1 final adjustments"
```
