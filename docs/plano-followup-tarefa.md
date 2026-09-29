# Follow-up direto da Tarefa — Plano de Implementação

> Branch: `feat/followup-na-tarefa` (a partir da `main`). Mesmo processo das
> Fases 1 e 2: TDD, commit sem push, flag desligada por padrão, migration só
> com aprovação explícita do usuário, passo a passo de deploy/ativação ao
> final.

**Objetivo:** a atendente executa o follow-up de uma tarefa (mensagem
sugerida por IA, editável) direto da aba Tarefas e da visão "Hoje", sem abrir
o WhatsApp — com proteção anti-ban do número, sem confundir a Helena quando o
cliente responder, e sem estourar o custo de IA em regenerações.

## Decisões (todas aprovadas, 2026-09-28/29)

- **D1 — Tipos elegíveis.** Todo tipo cujo próximo passo é o cliente
  responder entra: `return_customer`, `request_documents`,
  `awaiting_customer_cpf`, `awaiting_customer_data`,
  `awaiting_customer_decision`, `scheduled_callback`, `proposal_followup`,
  `financing_followup`, `consortium_followup`, `vehicle_followup`,
  `customer_unresponsive`, `stalled_negotiation`, `libera_cred_resumption`.
  Ficam de fora (internos): `run_quote`, `update_quote`, `other`.
  **Exceção:** se a tarefa tem `opportunity_id` e a oportunidade vinculada
  está com `waiting_on = "scheduled_date"` e `waiting_on_until` no futuro, o
  botão de envio não aparece até a data chegar — reaproveita
  `decideFollowupGate` (`packages/shared/src/task-helpers.ts:131-163`, já
  existe e já é usado pelo `stale-conversation-followup`).
- **D2 — Tarefa sem `conversation_id`.** Se a tarefa não tem conversa
  vinculada, busca a conversa **aberta** do contato (nova query
  `findOpenConversationByContact`, sem exigir `agent_id` como a
  `findOpenConversation` existente exige). Se não houver nenhuma conversa
  aberta, o botão de envio não aparece — nunca cria conversa nova nesta
  feature.
- **D3 — Takeover.** Por padrão, enviar o follow-up **não** ativa
  `is_human_takeover` — a Helena continua respondendo normalmente. Flag de
  organização `task_followup_takeover_on_send` (padrão `false`) liga a
  ativação, se a organização quiser.
- **D4 — Sem `handoff_events`.** Não é um handoff de verdade (a IA não parou
  de atender). Registro fica só em `task_events` (novo tipo
  `followup_sent`, para o histórico da tarefa) e na nova tabela
  `task_followup_sends` (estrutura própria para throttle + métricas).
- **D5 — Rate limit por instância.** Intervalo mínimo e limite diário contam
  por `evolution_instance_id`, não por organização (uma org pode ter até 3
  números). Configuração fica em `organizations.settings`, a contagem é por
  instância.
- **D6 — UI no "Hoje".** O botão "Enviar" no widget abre o mesmo
  `task-detail-panel.tsx` já usado na aba Tarefas — sem duplicar a UI de
  sugestão/edição.
- **D7 — Métricas.** Só o endpoint agregado nesta rodada
  (`GET /organizations/:id/followups/metrics`), sem página de relatório —
  isso fica para uma Fase de Medição futura (já prevista no
  `plano-handoff.md`).

## Requisitos adicionais (2026-09-29)

1. **Eco da Evolution — bug pré-existente encontrado e a corrigir.**
   Hoje `POST /messages/send` salva a mensagem com `evolution_message_id:
   null` (`apps/api/src/routes/messages/send.ts:47`). Quando o eco
   (`fromMe: true`) chega no webhook com o id real, o check de idempotência
   `messageExistsByEvolutionId` não encontra nada com `NULL` e **cria uma
   linha duplicada** — isso já acontece hoje para **toda** mensagem enviada
   pelo painel, não é novo desta feature. Corrige na raiz: o worker de envio
   passa a capturar o id retornado pela Evolution API e gravá-lo de volta na
   linha já salva, para o webhook reconhecer o eco corretamente. Vale tanto
   para follow-up de tarefa quanto para o envio manual existente.
