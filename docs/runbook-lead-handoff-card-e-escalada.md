# Runbook: card no funil em todo encaminhamento (com distribuição ativa) + escalada de lead da carteira sem resposta

Origem: caso de 27/10 (cliente Márcio, da carteira da Marina, pediu carta de crédito; a IA chamou `requestHuman` às 09:40). Nasceram a
atribuição (`existing_owner`, `sla_action='alert'`, prazo 10:40) e duas tarefas humanas (`run_quote`, `other`), mas o contato não tinha
nenhum negócio e não apareceu em coluna alguma do funil; o SLA estourou e ninguém respondeu por mais de 2 horas.

## O que mudou

### 1. Card no funil (migrações `20261027120000_handoff_card.sql` e `20261027120100_default_operation_sync.sql`)

Quando a distribuição aplica uma atribuição (`distribute_lead`, `redistribute_assignment`, `manual_assign`, `escalate_alert_assignment`, todos via
`_lead_apply_effects`) e o contato **não tem nenhum negócio** (aberto, ganho ou perdido) na organização, nasce 1 negócio aberto em
`interest_received`, dono = vendedor que recebeu, ligado à atribuição (`lead_assignments.opportunity_id`) e às tarefas abertas do contato.

- Chave: `organizations.settings.sales_auto_pipeline_enabled` = JSON `true` (a mesma dos outros criadores). Sem ela nada muda.
- Nunca cria segundo negócio aberto; contato só com histórico fechado não é reaberto; contato em `organization_ignored_contacts` fica de fora.
- Exceção (sem vendedor disponível) não tem dono: o card nasce quando o gestor atribui manualmente.
- Operação (coluna NOT NULL), nesta ordem: dado do handoff (contexto de `distribute_lead`, ou última `lead_assignments.operation` da conversa) ->
  tipo único das tarefas abertas (`_task_type_operation`) -> padrão `vehicle_sale`. `conversation_qualifications` não tem coluna de operação
  (só `product_interest` em texto livre), então não é usada. Não existe valor "a definir" no CHECK de `opportunities.operation`.
- Quando é só o padrão: `opportunities.operation_is_default = true` (coluna nova) e o evento `created` traz o texto
  "Negócio criado no encaminhamento para humano (operação a confirmar)", `changed_by_type='system'`, `new_value.source='handoff_card'`.
- `sync_sales_pipeline` (v3): negócio com `operation_is_default` aceita a operação identificada pela IA mesmo sem pedido explícito (evento
  `operation_changed`, "Operação a confirmar definida pela conversa"). Ao mudar a operação, o gatilho `trg_clear_operation_is_default` limpa a
  marca (vale também para o vendedor que muda a operação na tela); depois disso volta a exigir pedido explícito. Negócios existentes não têm a
  marca: comportamento idêntico ao anterior.
- Ordem de locks (documentada nas migrações): `lead_distribution_state` -> `lead_assignments` -> `conversations` -> `wa_contacts`
  (`FOR NO KEY UPDATE SKIP LOCKED`) -> `opportunities` -> `tasks` (`SKIP LOCKED` na ligação). Todos os "não" são leituras antes do lock; contato ocupado
  = não espera e não cria (a atribuição segue sem card, como hoje).
- Efeito colateral intencional: no caso de tarefas de tipos mistos (consórcio + veículo) onde antes nada era criado, agora nasce o card com a
  operação padrão marcada "a confirmar".

### 2. Escalada em dois estágios (migração `20261027120200_sla_alert_escalation.sql` + worker)

Chave: `organizations.settings.sla_alert_escalation_enabled` (**desligada por padrão**; exige `lead_distribution_enabled`; ao ligar grava `sla_alert_escalation_activated_at`). Interruptor em
Configurações, junto dos de distribuição de leads. Vale só para atribuição `alert` (`existing_owner` e `manual`).

- Estágio 1 (1x o SLA): o worker de push (`apps/worker/src/workers/push-notifications.ts`) envia ao **dono** "SLA estourado: responda <cliente>",
  uma vez por atribuição (`push_notification_log`, chave `sla_breach:<id>`), só com a atribuição pendente e sem primeira resposta humana; ignora
  estouros com mais de 24 h (evita enxurrada ao ligar a chave). Exige também `push_notifications_enabled`.
