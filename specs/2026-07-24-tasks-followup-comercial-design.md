# Tarefas / Follow-up Comercial — Design

**Data:** 2026-07-24
**Status:** Aprovado, aguardando plano de implementação

## Contexto

Hoje o atendimento (`apps/web/(dashboard)/inbox`) mostra conversas, mas não
existe nenhum lugar que registre "o que falta fazer" com cada cliente. Uma
combinação como "cliente disse que manda o CPF amanhã" só existe dentro do
texto da conversa — se ninguém voltar a ler aquela conversa amanhã, a
oportunidade morre em silêncio. Isso já foi identificado como o principal
buraco do funil comercial via WhatsApp.

Não existe hoje nenhum conceito de oportunidade/lead/deal dentro do
`aula-agente` (isso existe num CRM separado, ver
`specs/2026-07-17-crm-whatsapp-integration-design.md`, mas é outro schema,
outro produto, e a sincronização é unidirecional e só de contatos — não se
aplica aqui). Também não existe nenhuma tabela com nome/e-mail de usuário:
`organization_members` só guarda `user_id` (do Supabase Auth) + `role`.

## Objetivo

Um módulo **Tarefas** que:
1. Deixa a Helena (IA) criar tarefas de follow-up sozinha quando reconhece
   pistas na conversa ("te mando amanhã", "vou falar com minha esposa").
2. Deixa um humano criar/gerenciar tarefas manualmente, vinculadas ou não a
   uma conversa.
3. Garante que uma conversa comercial que "esfria" sem ninguém ter marcado o
   próximo passo ainda gera uma tarefa — rede de segurança automática.
4. Mostra tudo isso numa tela nova, com indicadores e uma visão de
   prioridade do dia.

## Fora de escopo (YAGNI) nesta primeira versão

- **Sem tabela `opportunities`/`deals`** — o pedido original sugere um campo
  `opportunity_id`, mas essa entidade não existe no schema atual e criar uma
  seria começar a construir um CRM completo, que é explicitamente o que se
  pediu para não fazer agora. O vínculo da tarefa com a "oportunidade" é
  feito por `contact_id` (+ `conversation_id` quando existir). Fica fácil
  adicionar uma tabela de oportunidades depois sem quebrar `tasks`.
- **Sem tela de configuração dos prazos automáticos** — os valores (ex:
  "follow-up depois de 24h sem resposta") ficam em
  `organizations.settings.task_rules`, com default aplicado em código. Dá
  para editar via SQL/API hoje; uma UI de configurações fica para depois.
- **Sem tabela de nomes de usuário nova** (`profiles`) — resolvido buscando
  e-mail sob demanda via Admin API do Supabase (ver seção 3). Mais simples
  que criar e manter uma tabela sincronizada, e resolve o mesmo problema.
- **Sem reatribuição em massa, sem relatórios/analytics de produtividade da
  equipe** — só o necessário para "não esquecer o cliente" e "ver o que
  fazer hoje".

## 1. Modelo de dados

Nova migration `supabase/migrations/00010_tasks.sql`, seguindo o padrão de
`00007_conversations.sql` (uuid PK via `extensions.uuid_generate_v4()`,
`organization_id` para RLS, trigger `update_updated_at` já existente).

