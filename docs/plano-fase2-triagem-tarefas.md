# Plano — Fase 2: Triagem de Tarefas

> Branch: `feat/fase2-triagem-tarefas` (criada a partir da `main`, commit `f30c033`).
> Este documento é o PLANO para aprovação (migrations, arquivos, decisões em aberto), conforme a regra de trabalho do projeto. Nada foi codado ainda.
> Spec base: `docs/plano-handoff.md` (Fase 2, itens 1-4) + ajustes pedidos nesta rodada (itens 1, 5, 6) + achados de `docs/diagnostico-fase0.md`.

---

## 0. Recapitulando o que o diagnóstico mudou

- Só **2,2%** das tarefas têm `opportunity_id` — a maioria da dedup hoje já acontece por `contato+tipo`, não por oportunidade (`getOpenTaskByContactAndType`).
- **601 contatos** geraram 1.384 tarefas no mês (2,3 em média, até 11 para um contato só) — confirma que a visão "Hoje" tem material de sobra para priorizar.
- **`libera_cred/plan_term_presented`** é o maior gargalo: 137 oportunidades paradas (quase 1 em cada 3 abertas), estágio mais barato de destravar.
- 68% das oportunidades abertas estão paradas entre 7 e 30 dias — nenhuma passa de 60 dias (funil ainda recente).

## 1. Vínculo tarefa ↔ oportunidade

**(a) Vínculo automático em tarefas novas.** Regra proposta: quando `createTaskWithDedup` for chamado sem `opportunity_id` explícito, buscar as oportunidades **abertas** do contato (`getOpenOpportunitiesByContact`, já existe) e:
- exatamente 1 aberta → vincula automaticamente;
- 0 ou 2+ abertas → não vincula (mesmo critério de "ambíguo → não arrisca" já usado em `decideFollowupGate`/`stale-conversation-followup.ts`).

Isso **não** tenta casar `type` da tarefa com `operation` da oportunidade (ex.: `financing_followup` → `financing`) — ver Decisão D1 abaixo, é o ponto menos óbvio deste item.

**(b) Backfill das tarefas abertas atuais.** Rodei a contagem real (somente leitura, via REST, sem expor dado pessoal) para a mesma regra do item (a):

| Grupo | Qtde |
|---|---|
| Tarefas abertas com `opportunity_id` nulo (hoje, ao vivo — já mudou um pouco desde o snapshot de `diagnostico-fase0.md`, que era de mais cedo no mesmo dia) | **214** |
| → contato com **0** oportunidades abertas (não dá pra vincular) | 154 |
| → contato com **exatamente 1** oportunidade aberta (vinculável) | **60** |
| → contato com **2+** oportunidades abertas (ambíguo, não vincula) | 0 |

Dos 60 vinculáveis, por tipo: `stalled_negotiation` 55, `customer_unresponsive` 3, `scheduled_callback` 2. Nenhuma das 60 é `financing_followup`/`consortium_followup`/`vehicle_followup` — quem tem oportunidade aberta hoje e tarefa em aberto é, na prática, gerado pelo próprio worker de stale-conversation, não pelas tarefas "manuais" de funil.

Proposta de execução do backfill: script novo (`packages/database/scripts/backfill-task-opportunity-links.ts`), modo `--dry-run` (padrão, só imprime as contagens acima) e `--apply` (roda o UPDATE só nos 60 casos exatamente-1, em uma transação, e grava 1 `task_events` por tarefa tocada com `event_type: "opportunity_auto_linked"`). Você roda o `--apply` manualmente, como fez com as migrations 00027/00028 na Fase 1 — nada disso entra em job automático.

**(c) Sem oportunidade → consolidar por contato+tipo (como hoje).** Ver Decisão D1: como tarefa não guarda "operação" própria, não dá pra consolidar por "contato+tipo de operação" sem inventar um mapeamento tipo→operação que cobre só 3 dos 14 tipos. Proposta: manter a chave atual (`contact_id, type`) para tarefas sem oportunidade — já é o comportamento de produção hoje, então "sem oportunidade" simplesmente não muda de regra.

## 2. Consolidação — no máximo 1 tarefa aberta por oportunidade [DECIDIDO — D2]

