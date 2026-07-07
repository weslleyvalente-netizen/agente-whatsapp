# WhatsApp AI Agent — Design Spec

## Overview

Agente de IA para atendimento ao cliente via WhatsApp, conectado à Evolution API. Sistema multi-tenant com dashboard completo para gestão de agentes, conversas e instâncias WhatsApp.

## Decisões de Arquitetura

| Aspecto | Decisão |
|---------|---------|
| Caso de uso | Atendimento ao cliente / suporte |
| Arquitetura | Monorepo Turborepo |
| Backend | Fastify + TypeScript |
| Worker | BullMQ (processo separado) |
| Dashboard | Next.js + shadcn/ui + Tailwind |
| LLM | Vercel AI SDK (multi-provider) |
| Agente | Function calling com tools (RAG + FAQs) |
| Knowledge base | Documentos com pgvector + FAQs manuais |
| Banco | Supabase (PostgreSQL + pgvector + RLS + Realtime + Auth) |
| Cache/Filas | Redis + BullMQ |
| Multi-tenancy | Organizations com RLS |
| Inbox | Completo: takeover, atribuição, notas, tags, métricas |
| Evolution API | Múltiplas instâncias por tenant |
| Deploy | Docker Compose em VPS, Supabase Cloud |

## Estrutura do Monorepo

```
aula_agente/
├── apps/
│   ├── api/          # Fastify server — webhooks, REST endpoints
│   ├── worker/       # BullMQ consumers — LLM, embeddings, envio
│   └── web/          # Next.js dashboard
├── packages/
│   ├── shared/       # tipos, constantes, validações (Zod)
│   ├── database/     # Supabase client, queries, tipos gerados
│   └── queue/        # definições de filas BullMQ compartilhadas
├── docker-compose.yml
├── turbo.json
└── package.json
```

## Fluxo de Dados

### Mensagem Recebida (WhatsApp → Agente)

1. Evolution API recebe mensagem do WhatsApp, dispara webhook para API Server
2. API Server valida, identifica tenant e agente, salva mensagem no Supabase
3. Checagem de idempotência: verifica `evolution_message_id` único para evitar duplicidade (webhook retries)
4. API Server enfileira job `process-message` no BullMQ
5. Worker consome o job com lock por `conversation_id` (apenas 1 job por conversa simultâneo)
6. Worker carrega contexto, chama AI SDK com tools
7. AI SDK executa tool calling loop (RAG, FAQs)
8. Worker salva resposta no Supabase, enfileira job `send-message`
9. Consumer envia resposta via Evolution API → WhatsApp

### Intervenção Humana

1. Operador marca conversa como "assumida" no dashboard
2. Flag `is_human_takeover` setada na conversa + `human_takeover_at` timestamp registrado
3. Novas mensagens do WhatsApp são salvas mas Worker ignora (não processa com LLM)
4. Operador responde pelo inbox → API Server envia via Evolution API (role: `human_agent`)
5. Operador devolve pro agente → flag removida, próxima mensagem processada pelo Worker
6. **Timeout automático:** job periódico verifica conversas com `is_human_takeover` há mais de 30min sem atividade humana e alerta/devolve ao agente

### Tipos de Mídia Suportados

| Tipo | Tratamento |
|------|-----------|
| text | Processado diretamente pelo LLM |
| image | Salvo como media_url, descrição enviada ao LLM se model suporta vision |
| audio | Salvo como media_url, transcrito via Whisper antes de enviar ao LLM |
| video | Salvo como media_url, notifica operador (não processado pelo agente) |
| document | Salvo como media_url, texto extraído se PDF/TXT antes de enviar ao LLM |
| sticker/location | Salvo como metadata, agente responde com fallback genérico |

## Schema do Banco de Dados

### Multi-tenancy

```sql
organizations (
  id uuid PK, name text, slug text UNIQUE,
  plan text, settings jsonb,
  created_at timestamptz, updated_at timestamptz
)
-- API keys dos LLM providers são armazenadas no Supabase Vault (pgsodium)
-- Tabela auxiliar: organization_secrets (org_id, provider, encrypted_key)
-- O Worker busca a chave do tenant via vault. Env vars globais servem como fallback
-- para tenants que não configuraram chaves próprias (ex: plano free com chave da plataforma)

organization_members (
  id uuid PK, organization_id uuid FK,
  user_id uuid FK (auth.users),
  role text CHECK (owner|admin|agent),
  created_at timestamptz, updated_at timestamptz
)

organization_invitations (
  id uuid PK, organization_id uuid FK,
  email text, role text CHECK (admin|agent),
  invited_by uuid FK (auth.users),
  status text CHECK (pending|accepted|expired),
  expires_at timestamptz,
  created_at timestamptz
)
```