Convenção do projeto (`conversations.status`, `messages.role`,
`organization_members.role`) é **valores de enum em inglês no banco**, com
tradução para português feita só na UI via mapas de label (ex:
`STATUS_LABELS` em `chat-header.tsx`). `tasks` segue a mesma convenção —
os nomes em português do pedido original (Pendente, Alta, "Cliente parou de
responder"...) viram labels de exibição, não valores de coluna.

```sql
CREATE TABLE tasks (
  id                 uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
  assignee_type      text CHECK (assignee_type IN ('human', 'ai')),
  assignee_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  type               text NOT NULL,
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  ai_summary         text,
  reason             text,
  priority           text NOT NULL DEFAULT 'normal'
                       CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled', 'rescheduled')),
  due_date           date NOT NULL,
  due_time           time,
  created_by_type    text NOT NULL CHECK (created_by_type IN ('ai', 'human')),
  created_by_id      uuid REFERENCES auth.users(id),
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_assignee_consistency CHECK (
    (assignee_type IS NULL AND assignee_id IS NULL) OR
    (assignee_type = 'ai' AND assignee_id IS NULL) OR
    (assignee_type = 'human' AND assignee_id IS NOT NULL)
  )
);

CREATE TABLE task_events (
  id                 uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  task_id            uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type         text NOT NULL, -- created | updated | rescheduled | completed | cancelled | assigned
  note               text,
  created_by_type    text NOT NULL CHECK (created_by_type IN ('ai', 'human')),
  created_by_id      uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
```

Índices: `(organization_id, status, due_date)` para as abas Hoje/Atrasadas/
Próximas, `(contact_id)` para o histórico do cliente, `(conversation_id)`
para achar tarefa aberta de uma conversa (dedupe e rede de segurança).

`type` é **texto livre validado na aplicação**, não `CHECK` no banco — a
lista de tipos (slugs em inglês, como o resto do schema) vive em
`packages/shared/src/constants.ts` (`TASK_TYPES`) e no zod schema de
criação. Adicionar um tipo novo (item 3 do pedido original) é editar essa
constante, sem migration.

`task_events` nunca tem linhas apagadas ou atualizadas (append-only) — é o
que sustenta o histórico do item 13 sem perder nada.

Responsável é modelado com dois campos, no mesmo espírito de
`created_by_type`/`created_by_id` (que já resolvem o mesmo problema para
"quem criou a tarefa"): `assignee_type` (`'human' | 'ai' | NULL`) +
`assignee_id` (preenchido só quando `assignee_type = 'human'`). `NULL`/
`NULL` significa **sem responsável** — nunca "é a Helena". Isso evita um
valor sentinela ambíguo e deixa explícito o caso "responsável é a IA"
(`assignee_type = 'ai'`, `assignee_id = NULL`, sem precisar de uma linha
fake em `auth.users` para a Helena). A `CHECK` de consistência entre os
dois campos (`tasks_assignee_consistency`, acima) garante que `assignee_id`
só existe quando `assignee_type = 'human'`, e nunca fica preenchido junto
com `assignee_type = 'ai'`.

**RLS**: nova migration `supabase/migrations/00011_tasks_rls.sql` que
repete o padrão exato do bloco `DO $$ ... FOREACH tbl IN ARRAY [...]`
de `00008_rls_policies.sql`, adicionando `tasks` e `task_events` (mesmas 4
policies org-scoped: select/insert/update/delete por
`organization_id IN (SELECT get_user_org_ids())`, reusando a função já
existente).

**Configuração de prazos automáticos (item 16)**: `organizations.settings`
(jsonb, já existe) ganha uma chave nova, sem migration de schema (é jsonb):

```json
"task_rules": {
  "stale_conversation_hours": 24,
  "think_it_over_days": 2
}
```

Se a chave não existir (organizações já criadas), o código usa defaults
exportados de `packages/shared/src/constants.ts`
(`DEFAULT_TASK_RULES`). Isso resolve a exigência de "não hardcoded na
interface" sem precisar construir uma tela de configurações agora.

## 2. Pacote compartilhado (`packages/shared`)

- `src/types/task.ts` — `Task`, `TaskEvent`, `TaskType`, `TaskPriority`,
  `TaskStatus`, `TaskCreatedByType`, seguindo o estilo de `types/conversation.ts`.
- `src/schemas/task.ts` — `createTaskSchema`, `updateTaskSchema`,
  `rescheduleTaskSchema`, no estilo de `schemas/conversation.ts`.
- `src/constants.ts` ganha:
  - `TASK_TYPES` (as const, slugs em inglês — ver tabela abaixo)
  - `OPPORTUNITY_SIGNAL_TASK_TYPES` — subconjunto de `TASK_TYPES` que
    representa evidência real de oportunidade comercial: todos os tipos
    **exceto** `other` e `customer_unresponsive` (simulação/proposta feita,
    entrada/parcela ou modelo tratado num `run_quote`/`update_quote`/
    `vehicle_followup`, CPF/dados pedidos ou prometidos, cliente que ficou
    de decidir, retorno agendado, negociação parada, follow-up de
    financiamento/consórcio). É o **único lugar** que define "sinal real de
    oportunidade" — usado tanto pela rede de segurança (seção 4) quanto
    pela seção "Leads quentes" da UI (seção 5), em vez de `priority` (que é
    sobre urgência de execução, um eixo diferente de "temperatura do
    lead").
  - `TASK_PRIORITIES = ["low", "normal", "high", "urgent"]`
  - `TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled", "rescheduled"]`
  - `DEFAULT_TASK_RULES = { stale_conversation_hours: 24, think_it_over_days: 2 }`
  - `QUEUE_NAMES.STALE_CONVERSATION_FOLLOWUP`

Os 15 tipos do pedido original, como slug (banco/tool) → label em português
(usado nos mapas de exibição no frontend, ex. `TASK_TYPE_LABELS` no estilo
de `STATUS_LABELS`):

| slug | label |
|---|---|
| `return_customer` | Retornar cliente |
| `request_documents` | Cobrar documentos |
| `run_quote` | Fazer simulação |
| `update_quote` | Atualizar simulação |
| `awaiting_customer_cpf` | Cliente ficou de enviar CPF |
| `awaiting_customer_data` | Cliente ficou de enviar dados |
| `awaiting_customer_decision` | Cliente ficou de falar com outra pessoa |
| `scheduled_callback` | Cliente pediu retorno em determinada data |
| `proposal_followup` | Follow-up de proposta |
| `financing_followup` | Follow-up de financiamento |
| `consortium_followup` | Follow-up de consórcio |
| `vehicle_followup` | Follow-up de veículo |
| `customer_unresponsive` | Cliente parou de responder |
| `stalled_negotiation` | Negociação sem conclusão |
| `other` | Outro |

Os quatro tipos `*_followup` compartilham o sufixo de propósito: a regra de
ordenação da seção 5 ("proposta/simulação enviada") usa
`type.endsWith("_followup")` para identificá-los sem precisar listar os
quatro nomes toda vez.

## 3. Backend (`apps/api`)

**`packages/database/src/queries/tasks.ts`** (padrão de `queries/conversations.ts`):
`createTask`, `updateTask`, `getTaskById`, `getOpenTaskByContactAndType`
(usada na deduplicação — filtra `status IN ('pending','in_progress','rescheduled')`),
`getTasksByOrganization` (filtros `status`/`bucket`), `getTasksByContact`,
`getOpenTaskByConversation` (usada pela rede de segurança),
`hasOpportunitySignalTask(client, contactId)` (busca, sem filtro de status,
se já existiu alguma tarefa daquele contato com `type` em
`OPPORTUNITY_SIGNAL_TASK_TYPES` — usada pela rede de segurança para decidir
se vale criar a tarefa automática), `addTaskEvent`, `getTaskEvents`.

**`apps/api/src/services/task.service.ts`** — regra de negócio única,
usada tanto pela rota HTTP quanto pela tool da Helena (import direto do
worker, mesmo pacote):

- `createTaskWithDedup(input)`: busca `getOpenTaskByContactAndType(contact_id, type)`.
  - Se **não existe**: insere a tarefa e grava `task_events` (`created`).
  - Se **existe**: atualiza `due_date`/`description`/`reason` da tarefa
    existente em vez de duplicar, e grava `task_events` (`updated`, com
    `note` explicando o que mudou). Retorna a tarefa e uma flag
    `{ wasUpdated: boolean }` — importante para a tool da Helena formular a
    resposta certa (ver seção 4).
  - Critério de "semelhante" na v1: mesmo `contact_id` + mesmo `type` +
    tarefa aberta. Simples e cobre o exemplo do pedido ("cobrar CPF do João
    amanhã" não duplica). Refinar por similaridade de texto fica para
    depois.
  - Responsável padrão: toda tarefa criada com `created_by_type: "ai"`
    (seja pela tool da Helena, seja pela rede de segurança da seção 4)
    recebe `assignee_type: "ai"` automaticamente, a menos que um valor
    explícito seja passado — a IA fica responsável até um humano assumir
    (editando a tarefa). Tarefas manuais exigem que quem cria escolha um
    responsável no formulário (humano ou "Helena"), cumprindo o item 12 do
    pedido ("toda tarefa deve possuir um responsável") sem depender de um
    default silencioso do lado humano.
- `completeTask(taskId, userId)`, `cancelTask(taskId, userId, note?)`,
  `rescheduleTask(taskId, userId, newDate, newTime?)` — cada uma atualiza
  `status`/`completed_at` e grava o `task_event` correspondente.
- `getOrganizationMembersDisplay(organizationId)` — lê
  `organization_members` e, para cada `user_id`, chama
  `getAdminClient().auth.admin.getUserById(user_id)` para pegar o e-mail.
  Resultado: `[{ user_id, email, role }]`. É só isso que resolve "Weslley",
  "Ana", "Mariana" na tela em vez de um UUID truncado — sem tabela nova.

**Rotas** (`apps/api/src/routes/tasks/index.ts`, registrada em
`server.ts`, com `authMiddleware` + checagem de `membership` igual às
rotas existentes):

| Método | Rota | Ação |
|---|---|---|
| GET | `/organizations/:organizationId/tasks?bucket=today\|overdue\|upcoming\|done` | listar |
| GET | `/organizations/:organizationId/tasks/summary` | os 4 indicadores do topo |
| GET | `/organizations/:organizationId/contacts/:contactId/tasks` | histórico do cliente (tasks + task_events) |
| GET | `/organizations/:organizationId/members/display` | membros com e-mail, para o select de Responsável |
| POST | `/organizations/:organizationId/tasks` | criar manual (`createTaskWithDedup`) |
| PATCH | `/tasks/:taskId` | editar campos livres |
| POST | `/tasks/:taskId/complete` | concluir |
| POST | `/tasks/:taskId/cancel` | cancelar |
| POST | `/tasks/:taskId/reschedule` | reagendar |

`bucket=today/overdue/upcoming/done` é calculado no service comparando
`due_date` com a data atual (fuso `America/Sao_Paulo`, ver seção 4) e
`status`, não uma coluna própria — evita ficar reescrevendo linhas todo
dia só porque "hoje" virou "atrasada".

## 4. Integração com a Helena (`apps/worker`)

**Tool nova** — `apps/worker/src/agents/tools/create-task.ts`, no mesmo
molde de `send-vehicle-photo.ts` (`tool()` do Vercel AI SDK + zod
`inputSchema` + `execute`):

```ts
inputSchema: z.object({
  type: z.enum(TASK_TYPES), // slugs da tabela da seção 2, ex. "return_customer"
  description: z.string(),
  due_date: z.string().describe("Data no formato YYYY-MM-DD"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  reason: z.string(),
})
```

`execute` chama `createTaskWithDedup` com `contact_id`/`conversation_id`/
`organization_id` vindos do contexto da tool (igual `send-vehicle-photo.ts`
já resolve `conversationId`/`organizationId`/`phone` via closure). Retorna
para o modelo uma string curta: `"Tarefa criada: {title} para {due_date}."`
ou, se foi dedupe, `"Já existia uma tarefa semelhante aberta — atualizada
para {due_date}."` — o modelo precisa saber qual dos dois aconteceu para
não anunciar "criei uma tarefa" quando na real só atualizou uma existente.

Registrada em `registry.ts` atrás de um novo toggle
`toolsConfig.create_task` (mesmo padrão de `search_knowledge`/`search_faq`/
`send_catalog_photo` — `ToolsConfig` em `packages/shared/src/types/agent.ts`
ganha esse quarto campo booleano). `agent-form.tsx` ganha um quarto switch,
"Criar tarefas de follow-up", ao lado dos três existentes.

**Data atual no prompt** — hoje `agent-runner.ts` manda `agent.system_prompt`
estático pro modelo; a Helena não tem como saber que dia é "hoje" para
resolver "amanhã" ou "dia 5". Ajuste pequeno e necessário: em
`runAgent`, o `system` enviado ao modelo passa a ser
`` `${agent.system_prompt}\n\nData e hora atual: ${formatNowForPrompt()}` ``,
onde `formatNowForPrompt()` formata `new Date()` em `America/Sao_Paulo`
(ex: `"quinta-feira, 24 de julho de 2026, 14:32"`). Isso é o que faz os
exemplos 1, 2 e 4 do pedido (cliente diz "amanhã", "dia 5") funcionarem —
sem isso a tool receberia datas erradas ou o modelo se recusaria a
inventar uma data.

**Rede de segurança (item 7)** — novo worker
`apps/worker/src/workers/stale-conversation-followup.ts`, no molde exato de
`takeover-timeout.ts` (mesmo uso de `Worker` + `upsertJobScheduler`,
rodando a cada 15 min):

1. Busca `conversations` com `status = 'waiting'`, `is_human_takeover =
   false`, `last_message_at` mais antigo que
   `organizations.settings.task_rules.stale_conversation_hours` (default
   24h) atrás.
2. Para cada uma, `getOpenTaskByConversation` — se já existe tarefa aberta
   vinculada, pula (não duplica o trabalho que a Helena ou um humano já
   fez).
3. **Exige sinal real de oportunidade comercial antes de criar qualquer
   coisa** — decisão explícita para não gerar ruído: uma conversa parada
   sem nenhuma evidência de intenção de compra **não** vira tarefa
   automaticamente, mesmo depois de dias parada. O sinal é
   `hasOpportunitySignalTask(contact_id)` (seção 3): já existiu, aberta ou
   não, alguma tarefa daquele contato com `type` em
   `OPPORTUNITY_SIGNAL_TASK_TYPES` (seção 2) — ou seja, simulação/proposta
   feita, CPF/dados pedidos ou prometidos, cliente que ficou de decidir,
   retorno agendado, negociação em andamento. Sem isso, o worker não faz
   nada com aquela conversa.
4. Só quando o sinal existe, chama `createTaskWithDedup` com
   `type: "customer_unresponsive"`, `created_by_type: "ai"`,
   `assignee_type: "ai"`, `reason: "Sem resposta há mais de {N}h, com sinal
   de oportunidade em aberto"`, `due_date`: hoje, `priority: "high"`.

Novo `packages/queue/src/types.ts` → `StaleConversationFollowupJobData {}`
(sem payload, igual `TakeoverTimeoutJobData`), nova entrada em
`packages/queue/src/queues.ts` (`getStaleConversationFollowupQueue`), nova
`QUEUE_NAMES.STALE_CONVERSATION_FOLLOWUP` em `packages/shared/src/constants.ts`,
e `startStaleConversationFollowupWorker()` chamado em
`apps/worker/src/index.ts` junto dos outros três workers.

## 5. Frontend (`apps/web`)

- **Menu**: `components/layout/app-sidebar.tsx` ganha
  `{ name: "Tarefas", href: "/tasks", icon: ListChecks }` entre "Conversas"
  e "Agentes".
- **Página** `app/(dashboard)/tasks/page.tsx`: busca via Supabase client
  direto (RLS já cobre `tasks`, mesmo padrão de `inbox/page.tsx` com
  `conversations`) + `apiFetch("/organizations/:id/tasks/summary")` para os
  4 indicadores. Uma única tela (decisão já validada com o usuário):
  - Indicadores no topo: tarefas hoje, atrasadas, concluídas hoje, leads
    quentes com tarefa aberta.
  - Abas Hoje / Atrasadas / Próximas / Concluídas (mesmo padrão visual das
    `FILTER_TABS` do inbox), com `STATUS_LABELS`/`PRIORITY_LABELS`/
    `TASK_TYPE_LABELS` traduzindo os slugs em inglês para português na
    exibição — mesmo papel que `STATUS_LABELS` já cumpre em
    `chat-header.tsx`.
  - Dentro da aba "Hoje", as tarefas são agrupadas em 🔥 Leads quentes / 🟡
    Follow-ups, usando um helper isolado `isHotLead(task)` — hoje ele só
    verifica `task.type ∈ OPPORTUNITY_SIGNAL_TASK_TYPES` e a tarefa estar
    aberta. É esse helper, e só ele, que muda no dia em que existir um
    `lead_temperature`/`opportunity_score` de verdade (por contato ou numa
    futura tabela de oportunidades) — o card, o indicador do topo
    ("leads quentes com tarefa aberta") e a ordenação consomem apenas o
    booleano que ele devolve, nunca `type` ou `priority` diretamente.
    `priority` continua existindo só para "quão urgente é executar isso" —
    um eixo diferente de "quão quente é o lead", nunca usado como proxy um
    do outro.
    Ordenação dentro de "Hoje": 1) `isHotLead` primeiro, 2) `due_time` mais
    cedo primeiro (nulos por último), 3) tempo desde o `last_message_at` da
    conversa vinculada (mais tempo parado primeiro), 4) `priority` como
    critério de desempate. "Atrasadas" continua em aba própria, fora desse
    agrupamento por 🔥/🟡 (decisão de abas Hoje/Atrasadas/Próximas/
    Concluídas já validada anteriormente).