**Ajuste aprovado (substitui a proposta original de "sobrescrever"):** a tarefa consolidada guarda uma **lista de pendências abertas** (`tasks.consolidated_pendencies`, jsonb — ver migration 00029) em vez de perder a pendência anterior. O `type`/`title`/`description`/`priority`/`due_date` visíveis da tarefa sempre refletem a pendência de **maior prioridade** da lista (não a mais recente) — se `awaiting_customer_cpf` estiver na lista e chegar uma pendência `normal`, o CPF continua sendo a pendência "principal" e o encerramento automático do item 3 continua funcionando nela.

Estrutura de cada item da lista (`TaskPendency`, `packages/shared/src/types/task.ts`):
```ts
export interface TaskPendency {
  type: TaskType;
  description: string;
  reason: string | null;
  priority: TaskPriority;
  due_date: string;
  due_time: string | null;
  added_at: string;
  added_by_type: TaskCreatedByType;
  added_by_id: string | null;
}
```

Funções puras novas em `packages/shared/src/task-consolidation.ts`:
- `upsertPendency(pendencies, next)` — mesmo `type` já na lista → atualiza esse item; senão adiciona.
- `removePendencyByType(pendencies, type)` — tira um item (usado quando uma pendência é resolvida).
- `pickPrimaryPendency(pendencies)` — maior prioridade (`urgent`>`high`>`normal`>`low`), empate por `due_date` mais próxima, empate por `added_at` mais antigo.
- `earliestDueDate(pendencies)` — `due_date` da tarefa sempre é a mais próxima entre as pendências abertas, não só a da principal.
- `buildConsolidatedDescription(pendencies)` — descrição principal + lista do que mais está em aberto.

`createTaskWithDedup` (quando `opportunity_id` resolvido — explícito ou auto-linkado pelo item 1a — **e** `task_consolidation_by_opportunity_enabled` ligada): busca task aberto por `(opportunity_id)` sozinho (`getOpenTaskByOpportunity`, novo, ignora `type`). Se existir, chama `upsertPendency` na lista, recalcula principal, atualiza a tarefa e grava `task_events` (`event_type: "consolidated_pendency_added"`, note dizendo se a pendência "principal" visível mudou). Se não existir, cria a tarefa normalmente com `consolidated_pendencies` já semeada com o próprio item (`[pendencyAtual]`) — assim ela já nasce pronta pra crescer.

Quando uma pendência é **resolvida** (usado pelo item 3): `resolveAwaitingCustomerPendency` remove o item da lista — se sobrar mais alguma pendência, recalcula a principal e mantém a tarefa aberta (`event_type: "consolidated_pendency_resolved"`); se a lista ficar vazia, completa a tarefa de verdade (`completeTask`, evento `completed` padrão). Isso vale tanto com a flag de consolidação ligada (lista com vários itens) quanto desligada (lista sempre com no máximo 1 item, comportamento idêntico ao de hoje).

Tarefas sem `opportunity_id` continuam consolidando por `(contact_id, type)`, sem mudança (item 1c) — a lista de pendências não se aplica a elas (fica com o único item de sempre).

## 3. Encerramento automático de "aguardando cliente" [DECIDIDO — D3]

**Escopo aprovado:** só `awaiting_customer_cpf` e `awaiting_customer_data` (sinal estrutural no banco). `awaiting_customer_decision` fica de fora — fecha manual, como hoje. Campos que contam como "dado do cliente" para `awaiting_customer_data`: `birth_date`, `has_driver_license`, `driver_license_category`, `product_model`, `down_payment_amount`, `term_months`.

**Critério de "resolvida" (ajuste aprovado, mais rígido que a proposta original):** os dois precisam ser verdadeiros —
1. o campo relevante foi preenchido **depois** de `tasks.created_at` (via `conversation_qualification_events.created_at`, como já proposto); **e**
2. existe **mensagem do cliente** (`messages.role = 'contact'`) com `created_at` depois de `tasks.created_at` — reaproveita `getLastContactMessage` (já existe, usado em `stale-conversation-followup.ts`), só comparando o timestamp.

Isso evita o caso em que a própria IA (ou um humano) preenche o campo sem o cliente ter mandado nada novo (ex.: correção manual de cadastro) — só fecha quando o cliente realmente voltou a falar.

