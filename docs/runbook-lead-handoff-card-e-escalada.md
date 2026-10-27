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

## Como ligar

1. Aplicar as 3 migrações (não aplicadas automaticamente), em ordem. Sem as chaves o efeito do item 2 é nulo; o item 1 já vale para organizações com
   `sales_auto_pipeline_enabled` e `lead_distribution_enabled`.
2. Deploy do worker/web (a `main` faz deploy automático ao merge).
3. Ligar `sla_alert_escalation_enabled` em Configurações (gestor) quando quiser a escalada.

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