- **Componentes novos** em `components/tasks/`:
  - `task-card.tsx` — linha/card com cliente, produto/interesse (via
    `wa_contacts.name`/telefone; "produto/interesse" vem de `description`/
    `ai_summary`, não existe campo de catálogo vinculado no pedido), motivo,
    data, responsável, prioridade, status, e as ações rápidas (Abrir
    conversa, Concluir, Reagendar, Editar, Cancelar) chamando as rotas da
    seção 3.
  - `task-dialog.tsx` — criar/editar, no molde de `invite-dialog.tsx`
    (`Dialog` + campos + submit via `apiFetch`). O select de Responsável
    tem três formatos de opção, mapeados para `assignee_type`/`assignee_id`:
    "Sem responsável" (`assignee_type: null, assignee_id: null`), "Helena"
    como primeira opção fixa (`assignee_type: "ai", assignee_id: null`), e
    a lista de `GET /members/display` (`assignee_type: "human",
    assignee_id: member.user_id`) — `null` nunca representa a Helena.
  - `task-list.tsx` — agrupamento + ordenação descritos acima.
- **"Abrir conversa"**: `router.push(\`/inbox?id=${task.conversation_id}\`)`
  — mesma navegação que `inbox/page.tsx` já usa internamente
  (`handleSelect`). Se a tarefa não tiver `conversation_id` (criada
  manualmente sem vínculo), o botão fica desabilitado.