Gancho de execução: dentro de `packages/agent-runtime/src/tools/update-conversation-qualification.ts`, logo após `upsertConversationQualification` — se os campos que mudaram resolvem algum task/pendência aberta `awaiting_customer_cpf`/`awaiting_customer_data` do contato (busca tanto em `task.type` quanto dentro de `task.consolidated_pendencies`, via `findOpenTaskWithPendencyType`, novo) **e** o critério acima é satisfeito, chama `resolveAwaitingCustomerPendency` (item 2). Mesmo padrão de try/catch best-effort já usado nesse arquivo (nunca bloqueia a resposta ao cliente).

## 4. Score de prioridade + visão "Hoje" [DECIDIDO — D4: pesos aprovados como ponto de partida; "Hoje" é por organização inteira]

Pesos ficam em `DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS`, uma constante única em `packages/shared/src/constants.ts`, fácil de ajustar sem mexer na lógica.

Função pura nova em `packages/shared` (arquivo novo `src/task-priority-score.ts`, mantendo `task-helpers.ts` focado no que já tem). Entrada plana (sem I/O):

```ts
export interface TaskPriorityScoreInput {
  priority: TaskPriority;           // task.priority
  dueDateBucket: "overdue" | "today" | "upcoming"; // via resolveTaskBucket já existente
  opportunityValue: number | null;  // max(credit_amount, sale_amount, bid_amount) da oportunidade ligada, ou null
  stagePosition: number | null;     // índice do estágio no funil (0 = interest_received) / null se sem oportunidade
  stageCount: number | null;        // tamanho do funil daquela operação
  daysStalled: number | null;       // dias desde last_progress_at (fallback last_interaction_at/created_at)
  waitingOn: WaitingOn | null;
  waitingOnUntil: string | null;
  qualificationUrgency: "immediate" | "this_week" | "flexible" | null;
  hasUnansweredHandoff: boolean;    // conversa da tarefa está em handoff sem resposta (Fase 1)
}
```

Fórmula proposta (pontos somados — **peso é a parte que preciso que você valide**, D4):

| Componente | Regra | Pontos |
|---|---|---|
| Prioridade da tarefa | `urgent` / `high` / `normal` / `low` | +20 / +10 / 0 / −5 |
| Vencimento | atrasada / hoje / futura | +15 / +8 / 0 |
| Valor da oportunidade | `min(valor / 50.000, 1) × 20` (sem oportunidade = 0) | 0–20 |
| Estágio do funil | `(posição / (nº_estágios−1)) × 15` (sem oportunidade = 0) | 0–15 |
| Dias parado | `min(dias, 30) / 30 × 20` | 0–20 |
| `waiting_on` | cliente/nulo +5 · equipe/banco-administradora +15 (ação nossa, precisa aparecer) · data combinada ainda não vencida −15 (suprime) · data combinada já vencida +15 | −15 a +15 |
| Urgência da qualificação | `immediate` +15 · `this_week` +8 · `flexible`/nula 0 | 0–15 |
| Handoff sem resposta na conversa | +25 | 0 ou 25 |

Range aproximado: −20 a +130. Empate: score desc → `due_date` asc → `created_at` asc.

**Por que o estágio não usa `libera_cred/plan_term_presented` como caso especial hardcoded:** o score usa "posição no funil" de forma genérica (estágio mais avançado = mais pontos), não amarra pontos a uma operação específica — o gargalo de hoje pode não ser o de amanhã. O item 5 (abaixo) é o lugar certo para uma ação permanente e específica nesse estágio; o score fica reutilizável. Com os pesos acima, uma amostra rápida das 137 `plan_term_presented` (estágio avançado do funil libera_cred, tipicamente já paradas 7-30 dias) já tende a subir bastante mesmo sem regra hardcoded — mas vale eu confirmar isso com dado real antes de fechar, depois que os pesos estiverem validados.