### Secrets (Vault)

```sql
organization_secrets (
  id uuid PK, organization_id uuid FK,
  provider text CHECK (openai|anthropic|google),
  encrypted_key text,  -- via pgsodium transparent column encryption
  created_at timestamptz, updated_at timestamptz
)
-- Prioridade de resolução de API key:
-- 1. organization_secrets (chave do tenant) → se existir, usa
-- 2. Env var global (OPENAI_API_KEY etc.) → fallback da plataforma
```

### Evolution API

```sql
evolution_instances (
  id uuid PK, organization_id uuid FK,
  instance_name text, instance_id text,
  status text CHECK (connected|disconnected|connecting),
  phone_number text,
  webhook_url text,
  active_agent_id uuid FK (agents) NULLABLE,  -- qual agente atende nesta instância
  created_at timestamptz, updated_at timestamptz
)
-- QR code é efêmero — buscado em tempo real da Evolution API, não armazenado no banco
-- Constraint: apenas 1 agente ativo por instância (active_agent_id UNIQUE não necessário,
-- pois um agente pode ser desativado e outro ativado)
```

### Contatos

```sql
contacts (
  id uuid PK, organization_id uuid FK,
  phone text, name text, photo_url text,
  metadata jsonb,
  created_at timestamptz, updated_at timestamptz,
  UNIQUE(organization_id, phone)
)
```

### Agentes

```sql
agents (
  id uuid PK, organization_id uuid FK,
  name text, description text,
  system_prompt text, model text, provider text,
  temperature float, max_tokens int,
  tools_config jsonb,
  is_active boolean,
  created_at timestamptz, updated_at timestamptz
)
-- Relação agente ↔ instância é feita via evolution_instances.active_agent_id
-- Um agente pode não estar vinculado a nenhuma instância (configuração prévia)
-- Uma instância tem no máximo 1 agente ativo
```

### Base de Conhecimento

```sql
knowledge_documents (
  id uuid PK, agent_id uuid FK, organization_id uuid FK,
  title text, file_name text, file_url text, file_type text,
  file_size_bytes int,
  status text CHECK (processing|ready|error),
  error_message text NULLABLE,
  chunk_count int, created_at timestamptz, updated_at timestamptz
)
-- Limites: max 50MB por arquivo, tipos aceitos: PDF, TXT, MD, DOCX, CSV
-- Quota: configurável por plano da organização (settings.max_documents)

knowledge_chunks (
  id uuid PK, document_id uuid FK, organization_id uuid FK,
  content text, metadata jsonb,
  embedding vector(1536),
  chunk_index int, created_at timestamptz
)
-- organization_id duplicado aqui para RLS direto (evita JOIN com documents na busca vetorial)
-- Dimensão do embedding: 1536 (OpenAI text-embedding-3-small default)
-- Se necessário suportar outros modelos, criar coluna embedding_model e usar dimensão variável

knowledge_faqs (
  id uuid PK, agent_id uuid FK, organization_id uuid FK,
  question text, answer text,
  is_active boolean, created_at timestamptz, updated_at timestamptz
)
```

### Conversas & Mensagens

```sql
conversations (
  id uuid PK, organization_id uuid FK,
  agent_id uuid FK, evolution_instance_id uuid FK,
  contact_id uuid FK (contacts),
  status text CHECK (open|waiting|resolved|closed),
  is_human_takeover boolean DEFAULT false,
  human_takeover_at timestamptz NULLABLE,
  assigned_to uuid FK (auth.users) NULLABLE,
  tags text[],
  last_message_at timestamptz,
  created_at timestamptz, updated_at timestamptz
)

messages (
  id uuid PK, conversation_id uuid FK, organization_id uuid FK,
  evolution_message_id text NULLABLE,  -- ID original da Evolution API para idempotência
  role text CHECK (contact|agent|human_agent|system),
  content text, media_url text, media_type text,
  metadata jsonb,  -- {model, tokens_used, latency_ms, tool_calls}
  created_at timestamptz
)

conversation_notes (
  id uuid PK, conversation_id uuid FK, organization_id uuid FK,
  user_id uuid FK, content text,
  created_at timestamptz, updated_at timestamptz
)

conversation_metrics (
  id uuid PK, conversation_id uuid FK, organization_id uuid FK,
  first_response_time_ms int, resolution_time_ms int,
  message_count int, human_messages_count int,
  satisfaction_rating int,
  created_at timestamptz
)
```