2. **Contexto da Helena.** Generaliza a regra fixa de "Notas operacionais"
   (hoje só cobre saudação curta) para qualquer mensagem de atendente humano
   no histórico — incluindo um follow-up de tarefa — sem precisar marcar a
   origem da mensagem: a Helena nunca trata uma mensagem `human_agent` do
   histórico como instrução nova ou início de atendimento; sempre continua
   de onde parou, sem repetir o conteúdo nem cumprimentar de novo.
3. **Limite de regenerações.** Novo campo `tasks.followup_regeneration_count`
   + config de organização `task_followup_max_regenerations` (padrão 5).

## Migration `00030_task_followup.sql`

```sql
ALTER TABLE tasks
  ADD COLUMN followup_suggested_message text,
  ADD COLUMN followup_suggestion_generated_at timestamptz,
  ADD COLUMN followup_regeneration_count integer NOT NULL DEFAULT 0;

CREATE TABLE task_followup_sends (
  id                          uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  instance_id                 uuid NOT NULL REFERENCES evolution_instances(id) ON DELETE CASCADE,
  task_id                     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  conversation_id             uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id                  uuid REFERENCES messages(id) ON DELETE SET NULL,

  suggestion_status           text NOT NULL CHECK (suggestion_status IN ('original', 'edited')),
  regenerations_before_send   integer NOT NULL DEFAULT 0,

  sent_by_type                text NOT NULL CHECK (sent_by_type IN ('human', 'system')),
  sent_by_id                  uuid,

  sent_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_followup_sends_instance_sent_at
  ON task_followup_sends(instance_id, sent_at DESC);
CREATE INDEX idx_task_followup_sends_org_sent_at
  ON task_followup_sends(organization_id, sent_at DESC);

ALTER TABLE task_followup_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_followup_sends_select" ON task_followup_sends
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "task_followup_sends_insert" ON task_followup_sends
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
```

Reversível (`DROP TABLE task_followup_sends; ALTER TABLE tasks DROP COLUMN
...`), aditiva, não toca nada existente. **Só aplico com seu OK, como
sempre.**

## Arquivos

**packages/shared/src:**
- `types/task.ts` — `TaskEventType` ganha `"followup_sent"`; `Task` ganha
  `followup_suggested_message`, `followup_suggestion_generated_at`,
  `followup_regeneration_count`.
- `types/organization.ts` — `task_followup_enabled`,
  `task_followup_takeover_on_send`, `task_followup_min_interval_seconds`,
  `task_followup_daily_limit`, `task_followup_max_regenerations`.
- `types/ai-usage-event.ts` — `AiUsageSource` ganha
  `"task_followup_suggestion"`.
- `constants.ts` — `TASK_FOLLOWUP_ELIGIBLE_TYPES` (a lista do D1),
  `DEFAULT_TASK_FOLLOWUP_CONFIG` (min_interval_seconds: 45, daily_limit: 40,
  max_regenerations: 5, takeover_on_send: false).
- `task-followup-throttle.ts` (novo) — `evaluateFollowupThrottle({
  lastSentAt, sentTodayCount, minIntervalSeconds, dailyLimit, now })` →
  `{ allowed: boolean, reason?: "min_interval" | "daily_limit",
  retryAfterSeconds?: number }`. Função pura, testada isolada.
- `task-followup-eligibility.ts` (novo) — `isTaskFollowupEligible(taskType)`
  (lookup na lista D1) e reexporta `decideFollowupGate` já existente para o
  caller montar a regra completa (tipo elegível + gate de data combinada).
- `prompt-builder.ts` — generaliza `compileOperationalNotesSection` (requisito 2).
- `index.ts` — exporta os dois arquivos novos.