**Visão "Hoje":** endpoint novo (ou endpoint existente estendido) `GET /organizations/:id/dashboard/today` retornando as 10 tarefas abertas de maior score, com dados já resolvidos (nome do contato, tipo, motivo). Componente novo `apps/web/src/components/dashboard/today-priority-list.tsx`, plugado em `apps/web/src/app/(dashboard)/page.tsx`, com 3 ações diretas por item: **abrir conversa** (`Link` para `/inbox?id=`, já existe), **concluir** (`POST /tasks/:taskId/complete`, endpoint já existe), **adiar** (`POST /tasks/:taskId/reschedule`, endpoint já existe — só falta UI compacta, tipo "+1 dia"/"+3 dias"). Nenhum endpoint de ação novo é necessário, só o de leitura do score.

## 5. Follow-up do LiberaCred em "plano e prazo apresentados" (137 paradas) [DECIDIDO — D5: Opção B]

Checagem nova (`apps/worker/src/workers/libera-cred-resumption.ts`, chamada a partir do tick de 15 min de `stale-conversation-followup.ts`) para oportunidades `operation = 'libera_cred'`, `stage = 'plan_term_presented'`, `status = 'open'`, `waiting_on` não for `team`/`bank_or_admin`.

**(a) Mensagem sugerida com valores reais, nunca estimados, com data da tabela.**
- A checagem busca na base de conhecimento do agente (mesmo mecanismo do `search-knowledge`, mas chamado direto — `searchKnowledgeChunks`/`@aula-agente/database` — não como tool) por conteúdo relacionado a "tabela de planos e prazos LiberaCred".
- Chama `generateObject` (Vercel AI SDK, já usado no projeto) com schema `{ message: string | null, table_date_found_in_text: string | null, table_found: boolean }` e instrução explícita: só usar valores literais dos trechos recuperados, nunca calcular/estimar; extrair a data de vigência só se estiver escrita no texto.
- Função pura nova `isLiberaCredTableOutdated(tableDateISO, documentUpdatedAtISO, todayISO, maxAgeDays)` (`packages/shared`) decide se a tabela está desatualizada — usa a data extraída do texto quando existe, senão cai para `knowledge_documents.updated_at` do documento fonte; sem nenhuma das duas, trata como desatualizada (conservador).
- Se `table_found` for falso ou a tabela estiver desatualizada: a tarefa **não** traz uma mensagem pronta com valores — a descrição vira um aviso ("⚠️ Tabela de planos LiberaCred não encontrada/desatualizada — confirme os valores manualmente antes de enviar"), nunca inventa número. Configurável: `libera_cred_table_max_age_days` (padrão 30).

**(b) Cadência com fim.**
- **Dia 2** parado no estágio (`days_stalled >= 2`, mesmo cálculo do score do item 4) sem tarefa `libera_cred_resumption` aberta ainda → cria a tarefa (prioridade conforme o score), evento `libera_cred_resumption_created`.
- **Dia 7** parado, tarefa ainda aberta → escala: prioridade sobe pra `urgent`, mensagem é regerada (tabela pode ter mudado), evento `libera_cred_resumption_escalated`, nota "2ª tentativa".
- **Além de 7 dias**, ainda parado → evento `libera_cred_resumption_suggest_lost` (uma vez só) e a descrição da tarefa passa a incluir "Cliente sem retorno há mais de 7 dias nesta etapa — considere marcar como perdida (motivo: `sem_resposta`, catálogo já definido na Fase 3)." **Não marca como perdida automaticamente** — só sugere; quem decide é a atendente.
- Se a oportunidade avançar de estágio (progresso real) enquanto a tarefa está aberta, ela é completada automaticamente (pendência resolvida pelo próprio funil andar).

**(c) Limite diário na visão "Hoje", configurável (padrão 10).**
- A checagem não cria mais que `libera_cred_resumption_daily_limit` (padrão 10) tarefas **novas** por dia por organização — conta via `task_events` do tipo `libera_cred_resumption_created` criados hoje (`countTaskEventsSince`). Escalonamentos (dia 7) de tarefas já existentes não contam nesse limite, só criações novas.
- Entre as 137 candidatas paradas, prioriza pelo mesmo score do item 4 (maior score primeiro) — quem está mais parado/vale mais entra primeiro na fila de 10/dia.

## 6. Feature flags — tudo desligado por padrão [DECIDIDO — D6: "Hoje" sem flag própria]

Seguindo o padrão da Fase 1 (chaves em `organizations.settings`, sem migration — é `jsonb`):