### Índices

- `conversations(organization_id, last_message_at DESC)`
- `conversations(organization_id, status)`
- `conversations(contact_id)`
- `contacts(organization_id, phone)` — UNIQUE
- `messages(conversation_id, created_at)`
- `messages(evolution_message_id)` — UNIQUE WHERE NOT NULL (idempotência)
- `knowledge_chunks(organization_id)` — para RLS
- `knowledge_chunks(embedding)` — HNSW ou IVFFlat
- `conversation_notes(organization_id)` — para RLS
- `conversation_metrics(organization_id)` — para RLS
- RLS em TODAS as tabelas filtrando por `organization_id` (coluna presente em cada tabela)

## Backend — API Server (`apps/api`)

### Estrutura

```
apps/api/src/
├── server.ts
├── routes/
│   ├── webhooks/evolution.ts
│   ├── messages/send.ts
│   ├── instances/index.ts
│   ├── agents/index.ts
│   └── knowledge/
│       ├── documents.ts        ← upload + CRUD documentos
│       └── faqs.ts             ← CRUD FAQs
├── services/
│   ├── evolution.service.ts
│   ├── conversation.service.ts
│   ├── message.service.ts
│   └── knowledge.service.ts   ← upload → storage → enfileira process-document
├── lib/
│   ├── supabase.ts
│   ├── redis.ts
│   └── queue.ts
└── middleware/
    ├── auth.ts
    └── webhook-verify.ts
```

### Responsabilidades

- Receber webhooks da Evolution API e enfileirar processamento
- Endpoints para ações do dashboard (enviar msg manual, gerenciar instâncias)
- Endpoints de knowledge base (upload documentos → Supabase Storage → enfileira `process-document`)
- Autenticação via JWT Supabase
- Não processa LLM — apenas enfileira

### Webhook Flow

1. Valida assinatura/origin do webhook
2. Extrai: instanceId, phone, message, messageType, evolutionMessageId
3. **Idempotência:** checa se `evolution_message_id` já existe em `messages` → se sim, ignora (200 OK)
4. Busca `evolution_instance` → `organization_id` + `active_agent_id`
5. Upsert contato na tabela `contacts` (por phone + organization_id)
6. Upsert conversa (busca conversa aberta com mesmo contact_id + agent_id, cria se não existe)
7. Salva mensagem no Supabase (role: 'contact', evolution_message_id setado)
8. Checa `is_human_takeover` → se sim, para aqui
9. Enfileira `process-message` com `{ conversationId, messageId, agentId }`

### Knowledge Upload Flow

1. Dashboard envia arquivo via `POST /knowledge/documents` (multipart)
2. API valida tipo e tamanho (max 50MB, tipos: PDF/TXT/MD/DOCX/CSV)
3. Upload para Supabase Storage (bucket por org)
4. Cria registro em `knowledge_documents` com status `processing`
5. Enfileira job `process-document` com `{ documentId, organizationId, agentId }`
6. Retorna documento com status `processing` → dashboard mostra progresso

## Worker BullMQ (`apps/worker`)

### Estrutura

```
apps/worker/src/
├── index.ts
├── workers/
│   ├── process-message.ts
│   ├── send-message.ts
│   ├── process-document.ts
│   └── takeover-timeout.ts     ← job periódico: verifica takeovers expirados
├── agents/
│   ├── agent-runner.ts
│   └── tools/
│       ├── search-knowledge.ts
│       ├── search-faq.ts
│       └── registry.ts
├── embeddings/
│   ├── chunker.ts
│   └── embedder.ts
└── lib/
    ├── supabase.ts
    ├── redis.ts
    ├── vault.ts                ← busca API keys do tenant via Supabase Vault
    └── queue.ts
```

### Filas

| Fila | Trigger | Ação |
|------|---------|------|
| `process-message` | Webhook recebe msg | Carrega contexto, chama LLM, salva resposta, enfileira envio |
| `send-message` | LLM responde ou humano envia | Chama Evolution API |
| `process-document` | Upload via API `/knowledge/documents` | Chunking → embedding → pgvector |
| `takeover-timeout` | Cron job (a cada 5min) | Verifica conversas com takeover > 30min sem atividade, alerta operador ou devolve ao agente |

### Fluxo process-message

