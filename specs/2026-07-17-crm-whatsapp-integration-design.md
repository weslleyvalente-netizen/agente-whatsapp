# CRM ↔ Agente WhatsApp Integration — Design

**Data:** 2026-07-17
**Status:** Aprovado, aguardando plano de implementação

## Contexto

O usuário mantém dois projetos separados que compartilham o mesmo projeto
Supabase (`fwwulkmriqkrzozcsqnx`):

- **CRM** (schema pré-existente, single-tenant): tabelas `contacts`, `deals`,
  `activities`, `profiles`. RLS baseada em `is_active_profile(auth.uid())`.
- **aula-agente** (este repositório, multi-tenant): agente de IA para
  WhatsApp, com `organizations`, `organization_members` e (até agora)
  `contacts`.

Os dois schemas colidem no nome `contacts`: a versão do CRM é single-tenant
(`name, email, phone, company, created_by`) e a do aula-agente é multi-tenant
por organização (`organization_id, phone, name, photo_url, metadata`, chave
única `(organization_id, phone)`). São modelos de dados incompatíveis — não
dá para fundir numa tabela só sem confundir os dois domínios.

## Objetivo

Sincronização **unidirecional**: o agente de WhatsApp alimenta o CRM. Toda
vez que um novo contato manda a primeira mensagem, ele deve aparecer como
`contact` no CRM, com uma `activity` registrando a origem. O CRM não escreve
de volta no aula-agente.

Escopo: só os contatos da organização do próprio usuário no aula-agente
sincronizam. Não há hoje necessidade de sincronizar múltiplos tenants — o
aula-agente pode vir a ter mais organizações no futuro, mas o CRM continua
sendo de uso pessoal.

Fora de escopo (YAGNI): criação automática de `deals`. Pode virar uma
iteração futura, mas não faz parte deste design.

## 1. Renomeação de schema

A tabela `contacts` do aula-agente passa a se chamar `wa_contacts` em todo o
projeto, para eliminar a colisão de nome com o CRM. O CRM não é alterado.

Arquivos afetados (renomear a tabela, sem mudar sua estrutura):

- `supabase/migrations/00003_contacts.sql` → renomear para
  `00003_wa_contacts.sql`, `CREATE TABLE contacts` → `CREATE TABLE
  wa_contacts`, índice e trigger atualizados.
- `supabase/migrations/00007_conversations.sql` — FK `contact_id uuid FK
  (contacts)` → `wa_contacts`.
- `supabase/migrations/00008_rls_policies.sql` — policies que referenciam
  `contacts`.
- `packages/database/src/queries/contacts.ts` — queries `.from("contacts")`
  → `.from("wa_contacts")`.
- `apps/api/src/routes/messages/send.ts`
- `apps/worker/src/workers/process-message.ts`
- `packages/database/src/queries/conversations.ts`
- `apps/web/src/app/(dashboard)/inbox/page.tsx`
- `apps/web/src/components/inbox/conversation-list.tsx`
- `apps/web/src/components/inbox/chat-panel.tsx`
- `apps/web/src/components/inbox/side-panel.tsx`

## 2. Mecanismo de sincronização

Novo módulo: `apps/worker/src/integrations/crm-sync.ts`, exportando algo como
`syncContactToCrm(waContact: WaContact): Promise<void>`.

Chamado a partir de `apps/worker/src/workers/process-message.ts`, logo após
o worker persistir um `wa_contacts` novo (fluxo que já existe para a
primeira mensagem de um contato).

Lógica:

1. Se `waContact.organization_id !== env.CRM_SYNC_ORGANIZATION_ID`, retorna
   sem fazer nada (contato de outra organização, fora de escopo).
2. Busca em `contacts` (CRM) por `phone = waContact.phone`, comparando o
   valor bruto (sem normalização de formato — ambas as colunas são `text`
   livre; assume-se que o número do WhatsApp já chega em E.164, o mesmo
   formato usado pelo CRM. Se isso não for verdade na prática, o matching
   falha silenciosamente e cria duplicados — a normalização fica como
   melhoria futura, fora deste escopo).
   - Se existir, reusa o `id`.
   - Se não existir, insere um novo `contacts` com `name`, `phone`
     (`email`/`company` ficam `null` — o WhatsApp não fornece esses dados).
3. Insere uma linha em `activities`: `title = "Novo contato via WhatsApp"`,
   `contact_id` = id do contato do CRM, `done = false`.

## 3. Autenticação e tratamento de erro

- `contacts.created_by` e `activities.assigned_to` no CRM são `nullable` e a
  RLS de ambas as tabelas não depende de `created_by` — registros criados
  pelo agente ficam com esses campos `null` e continuam visíveis
  normalmente no CRM.
- O worker roda em background, sem sessão de usuário logado. Precisa da
  **service role key** do Supabase (`SUPABASE_SERVICE_ROLE_KEY`, já prevista
  no `.env` do projeto, hoje com valor placeholder) para escrever no CRM
  ignorando RLS.
- Nova variável de ambiente: `CRM_SYNC_ORGANIZATION_ID` — o `organization_id`
  do aula-agente cuja `wa_contacts` deve sincronizar com o CRM.
- A chamada de sync é isolada em `try/catch`, executada depois do fluxo
  principal de salvar a conversa. Falha no sync é logada e não interrompe
  nem atrasa a resposta ao usuário do WhatsApp.

## 4. Testes

- Teste de unidade para `syncContactToCrm`, com o client do Supabase
  mockado, cobrindo:
  - contato novo → cria `contacts` + `activities`;
  - contato já existente (mesmo `phone`) → reusa `contacts.id`, cria só a
    `activities`;
  - organização fora de `CRM_SYNC_ORGANIZATION_ID` → não faz nenhuma
    chamada;
  - falha simulada do Supabase client → não lança exceção para o chamador.
- Sem teste de integração contra o Supabase real neste momento.

## Notas de implementação (para o plano)

- A migration de rename precisa rodar depois de `00002_organizations.sql`
  (já aplicada no banco remoto) e antes de `00007`/`00008`, que dependem do
  novo nome.
- `00001`–`00002` já foram aplicadas no projeto Supabase remoto durante a
  investigação deste bug; `00003` em diante ainda não.
- O valor real de `CRM_SYNC_ORGANIZATION_ID` só é conhecido depois que o
  usuário criar a primeira organização via `/onboarding` (ver conversa
  anterior sobre o bug de login) — não dá para fixá-lo antes disso.
- Deploy final é numa VPS gerenciada por EasyPanel (o worker já roda como
  serviço Docker via `Dockerfile.worker`/`docker-compose.yml`). As novas
  variáveis (`CRM_SYNC_ORGANIZATION_ID`, `SUPABASE_SERVICE_ROLE_KEY` real)
  precisam ser cadastradas nas env vars do serviço worker dentro do
  EasyPanel, além do `.env` local usado em dev — o plano de implementação
  deve cobrir os dois ambientes.