| Chave | Controla | Default |
|---|---|---|
| `task_auto_link_opportunity_enabled` | item 1(a) — vínculo automático em tarefas novas | `false` |
| `task_consolidation_by_opportunity_enabled` | item 2 — 1 tarefa por oportunidade, tipo qualquer, com lista de pendências | `false` |
| `task_auto_close_awaiting_customer_enabled` | item 3 — encerramento automático | `false` |
| `libera_cred_resumption_enabled` | item 5 — checagem/tarefa de retomada | `false` |
| `libera_cred_resumption_window_days` | item 5(a) — só considera quem interagiu nos últimos N dias | `15` |
| `libera_cred_table_max_age_days` | item 5(a) — idade máxima da tabela antes de considerar desatualizada | `30` |
| `libera_cred_resumption_daily_limit` | item 5(c) — máx. de tarefas novas de retomada por dia | `10` |
| `task_priority_score_weights` | item 4 — override opcional dos pesos (ausente = `DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS`) | ausente |

A visão "Hoje" (item 4) é só leitura — não manda mensagem, não muda dado — **sem chave própria**, conforme D6. O backfill (item 1b) é ação única sob comando seu, não um automatismo recorrente — não precisa de chave.

---

## Migrations

**Uma migration nova, reversível** — `00029_task_consolidated_pendencies.sql`:

```sql
ALTER TABLE tasks
  ADD COLUMN consolidated_pendencies jsonb NOT NULL DEFAULT '[]'::jsonb;
```

Reversão: `ALTER TABLE tasks DROP COLUMN consolidated_pendencies;` (não referenciada por FK, sem risco de cascata).

Fora isso, nada mais precisa de migration:
- `tasks.type` e `task_events.event_type` são `text` livre (sem `CHECK`/enum no banco) — novo tipo de tarefa e novo tipo de evento são só constantes TypeScript (`packages/shared/src/constants.ts`).
- `tasks.opportunity_id` já existe (desde `00010_tasks.sql`).
- `organizations.settings` é `jsonb` — novas chaves não pedem migration.
- O score (item 4) é calculado na hora, nada persiste.

## Arquivos a criar/alterar

**supabase/migrations**
- `00029_task_consolidated_pendencies.sql` **(novo)**.

**packages/shared**
- `src/constants.ts` — `libera_cred_resumption` em `TASK_TYPES`/`TASK_TYPE_LABELS`; `DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS`; `DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG` (janela de dias, idade máx. da tabela, limite diário).
- `src/types/task.ts` — `TaskPendency`; `Task.consolidated_pendencies: TaskPendency[]`; estende `TaskEventType`: `opportunity_auto_linked`, `consolidated_pendency_added`, `consolidated_pendency_resolved`, `libera_cred_resumption_created`, `libera_cred_resumption_escalated`, `libera_cred_resumption_suggest_lost`.
- `src/types/organization.ts` — novas chaves opcionais em `OrganizationSettings` (tabela da seção 6).
- `src/task-consolidation.ts` **(novo)** — `upsertPendency`, `removePendencyByType`, `pickPrimaryPendency`, `earliestDueDate`, `buildConsolidatedDescription`.
- `src/task-priority-score.ts` **(novo)** — `computeTaskPriorityScore`.
- `src/libera-cred-resumption-helpers.ts` **(novo)** — `isLiberaCredTableOutdated`, `resolveLiberaCredCadenceStage` (dia 2 / dia 7 / sugerir perdida, pura).
- `src/task-helpers.ts` — `isAwaitingCustomerResolved(type, changedFields)`, `resolveOpportunityAutoLink(openOpportunityIds)`.
- Testes: `task-consolidation.test.ts`, `task-priority-score.test.ts`, `libera-cred-resumption-helpers.test.ts` (novos), extensão de `task-helpers.test.ts`.

