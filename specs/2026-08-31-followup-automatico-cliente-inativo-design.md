# Followup Automático para Cliente Inativo — Design

**Data:** 2026-08-31
**Status:** Aprovado, aguardando plano de implementação

## Contexto

Hoje já existe um worker (`apps/worker/src/workers/stale-conversation-followup.ts`)
que roda a cada 15 minutos, varre conversas com `status = 'waiting'` (Helena
respondeu, cliente não voltou) e, se a conversa está parada há mais de
`stale_conversation_hours` (default 24h, `packages/shared/src/constants.ts`)
e o contato já tem algum sinal de oportunidade (`hasOpportunitySignalTask` —
tarefa de um dos tipos em `OPPORTUNITY_SIGNAL_TASK_TYPES`), ele cria uma task
`customer_unresponsive`.

Levantamento feito em produção (2026-08-31) mostrou o problema que isso gera:
de 219 tasks `pending`, **193 estão vencidas** (nenhuma nunca vai para
`in_progress`) — o worker cria a task, mas nada nunca age sobre ela. 315 das
445 conversas em `waiting` estão paradas há mais de 7 dias. A rede de
segurança "cria uma task" (already prevista no design original de
`2026-07-24-tasks-followup-comercial-design.md`, seção "Fora de escopo: sem
tela de configuração dos prazos") está funcionando como projetada, mas
sozinha não fecha o loop: ninguém volta a reengajar o cliente.

Esse design resolve o próximo passo dessa mesma seção "fora de escopo": expor
o prazo em configuração de UI e, além de criar a task, fazer a Helena mandar
a mensagem de reengajamento automaticamente — em até 2 tentativas.

## Objetivo

Quando uma conversa em `waiting` (cliente sem responder após última mensagem
da Helena) atinge um sinal de oportunidade e passa de um prazo configurável:

1. A Helena manda, sozinha, uma mensagem de reengajamento contextual pelo
   WhatsApp.
2. Se o cliente continuar em silêncio até um segundo prazo, ela tenta de novo
   — última tentativa automática.
3. Depois da 2ª tentativa sem resposta, ela para de insistir e deixa
   registrado, na task `customer_unresponsive` já existente, que 2
   tentativas automáticas falharam — para um humano decidir o próximo passo.
4. Tudo isso é liga/desliga e os dois prazos (em horas) são configuráveis por
   agente, na tela de configuração da Helena.

## Fora de escopo (YAGNI) nesta versão

- **Sem 3ª tentativa nem ciclo recorrente.** Depois de 2 tentativas
  automáticas sem resposta, a IA não manda mais nada sozinha nessa conversa
  — evita parecer spam. Um humano que reabrir o assunto (ligar, mandar
  mensagem manual) reseta o fluxo naturalmente, porque volta a mudar o
  `last_message_at`/status da conversa.
- **Sem tela de configuração por tipo de followup** (`consortium_followup`
  vs `financing_followup` etc. com prazos diferentes entre si). Os dois
  prazos valem para qualquer conversa que dispare a regra, independente do
  tipo de oportunidade sinalizada. Pode virar refinamento futuro.
- **Sem alterar o gate `hasOpportunitySignalTask`.** Continua sendo o mesmo
  crivo de "só reengaja quem já demonstrou interesse real" que o worker já
  usa hoje — não estamos ampliando nem afrouxando esse filtro.
- **Sem nova tabela.** Reaproveita `task_events` (já existe, já é
  append-only, já pendurado em `tasks`) para registrar cada tentativa
  automática, em vez de criar uma tabela `conversation_followups` nova.

## 1. Configuração — liga/desliga + 2 prazos, por agente

Novo campo em `ToolsConfig` (`packages/shared/src/types/agent.ts`), reaproveitando
a coluna `tools_config` (jsonb) de `agent_configs` — não é texto de prompt, é
um toggle operacional, o mesmo espírito de `create_task`:

```ts
export interface FollowupAutomaticoConfig {
  ativo: boolean;
  primeiro_followup_horas: number; // default 1
  segundo_followup_horas: number;  // default 23 — contadas a partir do silêncio, não do 1º followup
}

export interface ToolsConfig {
  search_knowledge: boolean;
  search_faq: boolean;
  send_catalog_photo: boolean;
  create_task: boolean;
  followup_automatico: FollowupAutomaticoConfig;
}
```

Como é uma coluna jsonb sem CHECK de schema, não precisa migration — só
atualizar o default em `agent_configs` (`tools_config jsonb NOT NULL DEFAULT
'{..., "followup_automatico": {"ativo": false, "primeiro_followup_horas": 1,
"segundo_followup_horas": 23}}'`) e tratar ausência do campo em configs
antigas com fallback no código (`agent.tools_config.followup_automatico ??
DEFAULT_FOLLOWUP_AUTOMATICO`). **Default `ativo: false`** — é uma mudança de
comportamento (a IA passa a mandar mensagem sozinha) grande o suficiente pra
não ligar por padrão em quem já está em produção.

**UI:** novo card em `apps/web/src/components/agents/config/ferramentas-section.tsx`,
mesmo padrão visual dos `TOOL_ROWS` existentes (Switch + descrição), mas com
dois campos numéricos (horas) que só aparecem quando o Switch está ligado.

## 2. Gatilho — reaproveita o worker existente

`stale-conversation-followup.ts` já faz exatamente o filtro certo:
`status = 'waiting'`, `is_human_takeover = false`, sinal de oportunidade via
`hasOpportunitySignalTask`. Ele passa a rodar a lógica de followup **por
agente** (hoje é por organização — como cada org tem 1 agente na prática
atual, mas o schema já é 1:N, o worker passa a buscar `agent_configs` de cada
agente da org e usar o `tools_config.followup_automatico` dele em vez do
`organizations.settings.task_rules` fixo).

A cada rodada (a cada 15 min, sem mudar o intervalo):

1. Para cada agente com `followup_automatico.ativo = true`:
2. Busca conversas `waiting` mais antigas que `primeiro_followup_horas` (a
   query já existente `getStaleWaitingConversations`, só troca o cutoff).
3. Para cada conversa, aplica o mesmo filtro de hoje
   (`hasOpportunitySignalTask`).
4. Decide o estágio (ver seção 3) e, se for o caso, dispara o followup (seção 4).

## 3. Controle de estágio — via `task_events`

Sem tabela nova. Cada tentativa automática vira um evento
(`event_type: "auto_followup_stage_1"` / `"auto_followup_stage_2"`) na task
`customer_unresponsive` da conversa (a mesma que `createTaskWithDedup` já
cria/atualiza). Nova query `getAutoFollowupEvents(conversationId)` (ou filtro
em cima de `getTaskEvents`) devolve os eventos desse tipo já registrados
**depois do último `last_message_at` em que o cliente falou** (para não
confundir com uma tentativa de um ciclo de silêncio anterior).

Lógica por conversa, a cada rodada do worker:

- Sem sinal de oportunidade → ignora (mesmo comportamento de hoje).
- Silêncio ≥ `primeiro_followup_horas` **e** nenhum evento
  `auto_followup_stage_1` desde a última resposta do cliente → manda
  mensagem, registra `stage_1`.
- Silêncio ≥ `segundo_followup_horas` **e** já existe `stage_1` **e** não
  existe `stage_2` (desde a última resposta do cliente) → manda mensagem,
  registra `stage_2`, e atualiza a task `customer_unresponsive` (via
  `updateTask` + `addTaskEvent`) com nota "2 tentativas automáticas sem
  resposta — avaliar próximo passo manualmente" e `priority: 'urgent'`.
- Já existe `stage_2` → não faz nada (para de insistir, conforme decidido).

Isso substitui o dedup atual do worker (que comparava `conversation.last_message_at`
com `priorAutoTask.created_at`) por uma verificação equivalente, mas baseada
nos eventos de estágio em vez da data de criação da task.

## 4. Geração e envio da mensagem — reaproveita `runAgent`

O worker chama `runAgent` (`packages/agent-runtime`), a mesma função que
`process-message.ts` usa para responder o cliente, passando o histórico real
da conversa (`getRecentMessages`) e model/tools do agente — mantendo tom,
regras e liberdade de chamar `create_task` de novo se a Helena achar
necessário.

**Diferença importante:** hoje `runAgent` sempre injeta `currentMessage.content`
como o último turno `user` — ou seja, sempre assume que existe uma mensagem
real do cliente disparando a resposta. Aqui não existe: o gatilho é "o
cliente não respondeu". Passar a instrução de reengajamento
("cliente sem resposta há Xh — se ainda fizer sentido, mande uma mensagem
natural de reengajamento com base na conversa") como se fosse uma fala do
cliente confundiria o modelo. `runAgent` precisa de um pequeno ajuste para
aceitar esse gatilho como uma instrução de sistema (o schema de `messages.role`
já suporta `'system'`) em vez de sempre tratá-lo como turno `user` — o
detalhe exato (novo parâmetro `trigger: { type: 'system_nudge', instruction }`
vs. reaproveitar `currentMessage` com `role: 'system'`) fica para o plano de
implementação.

A resposta gerada (se houver texto — a Helena pode decidir não mandar nada,
por exemplo se achar que não faz sentido insistir) segue o fluxo padrão:
`createMessage` (role `agent`) + `getSendMessageQueue().add(...)`, igual ao
que `process-message.ts` já faz. Isso também atualiza `last_message_at` e
mantém `status = 'waiting'` (a conversa continua esperando o cliente).

## 5. Depois da 2ª tentativa

Não há novo mecanismo de escalonamento. A task `customer_unresponsive` já é
visível na tela de Tarefas (prioridade alta/urgente, já ordenável por
atrasada); a nota adicionada em `task_events` explica que já houve 2
tentativas automáticas, para o humano decidir (ligar, desistir, etc.) sem
precisar abrir a conversa inteira para entender o histórico.

## Testes

- Unit: lógica de decisão de estágio (`stage_1`/`stage_2`/parar) dado um
  conjunto de eventos e um `last_message_at`, cobrindo os casos de borda
  (cliente respondeu entre as duas janelas — zera os estágios; segunda
  janela menor que a primeira por engano na config — não deve travar,
  documentar que a UI deve validar `segundo > primeiro`).
- Unit: fallback de `tools_config.followup_automatico` ausente (configs
  antigas) não quebra o worker.
- Integração (worker, com Supabase de teste): agente com `ativo: true`,
  conversa `waiting` com sinal de oportunidade e silêncio passando de cada
  prazo gera exatamente 1 mensagem + 1 evento por estágio, nunca duplica.
- Manual: validar em produção com um contato de teste (número próprio) antes
  de qualquer org real ligar o toggle, dado que já existe lição aprendida em
  `docs/operations/deployment.md` sobre validar contra dado real antes de
  assumir que uma mudança está no ar.