**packages/database/src:**
- `queries/messages.ts` — `setMessageEvolutionId(client, id,
  evolutionMessageId)`.
- `queries/conversations.ts` — `findOpenConversationByContact(client,
  contactId)`.
- `queries/task-followup-sends.ts` (novo) — `createTaskFollowupSend`,
  `getLastFollowupSendForInstance(client, instanceId)`,
  `countFollowupSendsForInstanceSince(client, instanceId, sinceISO)`,
  `getFollowupMetrics(client, organizationId, sinceISO)` (agrega por
  `suggestion_status` para o endpoint de métricas do D7).
- `queries/tasks.ts` — `incrementFollowupRegenerationCount`,
  `setFollowupSuggestion(client, taskId, message)`.

**packages/queue/src:**
- `types.ts` (ou onde `SendMessageJobData` vive) — sem mudança de forma,
  `messageId` já existe no payload.

**apps/worker/src:**
- `workers/send-message.ts` — depois de um envio bem-sucedido, extrai o id
  retornado pela Evolution (`response.key?.id`) e chama
  `setMessageEvolutionId`. Cobre texto/mídia/áudio.
- `lib/task-followup-suggestion.ts` (novo) — `generateTaskFollowupSuggestion`,
  mesmo padrão do `libera-cred-resumption-message.ts` (generateObject + zod,
  nunca inventa dado): recebe últimas mensagens, qualificação, oportunidade
  (estágio/valores) e a tarefa; se `task.type === "libera_cred_resumption"`
  e ainda não tem `followup_suggested_message`, reaproveita
  `task.description` como sugestão inicial em vez de gerar de novo. Chama
  `recordAiUsageEvent` (fonte `task_followup_suggestion`) — corrige a lacuna
  que o gerador do LiberaCred já tinha e que não vou repetir aqui.

**apps/api/src:**
- `services/message-send.service.ts` (novo — extraído de
  `routes/messages/send.ts`) — `sendPanelMessage({ conversationId,
  organizationId, content, actorUserId, activateTakeover, metadata })`
  reaproveitado por `/messages/send` (comportamento inalterado,
  `activateTakeover: true` sempre) e pela nova rota de follow-up.
- `services/task-followup.service.ts` (novo) — orquestra: elegibilidade
  (tipo + gate de data), resolve conversa (própria ou fallback do D2),
  throttle por instância, gera/reaproveita sugestão, aplica limite de
  regeneração, chama `sendPanelMessage`, grava `task_followup_sends` +
  `task_events` (`followup_sent`), conclui a tarefa só depois do envio
  confirmado.