**packages/database**
- `src/queries/tasks.ts` — `createTaskWithDedup` ganha auto-link (1a) e consolidação (2), ambos atrás das flags (lidas via `getOrganizationById`, best-effort); `getOpenTaskByOpportunity` (novo, sem filtro de tipo); `getOpenTasksByContact` (novo); `findOpenTaskWithPendencyType` (novo, usado pelo item 3); `resolveAwaitingCustomerPendency` (novo); `countTaskEventsSince` (novo); `getOpenTasksWithScoreInputs` (novo, join para o item 4).
- `src/queries/opportunities.ts` — `getOpenLiberaCredPlanPresentedOpportunities` (novo, para a checagem do item 5).
- `src/queries/knowledge.ts` — `getKnowledgeChunksWithDocumentMeta` (novo, chunk + título/`updated_at` do documento fonte, para o item 5a).
- `scripts/backfill-task-opportunity-links.ts` **(novo)** — `--dry-run` (padrão) / `--apply`.
- Testes: `tasks.test.ts` (extensão), `opportunities.test.ts` (extensão).

**packages/agent-runtime**
- `src/tools/update-conversation-qualification.ts` — hook do item 3 após `upsertConversationQualification`.
- Testes: extensão de `update-conversation-qualification.test.ts` (ou novo, se não existir).

**apps/worker**
- `src/workers/libera-cred-resumption.ts` **(novo)** — checagem chamada a partir do tick de `stale-conversation-followup.ts` (que ganha só a chamada, não a lógica).
- Testes: `libera-cred-resumption.test.ts` (novo).

**apps/api**
- `src/routes/dashboard/index.ts` — novo endpoint `GET /organizations/:organizationId/dashboard/today` para o item 4.
- `src/routes/organizations/index.ts` (ou onde `PATCH` de settings já existir) — Zod schema aceita as novas chaves da seção 6.
- Testes: extensão de `dashboard.test.ts`.

**apps/web**
- `src/app/(dashboard)/page.tsx` — seção "Hoje".
- `src/components/dashboard/today-priority-list.tsx` **(novo)**.
- Página de Configurações — toggles das novas flags.

## Testes previstos

- TDD em todas as funções puras novas, seguindo o padrão de `task-helpers.test.ts`/`greeting-filter.test.ts`.
- Testes de integração em `packages/database/src/queries/tasks.test.ts` para auto-link, consolidação (lista de pendências crescendo/encolhendo) e resolução de pendência.
- Teste do hook de encerramento automático: campo preenchido sem mensagem nova do cliente → não fecha; campo preenchido com mensagem nova do cliente → fecha/remove pendência; flag desligada → não faz nada.
- Teste de integração do worker de LiberaCred: cadência dia 2/dia 7/sugerir perdida; limite diário realmente para de criar tarefas novas; tabela desatualizada/não encontrada nunca gera mensagem com valor.

---

## Decisões (todas aprovadas em 2026-09-28)

- **D1 — aprovado como proposto.** Vínculo automático por "exatamente 1 oportunidade aberta do contato".
- **D2 — ajustado e aprovado:** tarefa consolidada guarda lista de pendências (`consolidated_pendencies`), mantém o tipo de **maior prioridade** como principal, pendência resolvida sai da lista com evento próprio; tarefa só fecha quando a lista esvaziar. Motivo do ajuste: sobrescrever o tipo quebraria o encerramento automático do item 3 se `awaiting_customer_cpf` fosse substituída. Detalhe implementado na seção 2.
- **D3 — aprovado o escopo** (`awaiting_customer_cpf`/`awaiting_customer_data`), com critério mais rígido: só fecha se o campo foi preenchido **e** existe mensagem do cliente depois da criação da tarefa. Detalhe implementado na seção 3.
- **D4 — aprovado como ponto de partida**, pesos em constante única; "Hoje" por organização inteira (não por atendente).
- **D5 — Opção B aprovada**, com: (a) mensagem só com valores reais da tabela vigente, citando a data, nunca estimados — sinaliza se desatualizada; (b) cadência com fim (dia 2 cria, dia 7 escala, depois disso sugere perdida sem marcar sozinho); (c) limite diário configurável (padrão 10) na fila de criação, priorizado pelo score. Detalhe implementado na seção 5.
- **D6 — aprovado sem flag própria** para a visão "Hoje".
- **D7 — aprovado como proposto** — backfill só nas 214 tarefas abertas agora (60 vinculáveis).

---

## Plano tarefa a tarefa (TDD, commits sem push)

> Executando na branch `feat/fase2-triagem-tarefas`. Cada tarefa: teste(s) primeiro, implementação mínima, `vitest run` no pacote afetado, commit. Flags todas `false` por padrão — nenhuma muda comportamento em produção até serem ligadas manualmente em Configurações.