- **Dentro do atendimento**: botão "Criar tarefa" no `chat-header.tsx` (ao
  lado do botão de detalhes), abrindo `task-dialog.tsx` com `contact_id` e
  `conversation_id` pré-preenchidos a partir da `conversation` já carregada
  pelo `chat-panel.tsx`.
- **Histórico no cliente** (item 13): dentro de `side-panel.tsx`, nova
  seção "Tarefas" abaixo das notas, listando `task_events` da conversa/
  contato em ordem cronológica — mesmo componente de lista usado na página
  de Tarefas, sem paginação nesta v1.

## Fluxo de exemplo (ponta a ponta)

1. Cliente: "Vou falar com minha esposa e te retorno."
2. Helena chama `create_task({ type: "return_customer", due_date: "2026-07-26", priority: "normal", description: "Cliente ficou de conversar com a esposa sobre a proposta.", reason: "Cliente pediu tempo para decidir com a esposa" })` — a data "2 dias depois" é a própria Helena que calcula, usando a data atual que agora está no prompt.
3. `createTaskWithDedup` não encontra tarefa aberta igual para esse contato → cria com `assignee_type: "ai"` (default para tarefa de origem `ai`), grava `task_events` (`created`, `by: ai`).
4. A tarefa aparece na aba "Próximas" (ainda não é hoje) e já conta como 🔥 lead quente (`return_customer` está em `OPPORTUNITY_SIGNAL_TASK_TYPES`), independente da prioridade escolhida.
5. Dois dias depois, ela migra automaticamente para "Hoje" (é `bucket`, calculado por data, não um campo fixo).
6. Wallace abre "Tarefas" → vê o card 🔥 → clica "Abrir conversa" → cai direto na conversa daquele cliente, sem precisar procurar.
7. Ele conversa, decide que ainda não fechou → clica "Reagendar" → nova data, `task_events` ganha uma linha `rescheduled`.
8. Se em vez disso o cliente tivesse recebido uma simulação (existe no histórico do contato uma tarefa `run_quote`, mesmo já concluída) e simplesmente sumido sem marcar nada, e a conversa ficasse 24h parada em `waiting` sem nenhuma tarefa aberta, o worker `stale-conversation-followup` criaria sozinho uma tarefa `customer_unresponsive` ("Cliente parou de responder") — rede de segurança do item 7. Se não houvesse nenhum sinal de oportunidade no histórico do contato (ex: uma conversa que nunca passou de "vocês vendem X?"), o worker não cria nada — evita ruído em conversas sem intenção real demonstrada.

