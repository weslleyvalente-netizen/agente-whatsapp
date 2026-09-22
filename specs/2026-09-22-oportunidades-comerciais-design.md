# Oportunidades Comerciais Nativas — Design

**Data:** 2026-09-22
**Status:** Aprovado, seguindo para as fases de implementação

## Contexto

O agente de WhatsApp (`aula-agente`) já tem uma boa parte da infraestrutura
comercial construída — só que espalhada entre `contact_id`/`conversation_id`,
sem uma entidade "negócio" própria. O CRM standalone (`assistente-mt`) tem
essa entidade (`deals`, com estágio), mas é um funil genérico único,
desconectado de tudo que o agente já automatiza (tarefas, qualificação,
follow-up, expiração de atendimento humano). Portar a tela do CRM como estava
planejado anteriormente (`specs/2026-09-22-crm-integration-design.md`)
significaria construir em cima da tabela errada — decisão revertida nesta
spec: **a Oportunidade nasce nativa no `aula-agente`**, vinculada a
`wa_contacts`/`conversations`/`tasks`/`conversation_qualifications`. O CRM
standalone não é tocado nem aposentado agora — só inventariado (seção 8).

Objetivo: acompanhar cada negociação até o resultado, sem perder cliente da
fila quando uma tarefa é concluída ou o atendimento humano expira — sem
duplicar nenhum mecanismo que já existe e funciona.

## 1. Modelo de dados

### `opportunities` (nova)