- `routes/tasks/index.ts` — duas rotas novas, mesmo padrão de
  `/tasks/:taskId/complete`:
  - `POST /tasks/:taskId/followup-suggestion` — gera (ou regenera) a
    sugestão; retorna `{ message, regenerationsRemaining }`; 429 se estourou
    `task_followup_max_regenerations`.
  - `POST /tasks/:taskId/send-followup` — body `{ message: string }`;
    **síncrono** (chama a Evolution API direto, não pela fila — ver "Decisão
    de design" abaixo); retorna a tarefa concluída em caso de sucesso, ou
    400 com o motivo (throttle/erro Evolution) sem completar a tarefa.
- `routes/dashboard/followups.ts` (novo, ou dentro de `dashboard/index.ts`)
  — `GET /organizations/:id/followups/metrics` (D7): total enviado,
  original vs. editado, e um placeholder de taxa de resposta 24h/72h
  (calculado sob demanda, olhando se existe mensagem `role=contact` depois
  de `sent_at` dentro da janela).

**apps/web/src:**
- `components/tasks/task-detail-panel.tsx` — novo bloco "Enviar follow-up"
  (visível só se elegível): textarea editável pré-preenchida, botão "Gerar
  outra" (desabilitado ao bater o limite, com aviso), botão "Enviar e
  concluir" com confirmação curta (mostra texto + contato), estado
  "enviando" com erro inline e "tentar de novo" se falhar.
- `app/(dashboard)/page.tsx` — botão "Enviar" no card "Hoje" que abre o
  `task-detail-panel.tsx` (D6) para aquela tarefa.
- `app/(dashboard)/settings/page.tsx` — novo card "Follow-up pela tarefa"
  com o toggle mestre + os 4 campos de configuração.

## Decisão de design (não é decisão em aberto, mas quero deixar explícita)

O envio do follow-up chama a Evolution API **direto na rota**, sem passar
pela fila `send-message`. Motivo: o requisito "a tarefa só conclui quando o
envio for confirmado, e mostra erro com opção de tentar de novo" pede uma
confirmação síncrona; construir esse feedback via fila exigiria um caminho
de volta fila→tarefa que não existe hoje. Como o follow-up já tem throttle
próprio (intervalo mínimo + limite diário por instância), não depende do
limitador de 30msg/s da fila para não tomar ban. Se preferir manter tudo na
fila mesmo assim, me avisa antes de eu implementar essa parte — é a única
peça do plano que eu decidi sozinho sem te perguntar.

## Plano tarefa a tarefa (TDD)

### Bloco 0 — corrigir o eco duplicado (requisito 1, pré-requisito de tudo)

**Tarefa 1: `setMessageEvolutionId`**
- Teste em `packages/database/src/queries/messages.test.ts`: dado um id de
  mensagem existente, `setMessageEvolutionId` atualiza `evolution_message_id`
  e retorna a linha atualizada.
- Implementa em `packages/database/src/queries/messages.ts`.

**Tarefa 2: worker grava o id real após enviar**
- Teste em `apps/worker/src/workers/send-message.test.ts`: mocka
  `sendEvolutionText` retornando `{ key: { id: "EVO123" } }`; espera que
  `setMessageEvolutionId(db, job.data.messageId, "EVO123")` seja chamado.
  Repete para o branch de mídia e o de áudio (usa o id do texto de fallback
  quando o áudio falha, já que é o texto que efetivamente sai).
- Implementa a captura do id nos três branches de `send-message.ts`.

**Tarefa 3: teste de regressão ponta a ponta do eco**
- Teste em `apps/api/src/routes/webhooks/evolution.test.ts`: salva uma
  mensagem `human_agent` com `evolution_message_id` já preenchido (simulando
  o backfill da Tarefa 2), depois simula o payload do webhook com
  `fromMe: true` e aquele mesmo id — espera que `messageExistsByEvolutionId`
  encontre a linha e **nenhuma mensagem duplicada seja criada**. Teste
  complementar: sem o backfill (id `null`), confirma o comportamento antigo
  (duplica) só pra documentar o bug que está sendo fechado — pode ser um
  teste que eu removo depois, ou deixo como caracterização; decido ao
  escrever.
- Commit.

### Bloco 1 — fundações (shared)

**Tarefa 4: `TASK_FOLLOWUP_ELIGIBLE_TYPES` + `isTaskFollowupEligible`**
- Teste em `packages/shared/src/task-followup-eligibility.test.ts`: cobre os
  13 tipos elegíveis (true) e os 3 não elegíveis (false).
- Implementa `task-followup-eligibility.ts`.

**Tarefa 5: `evaluateFollowupThrottle`**
- Teste em `packages/shared/src/task-followup-throttle.test.ts`: sem envio
  anterior → `allowed: true`; envio há menos que `minIntervalSeconds` →
  `allowed: false, reason: "min_interval"`, `retryAfterSeconds` correto;
  `sentTodayCount >= dailyLimit` → `allowed: false, reason: "daily_limit"`;
  os dois limites simultâneos → reporta `min_interval` primeiro (é o que a
  atendente vai resolver primeiro, esperando alguns segundos).
- Implementa.

**Tarefa 6: tipos e constantes**
- Adiciona os campos em `types/task.ts`, `types/organization.ts`,
  `types/ai-usage-event.ts`, `DEFAULT_TASK_FOLLOWUP_CONFIG` em
  `constants.ts`, exports em `index.ts`. Sem lógica nova, sem teste próprio
  (cobertura vem dos testes que os consomem depois) — só `tsc` limpo.

**Tarefa 7: generaliza `compileOperationalNotesSection`**
- Teste em `packages/shared/src/prompt-builder.test.ts`: a seção passa a
  cobrir qualquer mensagem `human_agent` (não só saudação curta) — atualiza
  o teste existente que checava o texto literal e adiciona um caso novo.
- Implementa a nova redação.
- Commit do Bloco 1.

### Bloco 2 — banco (novas queries, sem migration ainda)

**Tarefa 8: `findOpenConversationByContact`**
- Teste em `packages/database/src/queries/conversations.test.ts`: encontra a
  conversa com `status IN (open, waiting)` mais recente do contato,
  independente do agente; retorna `null` se não houver nenhuma.
- Implementa.

**Tarefa 9: `queries/task-followup-sends.ts`**
- Teste (fake client, mesmo padrão de `tasks-consolidation.test.ts`):
  `createTaskFollowupSend` insere; `getLastFollowupSendForInstance` retorna
  o mais recente por `instance_id`; `countFollowupSendsForInstanceSince`
  conta desde uma data; `getFollowupMetrics` agrega
  original/editado/total no período.
- Implementa (depende da migration existir para rodar de verdade — os
  testes usam o fake client, então não bloqueiam; a integração real só roda
  depois da migration aplicada).

**Tarefa 10: `tasks.ts` — sugestão e regeneração**
- Teste em `packages/database/src/queries/tasks.test.ts`:
  `setFollowupSuggestion` grava `followup_suggested_message` +
  `followup_suggestion_generated_at`; `incrementFollowupRegenerationCount`
  incrementa e retorna o novo valor.
- Implementa. Commit do Bloco 2.

### Bloco 3 — migration `00030` (⛔ só com seu OK antes de aplicar em produção; localmente aplico no banco de dev/testes se houver, ou sigo com os testes que usam fakes)

**Tarefa 11: escreve `supabase/migrations/00030_task_followup.sql`**
- Sem teste próprio (é SQL). Commit.
- **Não aplico em produção nesta tarefa** — só ao final, junto do deploy,
  com seu OK explícito, como nas Fases 1 e 2.

### Bloco 4 — geração da sugestão por IA (worker)

**Tarefa 12: `generateTaskFollowupSuggestion`**
- Teste em `apps/worker/src/lib/task-followup-suggestion.test.ts`: mocka
  `generateObject`; cobre (a) geração normal com contexto de
  mensagens/qualificação/oportunidade; (b) reaproveita
  `task.description` sem chamar `generateObject` quando `task.type ===
  "libera_cred_resumption"` e não há sugestão salva ainda; (c) nunca inclui
  valor fora da tabela/base (mesmo guardrail do LiberaCred); (d) chama
  `recordAiUsageEvent` com `source: "task_followup_suggestion"`; (e) erro no
  `generateObject` → retorna fallback seguro (não derruba a chamada).
- Implementa.
- Commit do Bloco 4.

### Bloco 5 — serviços da API

**Tarefa 13: extrai `message-send.service.ts` de `routes/messages/send.ts`**
- Teste em `apps/api/src/services/message-send.service.test.ts`: comportamento
  idêntico ao que `send.ts` já tem hoje (takeover, `handleConversationTakeover`,
  `handoff_events` `painel_manual`, `markFirstHumanReply`), só que parametrizado
  por `activateTakeover` (default `true`) e aceitando `metadata`.
- Refatora `send.ts` para usar o service (sem mudar comportamento — roda a
  suíte de `send.test.ts` existente antes e depois pra garantir).
- Commit.

**Tarefa 14: `task-followup.service.ts` — elegibilidade e resolução de conversa**
- Teste: tarefa de tipo não elegível → rejeita; tarefa gateada por
  `waiting_on = scheduled_date` futuro → rejeita; tarefa sem
  `conversation_id` mas contato com conversa aberta → usa a conversa
  encontrada; tarefa sem `conversation_id` e sem conversa aberta → rejeita
  com motivo claro.
- Implementa a parte de elegibilidade + resolução de conversa (sem o envio
  ainda).

**Tarefa 15: `task-followup.service.ts` — throttle + envio + conclusão**
- Teste: dentro do intervalo mínimo → rejeita com `retryAfterSeconds`;
  acima do limite diário → rejeita; caminho feliz → chama
  `sendPanelMessage` com `activateTakeover:
  org.settings.task_followup_takeover_on_send ?? false`, grava
  `task_followup_sends` (`suggestion_status` comparando o texto enviado com
  `task.followup_suggested_message`), grava `task_events`
  (`followup_sent`), conclui a tarefa; falha no envio → tarefa continua
  aberta, nada é gravado como enviado, erro é propagado pro caller.
- Implementa. Commit do Bloco 5.

### Bloco 6 — rotas da API

**Tarefa 16: `POST /tasks/:taskId/followup-suggestion`**
- Teste de rota: gera sugestão (chama o service do Bloco 4), incrementa
  contador em regeneração, 429 ao estourar `task_followup_max_regenerations`,
  403 se a tarefa não é da organização do usuário (mesmo padrão de
  `belongsToOrganization`/membership das rotas existentes).
- Implementa em `routes/tasks/index.ts`.

**Tarefa 17: `POST /tasks/:taskId/send-followup`**
- Teste de rota: 200 com a tarefa concluída no caminho feliz; 400 com o
  motivo do throttle; 400 se a tarefa não é elegível; 403 fora da
  organização; feature inteira 404/403 se `task_followup_enabled` está
  desligada na organização.
- Implementa.

**Tarefa 18: `GET /organizations/:id/followups/metrics`**
- Teste: agrega corretamente `total`, `original`, `edited` num período; taxa
  de resposta 24h/72h calculada sobre os envios do período (conta quantos
  têm mensagem `role=contact` depois de `sent_at` dentro da janela).
- Implementa. Commit do Bloco 6.

### Bloco 7 — painel (apps/web)

**Tarefa 19: bloco "Enviar follow-up" no `task-detail-panel.tsx`**
- Sem teste automatizado (o painel não tem suíte de componente hoje, mesmo
  padrão da Fase 2) — verificação manual via `pnpm build` + Playground/preview
  se possível. Implementa: visibilidade condicional, textarea editável,
  "Gerar outra" com contador restante, confirmação de envio, estado de
  erro com "tentar de novo".

**Tarefa 20: botão "Enviar" no card "Hoje"**
- Implementa em `app/(dashboard)/page.tsx`: abre o `task-detail-panel.tsx`
  pra aquela tarefa (D6).

**Tarefa 21: card de configurações**
- Implementa em `settings/page.tsx`: toggle mestre + intervalo mínimo +
  limite diário + limite de regenerações + toggle de takeover-on-send,
  mesmo padrão dos cards de Fase 2 (escreve direto no Supabase do browser).
- `pnpm build` do `apps/web` limpo. Commit do Bloco 7.

### Bloco 8 — fechamento

**Tarefa 22: suíte completa + typecheck do monorepo**
- `pnpm turbo typecheck test` — verde (só a falha pré-existente e não
  relacionada de `costs/index.test.ts`).

**Tarefa 23: atualizar `docs/plano-handoff.md`**
- Seção PROGRESSO com o resumo do que foi feito, igual às Fases 1/2.

## Deploy e ativação (a preencher ao final da implementação)

Vou escrever o passo a passo completo (migration → merge → deploy → ordem
de ativação das flags) depois que o código estiver pronto e testado,
seguindo o mesmo formato usado nas Fases 1 e 2.