## Testes

- `createTaskWithDedup`: unitário (Supabase client mockado, no estilo de
  `apps/worker/src/agents/tools/search-catalog.test.ts` /
  `apps/api/src/routes/dashboard/dashboard.test.ts`), cobrindo os dois
  ramos (cria vs. atualiza) e o caso "tipo diferente não deduplica".
  Serve tanto para a rota HTTP quanto para a tool.
  Cobre o exemplo do pedido: duas chamadas seguidas com o mesmo
  `contact_id`+`type` não geram duas linhas em `tasks`.
- `formatNowForPrompt` / cálculo de `bucket` (hoje/atrasada/próxima): função
  pura, testável isolando a data injetada.
  Cobre: task com `due_date` = hoje mas `status = 'completed'` cai em
  "concluídas", não em "hoje".
- Ordenação da aba "Hoje" (as 6 regras do item 11): função pura sobre uma
  lista fixa de tarefas de teste.
- `stale-conversation-followup`: unitário, mesma abordagem de
  `takeover-timeout.ts` mas sem teste existente hoje para esse worker — sigo
  o precedente do projeto (rotas/workers com I/O externo real não têm teste
  automatizado aqui) e valido manualmente rodando o worker localmente contra
  o banco de dev.
- Sem teste E2E de UI nesta v1 — mesma prática das outras specs deste
  projeto.

