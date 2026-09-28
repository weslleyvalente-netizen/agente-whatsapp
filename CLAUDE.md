# aula-agente — resumo de arquitetura

CRM + agente de IA de atendimento WhatsApp (Helena) da "Moto e Trilha". Um produto
só (não dois sistemas integrados): mesmo monorepo, mesmo banco. Ver `RESUMO_PROJETO.md`
para o detalhamento completo (gerado por análise do repo em 2026-09-28); este arquivo
é só o essencial para orientar mudanças.

## Apps e pacotes (pnpm workspace + Turborepo)

| Path | Papel | Stack |
|---|---|---|
| `apps/api` | API HTTP (Fastify): rotas REST, webhooks (`/webhooks/evolution`, `/webhooks/wix-lead`) | Fastify 5, Zod, `@supabase/supabase-js` |
| `apps/worker` | Processos assíncronos (BullMQ): resposta da IA, envio de mensagens, transcrição, follow-up | BullMQ, ioredis, Vercel AI SDK |
| `apps/web` | Painel (CRM + config do agente) | Next.js 16 App Router, React 19, Supabase SSR, `@dnd-kit` (Kanban) |
| `packages/shared` | Tipos, schemas Zod, constantes, funções puras de regra de negócio | TS, Zod |
| `packages/database` | Camada de acesso a dados (queries Supabase), criptografia de CPF | `@supabase/supabase-js` |
| `packages/queue` | Definição das filas BullMQ | BullMQ |
| `packages/agent-runtime` | Execução do agente (prompt, ferramentas, cache) | Vercel AI SDK |

## Infra

- **Banco:** Supabase Postgres, RLS por `organization_id` em quase todas as tabelas, pgvector para embeddings.
- **Fila/cache:** Redis via BullMQ — não há cron de SO; "crons" são jobs BullMQ repetíveis.
- **WhatsApp:** Evolution API (Baileys/protocolo não-oficial), não é a Cloud API da Meta.
- **Modelo de IA em produção:** Anthropic `claude-sonnet-5` (multi-provedor suportado).
- **Deploy:** Docker + EasyPanel, serviços `api`/`worker`/`web`/`evolution`/`evolution-db`/`redis`. **Deploy automático a cada push na `main` — NUNCA dar push direto na `main`; trabalhar em branch de feature.**

## Filas (BullMQ, em `apps/worker/src/workers`)

- `process-message` — sob demanda (debounce 6s): transcrição, descrição de imagem, LLM, envio.
- `send-message` — envio Evolution, 3 tentativas, 30 msg/s, fallback áudio→texto.
- `stale-conversation-followup` — a cada 15 min: reengajamento automático 2 estágios, `stalled_negotiation` (3 dias parado).
- `takeover-timeout` — a cada 5 min: libera IA após `HUMAN_TAKEOVER_TIMEOUT_MINUTES` (padrão 30 min) sem resposta humana.
- `process-document` — sob demanda: chunking + embedding de documento da base de conhecimento.

## Tabelas principais

- **Org/acesso:** `organizations`, `organization_members`, `organization_secrets`.
- **WhatsApp/conversa:** `wa_contacts` (único por org+phone), `conversations` (`is_human_takeover`, `assigned_to`), `messages` (dedup por `evolution_message_id`).
- **Qualificação:** `conversation_qualifications` (CPF criptografado AES-256-GCM + hash HMAC, `human_locked_fields`), `conversation_qualification_events`.
- **Funil (CRM):** `opportunities` (5 funis: veículo/consórcio/financiamento/LiberaCred/carta contemplada; `status open/won/lost`; `waiting_on`), `opportunity_events` (append-only, evidência obrigatória).
- **Tarefas:** `tasks` (14 tipos, dedup por contato+tipo ou oportunidade+tipo), `task_events`.
- **Agente:** `agents` (config ao vivo), `agent_configs` (rascunho), `agent_versions`.
- **Conhecimento:** `knowledge_documents`, `knowledge_chunks` (vector), `knowledge_faqs`.
- `conversation_metrics` e `conversation_notes` existem no schema mas **não são usadas** em nenhum lugar do código — tabelas mortas, não confundir com dado real.

## Regras de trabalho

- **Nunca push na `main`** — deploy é automático a cada push. Todo trabalho em branch de feature.
- Handoff humano hoje é implícito: qualquer resposta `fromMe` (mesmo "ok"/emoji) ativa `is_human_takeover`; não existe ferramenta dedicada de transferência, só `createTask`.
- Evidência obrigatória em `opportunity_events` para toda mudança de estágio/resultado; seguir esse padrão em qualquer nova automação de funil.
- Sem observabilidade centralizada — logs são `console.log` no painel do EasyPanel.
- Ver seção 12 de `RESUMO_PROJETO.md` para riscos conhecidos (chaves de LLM em texto plano, risco de bloqueio pela Meta, dependência total do modelo para handoff/qualificação).