1. **Lock por conversa:** adquire lock Redis por `conversation_id` (garante processamento sequencial por conversa)
2. Busca conversa + agente + config
3. **Resolve API key:** busca chave do tenant via vault → fallback para env var global
4. Carrega histórico recente como contexto
5. Monta system prompt
6. Registra tools habilitadas (via registry)
7. Chama AI SDK com tools → tool calling loop automático
8. Salva resposta no Supabase (role: 'agent', metadata: {model, tokens, latency, tool_calls})
9. Enfileira `send-message`
10. Atualiza `conversation.last_message_at`
11. **Libera lock** da conversa

### Resiliência

- **Lock por conversa:** Redis lock com TTL (previne deadlock). Se mensagem chega durante processamento, job aguarda lock ser liberado (processamento sequencial por conversa)
- Retry: 3 tentativas com backoff exponencial
- Dead letter queue para falhas persistentes
- Concurrency configurável por fila (ex: `process-message` = 10, `send-message` = 20)
- Rate limiting no `send-message` para respeitar limites da Evolution API

## Dashboard Next.js (`apps/web`)

### Estrutura de Rotas

```
app/
├── (auth)/login, register
├── (dashboard)/
│   ├── inbox/
│   │   └── [conversationId]/
│   ├── agents/
│   │   ├── new/
│   │   └── [agentId]/knowledge/
│   ├── instances/
│   │   └── [instanceId]/
│   ├── team/
│   └── settings/
```

### Páginas

| Página | Funcionalidade |
|--------|---------------|
| Inbox | Lista conversas com filtros (status). Chat realtime. Painel lateral: contato, notas, tags. Assumir/devolver conversa. Atribuir a atendente. |
| Agentes | CRUD. Config: nome, prompt, modelo, provider, temperatura. Tools. Upload docs + FAQs. |
| Instâncias | Lista instâncias Evolution. Conectar via QR code (buscado em tempo real da API, não do banco). Status, telefone, logs. Vincular agente à instância. |
| Team | Membros, convidar por email (tabela invitations), roles (owner/admin/agent). |
| Settings | Config org, API keys providers LLM (salvas via vault). |

### Realtime

- `messages` → novas mensagens no chat instantaneamente
- `conversations` → status muda, nova conversa na lista
- Via `supabase.channel().on('postgres_changes', ...)`

### Comunicação

- CRUD direto no Supabase via SDK + RLS
- Ações que passam pelo backend (envio de msg, instâncias Evolution, upload docs) via API routes como BFF

## Infraestrutura

### Docker Compose

```yaml
services:
  api:
    build: ./apps/api
    ports: ["3001:3001"]
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
  worker:
    build: ./apps/worker
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "healthcheck.js"]
      interval: 30s
      timeout: 10s
      retries: 3
  web:
    build: ./apps/web
    ports: ["3000:3000"]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000"]
      interval: 30s
      timeout: 10s
      retries: 3
  redis:
    image: redis:7-alpine
    volumes: [redis_data:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
volumes:
  redis_data:
```

### Variáveis de Ambiente

- Supabase: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Redis: `REDIS_URL`
- Evolution API: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`
- LLM Providers (fallback global): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`
- App: `API_PORT`, `WEBHOOK_SECRET`, `JWT_SECRET`

### Deploy

- VPS com Docker Compose
- Supabase Cloud (managed)
- Evolution API rodando separadamente
- Nginx/Caddy como reverse proxy (SSL)
- Worker escala com `--scale worker=N` (seguro: lock Redis garante 1 job por conversa)

## Fases de Implementação

1. **Fundação** — Monorepo, Docker Compose, Supabase schema (todas as tabelas + RLS + vault), Redis, packages compartilhados
2. **Backend Core** — API Server, webhook Evolution (com idempotência), serviços, filas BullMQ
3. **Worker & Agente** — Worker BullMQ (com lock por conversa), AI SDK, tools, RAG pipeline, embeddings, vault integration
4. **Dashboard Auth & Layout** — Next.js setup, Supabase Auth, multi-tenancy, layout base, org switcher
5. **Dashboard: Gestão de Agentes** — CRUD agentes, config, upload docs (via API), FAQs, vincular agente a instância
6. **Dashboard: Evolution API** — Gestão instâncias, QR code (realtime da API), status, logs
7. **Dashboard: Inbox** — Lista conversas, chat realtime, takeover (com timeout), atribuição, notas, tags, métricas
8. **Dashboard: Team & Settings** — Membros, convites (invitations), roles, config org, API keys (vault)