1. **Migration 00029** — `consolidated_pendencies` em `tasks`. Sem teste automatizado (é DDL); valida rodando `supabase db push` localmente se houver banco de dev, senão inspeção visual + aplicação em produção fica para o passo de deploy no final.
2. **`packages/shared` — tipos e constantes** — `TaskPendency`, `Task.consolidated_pendencies`, novos `TaskEventType`, novo `TASK_TYPES` (`libera_cred_resumption`), novas chaves de `OrganizationSettings`, `DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS`, `DEFAULT_LIBERA_CRED_RESUMPTION_CONFIG`. Sem teste próprio (tipos/constantes), mas `tsc --noEmit` precisa passar.
3. **`task-consolidation.ts` (TDD)** — `upsertPendency`, `removePendencyByType`, `pickPrimaryPendency`, `earliestDueDate`, `buildConsolidatedDescription`. Testes cobrindo: lista vazia, tipo repetido atualiza em vez de duplicar, empate de prioridade por due_date, lista esvaziando.
4. **`task-priority-score.ts` (TDD)** — `computeTaskPriorityScore` com a tabela de pesos da seção 4. Testes por componente (cada fator isolado) + um caso combinado.
5. **`libera-cred-resumption-helpers.ts` (TDD)** — `isLiberaCredTableOutdated`, `resolveLiberaCredCadenceStage` (dia<2 → none, dia 2-6 → create, dia 7+ primeira vez → escalate, depois → suggest_lost, já sugerido → none).
6. **`task-helpers.ts` — novas funções (TDD)** — `isAwaitingCustomerResolved`, `resolveOpportunityAutoLink`.
7. **`packages/database/src/queries/tasks.ts` — funções de leitura novas (TDD)** — `getOpenTaskByOpportunity`, `getOpenTasksByContact`, `findOpenTaskWithPendencyType`, `countTaskEventsSince`, `getOpenTasksWithScoreInputs`.
8. **`createTaskWithDedup` — auto-link (item 1a, TDD)** — flag desligada → comportamento idêntico a hoje; flag ligada + 1 oportunidade aberta → vincula; flag ligada + 0 ou 2+ → não vincula.
9. **`createTaskWithDedup` — consolidação por pendências (item 2, TDD)** — flag desligada → dedup por tipo como hoje; flag ligada + task existente de outro tipo → cria/atualiza lista, recalcula principal, evento `consolidated_pendency_added`.
10. **`resolveAwaitingCustomerPendency` (TDD)** — lista com >1 item → remove e mantém aberta; lista com 1 item → completa a tarefa.
11. **`opportunities.ts` — `getOpenLiberaCredPlanPresentedOpportunities` (TDD)**.
12. **`knowledge.ts` — `getKnowledgeChunksWithDocumentMeta` (TDD)**.
13. **`packages/agent-runtime` — hook do item 3 (TDD)** — usa `getLastContactMessage` + `findOpenTaskWithPendencyType` + `resolveAwaitingCustomerPendency`; nunca lança (best-effort).
14. **`apps/worker/src/workers/libera-cred-resumption.ts` (TDD)** — cadência dia 2/7/sugerir perdida, limite diário, geração de mensagem via `generateObject` com tabela do knowledge base, gate por `waiting_on`. Chamado a partir do tick existente em `stale-conversation-followup.ts`.
15. **`apps/api` — endpoint `/dashboard/today` (TDD)** — usa `getOpenTasksWithScoreInputs` + `computeTaskPriorityScore`, retorna top 10.
16. **`apps/api` — settings aceita as novas chaves (TDD)**.
17. **`apps/web` — seção "Hoje" + toggles de Configurações** — sem TDD formal (UI), verificação manual via preview.
18. **Suítes completas** (`shared`/`database`/`agent-runtime`/`api`/`worker`) — todas verdes antes do commit final.
19. **Backfill** — rodar `--dry-run` de novo (contagem pode ter mudado desde a captura da seção 1), mostrar pra você, só rodar `--apply` com sua aprovação explícita nessa hora.
20. **Runbook de deploy e ativação** — anexado ao final deste documento depois que tudo estiver implementado e testado.