```sql
CREATE TABLE opportunities (
  id                    uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id            uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,

  -- Funil atual (seção 2)
  operation             text NOT NULL CHECK (operation IN
                           ('vehicle_sale', 'consortium', 'financing', 'libera_cred', 'contemplated_letter')),
  stage                 text NOT NULL, -- validado na aplicação contra FUNNEL_STAGES[operation], mesmo padrão de tasks.type
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),

  -- Produto (campo, não funil — pode mudar sem trocar de operação)
  product               text,  -- 'car' | 'motorcycle' | 'real_estate' | 'e_bike' -- lista fechada em packages/shared
  product_model         text,  -- texto livre, ex. "FZ15"

  -- Histórico de modalidade (seção 4)
  initial_operation     text NOT NULL, -- primeira operação desta oportunidade, nunca muda depois de criada

  -- Financeiro — mesmos nomes de conversation_qualifications, movidos pra cá (seção 3)
  sale_amount              numeric,
  credit_amount             numeric,
  down_payment_amount       numeric,
  bid_amount                 numeric,
  target_installment_amount  numeric,
  term_months                integer,

  usage_purpose          text,
  urgency                text,
  main_objection         text,
  commercial_notes       text,

  owner_id               uuid REFERENCES auth.users(id) ON DELETE SET NULL, -- responsável comercial

  -- Próxima ação — cache do task comercial aberto vinculado (seção 4), nunca fonte de verdade
  next_action            text,
  next_action_due_date   date,

  -- Aguardando quem (novo — não existe em lugar nenhum hoje)
  waiting_on             text CHECK (waiting_on IN ('customer', 'team', 'bank_or_admin', 'scheduled_date')),
  waiting_on_until       date, -- só quando waiting_on = 'scheduled_date'

  -- Timestamps de atividade, separados por propósito (pedido explícito do usuário)
  last_interaction_at    timestamptz, -- qualquer mensagem na conversa vinculada
  last_progress_at       timestamptz, -- só em stage_changed | operation_changed | won | lost

  -- Resultado
  lost_reason            text,
  resume_date            date, -- adiamento — só quando status = 'lost' e é reversível

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_opportunities_org_status ON opportunities(organization_id, status);
CREATE INDEX idx_opportunities_contact ON opportunities(contact_id);
CREATE INDEX idx_opportunities_operation_stage ON opportunities(operation, stage);
CREATE INDEX idx_opportunities_owner ON opportunities(owner_id);
CREATE INDEX idx_opportunities_waiting_on ON opportunities(waiting_on) WHERE status = 'open';

CREATE TRIGGER trg_opportunities_updated_at
  BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

Por que `status` é separado de `stage`: pedido explícito do usuário
("Resultado separado da etapa: aberto, ganho ou perdido"). Uma oportunidade
pode estar `lost` na etapa `negotiation` (perdeu durante a negociação) —
`stage` registra *onde parou*, `status` registra *o que aconteceu*.

### `opportunity_events` (nova — reaproveita o padrão já existente de `task_events`/`conversation_qualification_events`, não cria mecanismo de auditoria novo)

```sql
CREATE TABLE opportunity_events (
  id                 uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id     uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  event_type         text NOT NULL CHECK (event_type IN (
                        'created', 'stage_changed', 'operation_changed',
                        'won', 'lost', 'reopened', 'owner_changed',
                        'next_action_updated', 'waiting_on_changed'
                      )),
  previous_value     jsonb, -- ex. {"stage": "qualification"} antes da mudança
  new_value          jsonb, -- ex. {"stage": "proposal_sent"}
  evidence           text NOT NULL, -- OBRIGATÓRIO em stage_changed/won/lost/operation_changed — ver seção 6
  changed_by_type    text NOT NULL CHECK (changed_by_type IN ('ai', 'human', 'system')),
  changed_by_id      uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_opportunity_events_opportunity ON opportunity_events(opportunity_id, created_at);
```

`evidence` é `NOT NULL` de propósito — é o mecanismo que garante "mudança de
etapa exige evidência registrada" (automação #2) e "ganho/perda exige
confirmação confiável" (automação #12) no nível do banco, não só como
convenção de código: **nenhum código consegue mudar `stage`/`status`/
`operation` sem escrever por que** (ex. `"Cliente confirmou proposta por
áudio"`, não `"cliente disse 'gostei'"`).

### Ajustes em tabelas existentes

```sql
ALTER TABLE tasks
  ADD COLUMN opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL;

CREATE INDEX idx_tasks_opportunity ON tasks(opportunity_id);

ALTER TABLE conversation_qualifications
  ADD COLUMN opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL;
```

**RLS** de `opportunities`/`opportunity_events`: mesmo padrão de
`conversation_qualifications` (`organization_id IN (SELECT
get_user_org_ids())`, 4 policies select/insert/update/delete) — nenhuma
policy nova a inventar.

## 2. Cinco funis, um por operação

```ts
// packages/shared/src/constants.ts
export const OPERATIONS = [
  "vehicle_sale", "consortium", "financing", "libera_cred", "contemplated_letter",
] as const;

export const FUNNEL_STAGES: Record<Operation, readonly string[]> = {
  vehicle_sale:        ["interest_received", "qualification", "proposal_sent", "negotiation", "formalization"],
  consortium:          ["interest_received", "qualification", "simulation_sent", "decision_negotiation", "membership"],
  financing:           ["interest_received", "qualification", "documentation", "bank_analysis", "conditions_approved_negotiation", "formalization"],
  libera_cred:         ["interest_received", "qualification", "plan_term_presented", "decision_objections", "membership"],
  contemplated_letter: ["interest_received", "qualification", "compatible_letter_search", "proposal_sent", "analysis_transfer"],
};
```

`stage` não tem `CHECK` no banco (5 listas diferentes tornariam isso
inviável em SQL puro) — validado no zod schema de criação/atualização,
mesmo padrão já usado por `tasks.type`. `FUNNEL_STAGE_LABELS` (mapa
slug→português) segue o mesmo molde de `TASK_TYPE_LABELS`.

### Critérios de ganho por operação (pedido explícito — nada implícito)

| Operação | Critério verificável de "ganho" |
|---|---|
| Venda de veículos/elétricos | Contrato de compra e venda assinado (ou pagamento confirmado) |
| Consórcio | Adesão confirmada pela administradora (número de cota emitido) |
| Financiamento | Contrato de financiamento assinado E veículo formalizado/entregue |
| Libera Cred | Plano aceito e assinatura/confirmação do cronograma registrada |
| Carta contemplada | Transferência da carta assinada/confirmada |

Cada critério exige uma linha em `opportunity_events` (`event_type: 'won'`)
com `evidence` descrevendo o documento/confirmação — nunca inferido de frase
solta ("gostei", "vou fazer", "obrigado" **não** disparam won/lost sozinhas,
conforme automação #12).

## 3. Contato vs. Oportunidade — o que sai de `conversation_qualifications`

Hoje `conversation_qualifications` mistura os dois níveis. Correção:

| Campo | Fica em | Motivo |
|---|---|---|
| `city`, `cpf_encrypted`, `cpf_hash`, `birth_date`, `has_driver_license`, `driver_license_category`, `attendance_type` | `conversation_qualifications` (contato/atendimento) | Não muda por negócio — é a mesma pessoa |
| `product_interest` (renomeado para `product`, categorizado — ver seção 2), `product_model`, `usage_purpose`, `urgency`, `sale_amount`, `credit_amount`, `down_payment_amount`, `bid_amount`, `target_installment_amount`, `term_months`, `commercial_notes`, `next_action` | **movem para `opportunities`** | Pertencem ao negócio, não à pessoa — um contato com 2 negócios precisa de 2 conjuntos desses valores, não 1 |
| — (novo, não existia em `conversation_qualifications`) | `main_objection` fica em `opportunities` | Pedido explícito do usuário ("Urgência e principal objeção") — distinto de `commercial_notes`, que continua sendo anotação livre |

`conversation_qualifications.opportunity_id` (novo, seção 1) marca qual
oportunidade está sendo discutida na conversa **agora** — é o que impede uma
negociação sobrescrever a outra quando o mesmo contato tem duas conversas ou
retoma a mesma conversa sobre um assunto diferente: a IA escreve os campos
financeiros na oportunidade apontada por esse campo, nunca direto na
qualificação.

## 4. Vínculo de tarefas e deduplicação revisada

- Tarefa **comercial** (qualquer tipo em `OPPORTUNITY_SIGNAL_TASK_TYPES`):
  ganha `opportunity_id` obrigatório, além de `contact_id`/`conversation_id`
  que já tinha.
- Tarefa de **suporte** (`other`, e tipos novos de pós-venda — seção 9):
  continua só com `contact_id`/`conversation_id`, `opportunity_id` fica
  `NULL`.
- **Dedup revisada** (`createTaskWithDedup`): a chave de "tarefa semelhante
  já aberta" passa a ser `(opportunity_id, type)` quando `opportunity_id`
  está presente, e continua `(contact_id, type)` só para tarefas sem
  oportunidade. Isso resolve diretamente o caso que o usuário apontou: um
  contato com 2 negócios abertos pode ter 2 tarefas `run_quote` — uma por
  oportunidade — sem a segunda ser tratada como duplicata da primeira.
- **`next_action`/`next_action_due_date` da oportunidade são um cache, não
  uma segunda fonte de verdade**: toda vez que uma tarefa comercial vinculada
  é criada, reagendada ou concluída, `opportunities.next_action`/
  `next_action_due_date` são atualizados junto (mesma transação/chamada de
  service), copiando `title`/`due_date` da tarefa aberta mais próxima
  daquela oportunidade. Se não houver tarefa aberta, os dois campos ficam
  `NULL` — e é exatamente esse estado (`status = 'open'` sem
  `next_action_due_date`) que alimenta a view "Oportunidades sem responsável
  ou próxima ação" (seção 7).

## 5. Continuidade — nada some da fila

Regra explícita, valendo para todo o design: **nenhum evento de tarefa ou de
atendimento humano muda `opportunities.status` sozinho.**

- Concluir tarefa (`completeTask`) → se a oportunidade continuar `open`, o
  service passa a **exigir** que a chamada informe a próxima ação (novo
  parâmetro opcional `next_action`/`next_action_due_date` em
  `completeTask`) **ou** deixe explicitamente `next_action: null` — a UI
  (seção "Fases") força essa escolha num diálogo, em vez de deixar a
  oportunidade órfã silenciosamente.
- Atendimento humano expirar (`takeover-timeout.ts`) ou `ai_disabled` mudar
  → não toca em `opportunities` nem em `tasks` — esses dois mecanismos
  continuam controlando só quem responde no WhatsApp, nunca o estado
  comercial. Se a oportunidade ficar sem tarefa aberta depois da expiração,
  ela aparece na view "Oportunidades sem responsável ou próxima ação"
  (visível, não escalada silenciosamente) — não desaparece, exatamente como
  pedido.
- Resposta humana solta ("ok", "obrigado") **não** conclui todas as tarefas
  daquele contato — `completeTask` continua exigindo o `taskId` específico,
  nunca uma operação em massa por contato.

## 6. Matriz de automações

Convenção: 🟢 existe e roda em produção hoje (confirmado no código-fonte,
não só na spec) · 🟡 existe mas precisa de ajuste pontual · 🔴 não existe,
construir novo.

| # | Gatilho | Condição | Ação | Regra de interrupção | Status |
|---|---|---|---|---|---|
| 1 | Mensagem nova / webhook de lead | Contato novo ou existente; mensagem não é suporte/boleto interno | Localizar/criar `wa_contacts`; localizar oportunidade `open` do mesmo `operation` ou criar uma nova; registrar origem | Idempotente por `evolution_message_id` (já existe, `idx_messages_evolution_id` único) — reprocessar webhook não duplica | 🟡 contato/dedupe de mensagem já existe; "localizar/criar oportunidade" e o filtro "não é suporte" são novos |
| 2 | IA identifica dado explícito na conversa | Informação não repetida (campo já preenchido não é perguntado de novo) | Escreve em `opportunities` (campo financeiro/produto) via `conversation_qualifications.opportunity_id`; dúvida → não escreve, fica para revisão humana | Mudança de `stage` exige `opportunity_events` com `evidence` (seção 1, `NOT NULL` no banco) | 🟡 mecanismo de escrita existe (`conversation_qualifications`), separação contato/oportunidade e exigência de evidência são novas |
| 3 | Handoff para humano | — | Cria/atualiza tarefa comercial vinculada à oportunidade, com responsável, prazo, resumo, ação concreta | Dedup por `(opportunity_id, type)` (seção 4) | 🟡 `createTaskWithDedup` já existe; troca só a chave de dedupe |
| 4 | Cliente com pergunta pendente sem resposta | Prazo configurável, respeita horário de atendimento | Alerta o responsável | "Obrigado" isolado não gera cobrança nem apaga pendência anterior | 🟢 `stale-conversation-followup` já faz isso (`hasOpportunitySignalTask`); ajuste: também atualiza `waiting_on` da oportunidade para `'customer'` quando dispara |
| 5 | Cliente enviou documento | — | Atualiza pendência da equipe; cria/atualiza tarefa de análise | Receber CPF ≠ "ficha enviada ao banco" — são eventos distintos | 🔴 não existe detecção de "documento recebido" hoje; construir tool/gatilho novo que também seta `waiting_on = 'team'` |
| 6 | Análise (banco/administradora) retornou | — | Cria tarefa para apresentar condições ou explicar recusa | Recusa não fecha a oportunidade sozinha — só muda `stage`/`waiting_on`, humano decide alternativa | 🔴 novo — hoje não existe conceito de "análise retornou" |
| 7 | Proposta sem retorno | Sinal de oportunidade existente | Reengajamento automático da IA (até 2 tentativas) | Para em resposta, recusa, ganho, perda ou retomada agendada; nunca IA+vendedor simultâneo | 🟢 `followup_automatico` já implementado e configurável por agente; ajuste: checar `opportunities.status = 'open'` além do sinal de tarefa |
| 8 | Negociação parada (precificada) | Silêncio após valor apresentado | Cria `stalled_negotiation` | Prazo da próxima ação também conta, não só mensagem genérica | 🟢 já existe no worker ("priced deal gone quiet"); ajuste: vincular a `opportunity_id`, checar `next_action_due_date` vencido também, não só silêncio de conversa |
| 9 | Tarefa concluída | — | Registra resultado; mantém/define próxima ação se `status = 'open'` | Resposta humana não conclui todas as tarefas do contato | 🟡 `completeTask` já existe; ganha a exigência de `next_action` da seção 5 |
| 10 | Atendimento humano expira | — | Preserva responsável/oportunidade/pendências; escalar se sem resposta | Nunca some da fila | 🟢 `takeover-timeout.ts`/`ai_disabled` já existem e já não tocam em tarefas; só precisa não tocar em `opportunities` também (é o padrão, não uma mudança) |
| 11 | Retomada agendada | Data de `resume_date` chega | Gera tarefa na data — sem abordar antes | — | 🔴 novo — não existe hoje varredura de `resume_date` |
| 12 | Ganho ou perda | Evidência confiável registrada | Muda `status`; suspende follow-ups incompatíveis; mantém tarefas de pós-venda pertinentes | "Gostei"/"vou fazer"/"obrigado" não confirmam sozinhas | 🔴 novo — não existe `status` de oportunidade hoje para mudar |

Todas as automações que escrevem em `opportunities` passam pelo mesmo
service (`opportunity.service.ts`, análogo a `task.service.ts`) — é o único
lugar que sabe gravar `opportunity_events` com `evidence`, evitando 12
pontos diferentes reimplementando a mesma regra de auditoria.

## 7. Visões de trabalho

Todas são queries sobre `opportunities` (+ join pontual em `tasks`/
`conversations`), sem tabela nova:

| View | Query (resumo) |
|---|---|
| Clientes aguardando resposta | `opportunities` `status='open'` `waiting_on='customer'` |
| Ações pendentes da equipe | `tasks` `status IN ('pending','in_progress')` `opportunity_id IS NOT NULL` |
| Análises aguardando banco/administradora | `opportunities` `waiting_on='bank_or_admin'` |
| Propostas sem retorno | `opportunities` `stage IN ('proposal_sent','simulation_sent')` `status='open'` |
| Retomadas de hoje | `opportunities` `resume_date = current_date` `status='lost'` |
| Oportunidades sem responsável ou próxima ação | `opportunities` `status='open'` `(owner_id IS NULL OR next_action_due_date IS NULL)` |

## 8. CRM legado (`assistente-mt`) — levantamento, sem excluir nada agora

Por pedido explícito: **não aposentar nem apagar agora.** Passos, todos só
leitura nesta fase:

1. **Dados**: `contacts` (929 linhas, alimentadas pelo `crm-sync.ts`),
   `deals` (1 linha real — "INSS"), `profiles` (usuários do CRM),
   `activities` (histórico "Novo contato via WhatsApp" + qualquer atividade
   manual criada).
2. **Usuários**: `profiles.id` mapeia 1:1 para `auth.users.id` (mesmo
   Supabase Auth) — não há usuário exclusivo do CRM sem conta no
   `aula-agente`, confirmado ao logar com a mesma sessão salva no navegador.
3. **Dependências**: `crm-sync.ts` (`apps/api`) escreve em `contacts`/
   `activities` a cada novo `wa_contacts` — continua rodando sem mudança
   nenhuma enquanto o módulo novo não estiver validado.
4. **Migração futura (não agora)**: quando o módulo de oportunidades
   estiver validado, o único dado do CRM standalone com valor comercial real
   pra migrar é o negócio "INSS" (1 linha) — os 929 `contacts` já têm
   equivalente em `wa_contacts` (mesmo telefone), então "migrar contato" na
   prática é só confirmar que toda oportunidade nova aponta pro
   `wa_contacts` certo via telefone, não reimportar nada.
5. **Reversibilidade**: como o CRM standalone não é alterado nem desligado
   nesta fase, a reversão é trivial — não há nada a desfazer nele. A
   reversão de `opportunities` (se necessário) é dropar a tabela/coluns
   novas (seção 10) sem efeito em `contacts`/`deals`/`profiles`, que
   continuam intocados.
6. **Componentes visuais reaproveitados**: `DealKanban` (drag-and-drop com
   `@dnd-kit/core`), `AssigneeSelect` (com a correção de perfil inativo já
   desenhada em `specs/2026-09-22-crm-integration-design.md`), e o padrão de
   `Dialog` + `react-hook-form` + `zod` dos formulários — a UI de
   Oportunidades reaproveita esses padrões, só trocando a fonte de dados
   para `opportunities`/`tasks` em vez de `deals`/`profiles`.

## 9. Fases de implementação

**Fase 1 — Fundação (sem automação nova ainda)**
- Migrations: `opportunities`, `opportunity_events`, `tasks.opportunity_id`,
  `conversation_qualifications.opportunity_id`.
- `opportunity.service.ts`: criar, mudar estágio (com evidência
  obrigatória), atribuir responsável, definir próxima ação.
- Tela de Funil de vendas nova (por operação, um filtro/seletor por funil),
  reaproveitando `DealKanban` adaptado para `opportunities`/`FUNNEL_STAGES`.
- Criação/edição manual de oportunidade (formulário, reaproveitando o padrão
  de `DealForm`), com responsável e próxima ação **obrigatórios na
  criação** — cumpre a priorização pedida ("oportunidades, funis,
  responsável, próxima ação e tarefas vinculadas" primeiro).
- Vínculo manual de tarefa existente a uma oportunidade (UI).
- Dedup de tarefas revisada para `(opportunity_id, type)` quando aplicável.
- **Sem migração de dados do CRM legado, sem tocar `crm-sync.ts`.**
- **Reversão**: dropar as 2 tabelas + 2 colunas novas. Nenhum dado existente
  (`tasks`, `conversation_qualifications`, CRM legado) é alterado ou
  perdido.

**Fase 2 — Automações de entrada e evidência**
- Automação #1 (localizar/criar oportunidade na entrada do lead) e #2
  (qualificação pela IA escrevendo em `opportunities` via
  `conversation_qualifications.opportunity_id`), com o filtro de "não é
  suporte" explícito.
- Ajuste de #3 (handoff cria tarefa já vinculada à oportunidade certa).
- **Reversão**: desligar o toggle da tool nova por agente (mesmo padrão de
  `create_task`/`followup_automatico`, desligado por padrão) — não requer
  rollback de schema.

**Fase 3 — Continuidade e alertas existentes ajustados**
- #4, #7, #8: ajustar `stale-conversation-followup`/`followup_automatico`
  para considerar `opportunities.status`/`waiting_on`/`next_action_due_date`.
- #9, #10: regra de "não fechar sozinho" (seção 5) e `waiting_on` sendo
  atualizado nos pontos certos.
- Views de trabalho (seção 7).
- **Reversão**: os workers voltam a olhar só `conversations`/`tasks` como
  hoje — mudança é aditiva (novos campos consultados), não substitutiva.

**Fase 4 — Automações novas (documentos, análise, retomada, ganho/perda)**
- #5, #6, #11, #12 — as quatro automações que hoje não têm nenhum
  equivalente. Maior risco, feita por último, depois que Fases 1-3 já
  provaram o modelo de dados em produção.
- **Reversão**: cada automação nova por trás de um toggle próprio,
  desligado por padrão — desligar não afeta as oportunidades já criadas.

**Fase 5 — Migração de dados do CRM legado (só depois de tudo validado)**
- Só depois do usuário aprovar explicitamente: migrar a 1 oportunidade real
  do `deals` do CRM ("INSS") para `opportunities`, decidir se/quando
  desativar `crm-sync.ts` e o serviço `assistentemt-crm` no EasyPanel.
- Fora do escopo desta spec — vira uma spec própria quando chegar a hora,
  conforme já combinado.

## 10. Distinção código existente vs. produção

Confirmado lendo o código-fonte nesta sessão (não só specs, que podem estar
desatualizadas):

- 🟢 Rodando em produção hoje: `tasks`/`task_events`, `stale-conversation-followup.ts`
  (inclui a criação de `stalled_negotiation`), `followup_automatico`
  (`FollowupAutomaticoConfig` presente em `packages/shared` e na config de
  agente), `ai_disabled` (colunas + guards em `process-message.ts` e
  `webhooks/evolution.ts` + UI em `chat-header.tsx`/`conversation-list.tsx`),
  `takeover-timeout.ts`, `conversation_qualifications`/
  `conversation_qualification_events` (schema existe com RLS).
- 🟡 Não confirmado nesta sessão, verificar antes de ajustar na Fase 2: qual
  arquivo exatamente escreve em `conversation_qualifications` a partir da
  IA (não encontrei uma pasta `tools` no worker com o nome esperado — a
  tool existe, porque a tabela é populada, mas o caminho exato do arquivo
  fica para confirmar no início da Fase 2, não assumido aqui).
- Nenhuma mensagem real foi enviada nem nenhum negócio alterado em produção
  durante esta análise — só leitura de código e schema.

## Fora de escopo (YAGNI, aqui)

- Pós-venda/cronograma de pagamento/assembleias/entrega — "acompanhamento
  separado, vinculado ao negócio fechado", conforme pedido, mas é uma
  extensão futura (tabela própria, ex. `post_sale_milestones`), não faz
  parte da Fase 1-4.
- Tela de configuração de prazos/regras — mesmo padrão já adotado nas specs
  anteriores (`organizations.settings`/`tools_config`, editável hoje só via
  banco, UI fica para depois).
- Relatórios/analytics de produtividade da equipe.
- Qualquer mudança no CRM standalone (`assistente-mt`) — intocado até a
  Fase 5, que nem está aprovada ainda.