- Estágio 2 (2x o SLA): `runLeadSlaSweep` chama `escalate_alert_assignment` (SECURITY DEFINER, só `service_role`). O 2x é calculado em minutos úteis
  (mesmo calendário do SLA) a partir de `assigned_at`. A função trava (estado da organização -> linha) e só age se a atribuição ainda está
  pendente e vencida, o cliente não foi respondido por humano (`first_human_message_at` nulo e nenhuma mensagem `human_agent` desde o handoff)
  e a cadeia ainda não foi escalada. Passa ao próximo vendedor `available` (membro, que ainda não passou pela cadeia, ordem do rodízio),
  antiga = `redistributed` com `redistribution_reason='sla_escalation'`, nova = `pending`, `reason='sla_redistribution'`, `sla_action='alert'`, SLA novo.
  Conversa, negócio aberto e tarefas seguem o novo dono (`_lead_apply_effects` + gatilhos existentes). O ponteiro do rodízio acompanha.
- **No máximo uma escalada por cadeia** (sem vai e volta), mesmo que o gestor reatribua depois.
- Sem outro vendedor disponível (inclui "dono é o único"): a atribuição fica com o dono e ganha o rastro `redistribution_reason='sla_escalation_no_rep'`
  (não cria linha `exception`, que quebraria `manual_assign`/`distribute_lead` com atribuição pendente na conversa). Tenta de novo a cada varredura.
- O novo dono recebe o push normal "Novo lead" (atribuição pendente nova).
- Vendedor `paused` não recebe escalada automática (mesma regra do rodízio e de `redistribute_assignment`).

## Correções da revisão independente (incorporadas)

- H1: `syncSalesPipeline` (TS) ignora a operação de um card com `operation_is_default` (não é evidência); a decisão usa explícito/tipo de atendimento/histórico, igual a antes do card.
  No SQL, qualquer chamada com evidência corrige a operação OU confirma a mesma e limpa a marca.
- H2: `organizations.settings.sla_alert_escalation_activated_at` (gravado pelo interruptor ao LIGAR; mantido ao desligar, como `lead_distribution_activated_at`).
  Só escala/lista atribuição com `sla_due_at >= greatest(ativação, agora - 24h)`. Ligar a chave não move carteira antiga.
- M1: fila de candidatas em SQL (`list_escalation_candidates(p_per_org)`), mesmos filtros da função, ordem por vencimento, limite por organização.
- M2: "já atendido" (`_alert_assignment_answered`): resposta humana, aceite, ligação (`sales_call_logs`), `last_commercial_activity_at`, conversa fechada, negócio ganho/perdido.
- M3: selo "Operação a confirmar" no card e no detalhe; `POST /opportunities` com card marcado atualiza a operação (200) em vez de 409.
- M4: `ensure_handoff_cards` chamada a cada varredura do `lead-sla` repara o card pulado por contato travado (atribuições pendentes < 24 h).
  `lead_assignments.opportunity_id` é imutável e continua nulo nessas linhas.

## Segunda revisão (incorporada)

- Ordem segura de deploy (migração 2 só limpa a marca com o sinal NOVO `p_default_correction`, que só o worker novo manda; worker antigo nunca apaga a marca).
  A API lê o card com `select("*")` (não quebra se a coluna ainda não existir) e o worker repete o rpc sem o parâmetro se a função ainda não o tem.
- Janela da escalada medida no instante de 2x o SLA (`p_escalate_at >= greatest(ativação, agora-24h)`): estouro de sexta 17:45 escala na segunda 08:15.
  A fila (`list_escalation_candidates`) usa janela larga de 5 dias, mais recentes primeiro; o worker descarta o que está fora da janela exata.
- Sync que corrige um card padrão grava os mesmos campos do caminho de criação (campos da qualificação, `initial_operation`, `last_interaction_at`).
- `POST /opportunities` num card padrão grava tudo o que o vendedor enviou (mesmo schema), exige `canViewLead`, só muda o dono se `canAssignLead` permitir, e devolve 409 se a marca caiu no meio.
- "Já atendido" também considera tarefa/evento humano e nota na conversa desde a atribuição.
- Regra de histórico: um card do encaminhamento PERDIDO, nunca confirmado (`operation_is_default` ainda true) e sem ação humana além de "perdido" NÃO conta como histórico
  (`_contact_has_deal_history`): o cliente que voltar volta a ganhar card/negócio automático (handoff e `sync_sales_pipeline`). Qualquer outro negócio fechado continua bloqueando.
  Obs.: o gatilho de tarefa humana (`human_task_opens_opportunity`, migração 20261021) mantém a regra antiga (qualquer histórico bloqueia).