## Notas de implementação (para o plano)

- Ordem das migrations: `00010_tasks.sql` antes de `00011_tasks_rls.sql`
  (que depende da tabela existir e de `get_user_org_ids()`, já criada em
  `00008`).
- `ToolsConfig` ganhar um campo novo (`create_task`) é uma mudança
  aditiva — agentes existentes que não tiverem essa chave no
  `tools_config` (jsonb) simplesmente tratam como `false`/tool
  desabilitada; não precisa de migration de dados.
- O toggle de "Criar tarefas de follow-up" deve vir **desligado por
  padrão** para agentes existentes — é um comportamento novo com efeito
  colateral real (cria dado, pode gerar ruído se a Helena exagerar), o
  usuário deve ligar conscientemente por agente, igual às outras tools.
- `stale-conversation-followup` é ativado globalmente (não por agente) já
  que atua sobre a tabela `conversations` diretamente — o plano deve
  decidir se isso precisa de um jeito de desligar por organização (hoje o
  design assume que sim, é sempre ligado, só o prazo em horas é
  configurável).
- Como no `2026-07-23-agent-vehicle-catalog-photo-design.md`, o worker roda
  como serviço Docker via EasyPanel — nenhuma variável de ambiente nova é
  necessária aqui (tudo usa a mesma `SUPABASE_SERVICE_ROLE_KEY` já
  configurada), então não há passo extra de deploy além do build normal.
- `isHotLead` e `hasOpportunitySignalTask` são heurísticas explícitas desta
  v1, não um score de verdade — o dia em que existir `lead_temperature` ou
  `opportunity_score` (por contato, ou numa futura tabela de
  oportunidades), a troca fica isolada nesses dois pontos; nenhum outro
  arquivo (card, indicador, ordenação, worker) precisa mudar, porque todos
  consomem só o booleano que eles devolvem.
- A `CHECK` `tasks_assignee_consistency` roda no banco — inserir
  `assignee_type = 'human'` sem `assignee_id` (ou vice-versa) falha na
  escrita, não faz o dado ficar inconsistente até alguém notar na leitura.