- Chave de desligar: `organizations.settings.handoff_card_enabled` (ligada a menos que seja `false` explícito; interruptor em Configurações). Vale para `_open_opportunity_for_handoff` e `ensure_handoff_cards`.
- Índices (migração 3): `lead_assignments_alert_pending_due`, `lead_assignments_chain`, `lead_assignments_pending_without_opportunity`. A varredura `lead-sla` roda a cada 60 s (não 5 min);
  `flag_sla_alerts` tira as linhas do índice parcial antigo (`NOT sla_breached`), por isso o índice novo.
- Na primeira execução do worker novo, `ensure_handoff_cards` faz um reparo único: toda atribuição pendente das últimas 24 h sem nenhum negócio (inclusive a de 27/10, se ainda estiver na janela) ganha o card.

## Antes de aplicar: conferir as funções de produção (SQL foi aplicado à mão)

1. Gerar a lista esperada (já commitada em `docs/function-fingerprints-before-handoff-card.tsv`):
   `pnpm --filter @aula-agente/database build && node packages/database/scripts/function-fingerprints.mjs` (`--check` compara com o arquivo).
2. No editor SQL do Supabase de produção, rodar e comparar linha a linha (nome, argumentos, md5):

```sql
select p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(p.prosrc) as md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('sync_sales_pipeline','_lead_apply_effects','distribute_lead','redistribute_assignment','manual_assign','flag_sla_alerts')
 order by 1, 2;
```

Diferença em qualquer md5 = produção divergiu do repositório: parar e revisar antes de aplicar (as migrações novas substituem `sync_sales_pipeline`, `_lead_apply_effects` e `distribute_lead`).

## Como ligar (ORDEM OBRIGATÓRIA)

1. Conferir os md5 acima.
2. Aplicar a migração 1 (`20261027120000_handoff_card.sql`): cria a coluna, o card e a chave `handoff_card_enabled` (o card já passa a valer com distribuição + `sales_auto_pipeline_enabled` ligadas; para adiar, definir `handoff_card_enabled=false` antes).
3. Deploy de api/worker/web (merge na `main`).
4. Aplicar as migrações 2 e 3 (`...120100`, `...120200`). Aplicar a 2 com worker antigo rodando não causa dano (a marca só cai com o sinal novo), mas o card padrão não será corrigido até o deploy.
5. Ligar `sla_alert_escalation_enabled` em Configurações quando quiser a escalada (grava `sla_alert_escalation_activated_at`).

## Como reverter

Reverter na ordem inversa das migrações (120200 -> 120100 -> 120000): `escalate_alert_assignment` chama a `_lead_apply_effects` de 5 argumentos.
Também: `DROP FUNCTION IF EXISTS public.ensure_handoff_cards(integer), public.list_escalation_candidates(integer), public._alert_assignment_answered(public.lead_assignments);`

- Escalada: desligar a chave `sla_alert_escalation_enabled`. Remover: `DROP FUNCTION IF EXISTS public.escalate_alert_assignment(uuid, timestamptz, timestamptz);`
- `sync_sales_pipeline`: restaurar a função de `20261007120500_lead_distribution_sales_pipeline.sql`.
- Card: ver o cabeçalho de `20261027120000_handoff_card.sql` (restaurar `distribute_lead` de `20261007120400`, recriar `_lead_apply_effects(uuid,uuid,uuid,uuid)` de
  `20261007120100`, `DROP` do trigger/funções novas; coluna `operation_is_default` pode ficar). Negócios já criados: `opportunity_events.new_value->>'source' = 'handoff_card'`.
- Desligar `sales_auto_pipeline_enabled` também interrompe a criação de cards.

## Consultas úteis

```sql
-- cards criados pelo encaminhamento, ainda com operação a confirmar
select o.id, o.contact_id, o.owner_id, o.created_at from opportunities o where o.operation_is_default and o.status = 'open';
-- escaladas e rastros de "sem vendedor"
select id, conversation_id, redistribution_reason, assigned_at from lead_assignments where redistribution_reason in ('sla_escalation','sla_escalation_no_rep') order by assigned_at desc;
```
