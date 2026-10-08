# Distribuição de leads entre vendedores (rodízio) — Design

Data: 07/10/2026. Status: **aprovada** em 07/10/2026 (com os ajustes da seção 11). Vendedores: Marina e Márcio. Mariana é a IA que qualifica.

## 1. Objetivo e escopo

Distribuir cada novo lead qualificado pela Mariana entre os vendedores ativos de forma automática, justa e auditável, sem lead parado sem dono. O principal KPI comercial futuro é o tempo entre o handoff da Mariana e a primeira resposta humana.

**Dentro do escopo (fase 1):**
- Rodízio 50/50 entre vendedores `available`, com estado persistido no banco e atribuição atômica.
- Vendedor com estado Disponível, Pausado ou Fora da distribuição.
- Cliente que já tem vendedor continua com ele.
- Registro de quem recebeu, quando, por quê, quando assumiu e se estourou o SLA.
- SLA de 15 minutos úteis para assumir; redistribuição automática ao outro vendedor.
- Fila de exceções para o gestor, com motivos estruturados.
- Isolamento por vendedor **na API e na tela**.
- Estrutura preparada (sem ativar) para peso, limite de leads ativos, especialidade, prioridade por origem e score.

**Fora do escopo (fase 1):**
- Redistribuir a base existente: só valem handoffs **posteriores à ativação** da flag.
- RLS por vendedor (ver seção 8, fase 2).
- Pesos, limites, especialidade, prioridade por origem e score ativos.
- Notificação ativa ao gestor (e-mail ou push). Nesta fase o aviso é um painel e um contador.
- Migrar o helper de horário dos follow-ups automáticos para o novo calendário.

## 2. Decisões já tomadas

| Tema | Decisão |
|---|---|
| Estratégia | Rodízio automático, Marina → Márcio → Marina → Márcio |
| Fonte do próximo | `lead_distribution_state` é a **única** fonte do ponteiro do rodízio |
| Assumir | Botão **Assumir lead** ou primeira mensagem humana, o que vier primeiro |
| SLA | 15 minutos úteis; a varredura roda a cada 1 minuto. **Redistribui só lead novo do rodízio.** Cliente com dono existente (e atribuição manual) mantém o dono: só medição e alerta, sem redistribuição automática |
| Vai e volta | Cada vendedor recebe o mesmo handoff no máximo uma vez; depois, fila de exceções |
| Histórico | Imutável, nunca apagado |
| Isolamento | Aplicação (API e tela) na fase 1; RLS na fase 2 |
| Backlog | Não redistribuído |
| Flag | `lead_distribution_enabled`, desligada por padrão |

## 3. Estados do vendedor

| Estado | Recebe novos leads | Mantém clientes já atribuídos | Leads pendentes (ainda não assumidos) |
|---|---|---|---|
| `available` | sim | sim | seguem com ele até o SLA |
| `paused` | **não** | **sim** | seguem com ele até o SLA |
| `out` | **não** | sim, **sem redistribuição automática** | seguem com ele até o SLA |

**Marcar um vendedor como `out` não move nenhum lead.** Nem a carteira assumida nem os pendentes são redistribuídos automaticamente: os pendentes seguem a regra normal do SLA (se não assumir no prazo, vão para o outro vendedor). A única consequência é que um cliente cujo responsável está `out` e que gere um **novo handoff** pode voltar ao rodízio (seção 5.2). A redistribuição em massa da carteira é uma **ação administrativa separada e explícita** do gestor, nunca um efeito colateral da mudança de estado. O vendedor muda o próprio estado; owner e admin mudam o de qualquer um.

## 4. Modelo de dados (migration única, atrás da flag)

### 4.1 `sales_reps`
Um registro por vendedor, ligado a um membro da organização.

- `id`, `organization_id`, `user_id` (único por organização), `display_name`.
- `availability` (`available` | `paused` | `out`), `availability_changed_at`.
- `rotation_order` (inteiro, ordem fixa e estável do rodízio: Marina 1, Márcio 2).
- `last_assigned_at`: **apenas operacional e de auditoria**. Não participa da escolha do próximo.
- **Reservados para o futuro, ignorados hoje:** `weight` (nulo), `max_active_leads` (nulo), `specialties` (`text[]`, vazio), `score` (nulo).

### 4.2 `lead_distribution_state`
Uma linha por organização. É a trava da atribuição atômica (`SELECT ... FOR UPDATE`) e a fonte autoritativa do rodízio.

- `organization_id` (chave primária), `last_rotation_order` (posição do último vendedor que recebeu pelo rodízio), `updated_at`.

### 4.3 `lead_assignments` (livro de histórico, só acrescenta)
- Identidade: `id`, `organization_id`, `chain_id` (um por handoff; agrupa as tentativas), `handoff_event_id`.
- Alvo: `contact_id`, `conversation_id`, `opportunity_id` (nulo), `rep_id` (nulo em exceção).
- Atribuição: `reason` (`round_robin` | `existing_owner` | `sla_redistribution` | `manual` | `bulk_reassignment` | `exception`), `assigned_at`, `previous_assignment_id`, `next_assignment_id`.
- SLA: `sla_due_at`, `sla_breached` (booleano), `sla_action` (`redistribute` para lead novo do rodízio; `alert` para dono existente e atribuição manual: só alerta, nunca redistribui), `redistribution_reason`.
- Marcos de tempo: `handoff_at`, `assigned_at`, `accepted_at`, `accepted_via` (`button` | `first_message` | `phone_echo`), `first_human_message_at`, `first_human_message_by`.
- Estado: `status` (`pending` | `accepted` | `expired` | `redistributed` | `exception`). `expired` é a atribuição que **estourou o SLA** e foi substituída; `redistributed` é a que foi substituída por reatribuição do gestor (manual ou em lote); `exception` é a linha sem vendedor.
- Exceção: `exception_reason`, `resolved_at`, `resolved_by`, `resolution`.
- Contexto copiado no momento da atribuição, para análises futuras: `origin_source`, `operation`, `product_model`, `strategy_version`.

**Restrições:**
- Índice único parcial: no máximo **uma** atribuição ativa (`pending` ou `accepted`) por conversa.
- Índice único `(chain_id, rep_id)`: garante no banco que cada vendedor recebe o mesmo handoff no máximo uma vez (regra "sem vai e volta").
- Idempotência: um handoff reprocessado não cria nova cadeia.
- Imutabilidade: um gatilho proíbe `DELETE` e alterações em `rep_id`, `reason`, `assigned_at`, `handoff_at`, `chain_id` e `previous_assignment_id`. Podem mudar apenas `status`, `accepted_*`, `first_human_message_*`, `sla_breached`, `redistribution_reason`, `next_assignment_id` e os campos de resolução da exceção.

### 4.4 Colunas novas em tabelas existentes
- `opportunities.owner_assigned_at` e `opportunities.last_commercial_activity_at`: base para uma futura proteção ou expiração de carteira.
- `conversations.assigned_at`.
- Nada é removido ou renomeado. `owner_id`, `assigned_to` e `assignee_id` continuam sendo os campos de responsável.

### 4.5 Configurações da organização
- `lead_distribution_enabled` e `lead_distribution_activated_at`: só handoffs com `handed_at >= activated_at` entram.
- `lead_sla_minutes` (padrão 15).
- `owner_lookback_days` (padrão 30, aprovado): janela do passo 3 da precedência de dono (seção 5.2). Atividade comercial relevante (mensagem humana do dono, mudança de etapa, tarefa concluída pelo dono) atualiza `opportunities.last_commercial_activity_at` e mantém a carteira dentro da janela.
- `business_calendar` (seção 6.2).

## 5. Fluxo de atribuição

### 5.1 Gatilho
O handoff qualificado que já existe (pedido de humano e financiamento completo, o "Pronto para Marina") chama a função `distribute_lead(...)` do banco, passando o `sla_due_at` já calculado pela aplicação. A função é idempotente por `handoff_event_id`.

### 5.2 Precedência do dono existente
Quando há informação conflitante, vale a primeira regra que encontrar um **vendedor válido** (`available` ou `paused`):

1. **Negócio aberto atual:** `owner_id` do negócio aberto do contato.
2. **Conversa atual:** `assigned_to` da conversa.
3. **Último responsável válido:** responsável da atribuição mais recente do contato, **apenas dentro de `owner_lookback_days`** e só se não for de um negócio fechado, ganho ou perdido há mais tempo que a janela. Negócios antigos não mantêm o cliente preso para sempre.

Casos de borda:
- Dono encontrado com estado `out`, ou usuário que já não é vendedor: ignorado **apenas para este novo handoff**, e o lead entra no rodízio. Nada é movido em massa.
- Dois negócios abertos com donos diferentes: exceção `manual_review`.
- Dono encontrado mas inválido de forma que não se resolve (por exemplo, vendedor removido da organização com negócio aberto): exceção `invalid_existing_owner`.
- Quando o dono é reutilizado, o rodízio **não avança** (`reason = existing_owner`).

### 5.3 Rodízio
Sob a trava de `lead_distribution_state`:
1. Lista os vendedores `available` ordenados por `rotation_order`.
2. Escolhe o primeiro com `rotation_order` maior que `last_rotation_order`, voltando ao início se não houver.
3. Atualiza `last_rotation_order` para o escolhido e atualiza `last_assigned_at` (somente informativo).

Quem está `paused` ou `out` é pulado sem perder a consistência. Quem volta a `available` não recebe rajada de compensação. Quando uma redistribuição por SLA entrega o lead ao outro vendedor, o ponteiro também passa para ele, para o próximo lead novo ir ao primeiro vendedor.

### 5.4 Efeitos da atribuição
Na mesma transação: grava `lead_assignments`, define `conversations.assigned_to` e `assigned_at`, define `opportunities.owner_id` e `owner_assigned_at` (quando há um só negócio aberto) e atualiza `assignee_id` nas tarefas abertas do contato.

### 5.5 Sem vendedor disponível
Cria uma linha `status = exception` com `exception_reason = no_available_rep`. O worker tenta de novo quando alguém voltar a `available`.

## 6. SLA, assumir e redistribuição

### 6.1 Assumir
- `POST /lead-assignments/:id/accept`: só o vendedor atribuído ou um admin.
- Primeira mensagem humana enviada ao cliente (envio pelo painel) também assume.
- Mensagem enviada pelo celular (eco `fromMe` do WhatsApp) conta como primeira mensagem humana e assume em nome do vendedor atribuído (`phone_echo`), **somente quando a identificação for confiável** (ver 6.1.1).
- O aceite grava `accepted_at` e `accepted_via` e para o relógio do SLA.

#### 6.1.1 Identificação confiável de ação humana
Só é "primeira mensagem humana" a mensagem que **não** tenha sido gerada pelo sistema. Não contam, e nunca assumem o lead nem preenchem `first_human_message_at`:
- respostas da Mariana (role `agent`) e mensagens enviadas por qualquer worker (follow-ups automáticos, cadência de 1h/23h, despedidas, avisos de handoff);
- templates e mídias automáticas (fotos de catálogo, áudios gerados);
- ecos `fromMe` de mensagens que o próprio sistema acabou de enviar. O sistema já grava o id da Evolution (`evolution_message_id`) em toda mensagem enviada por ele, e o eco correspondente é descartado por esse id (comportamento existente de deduplicação de eco);
- mensagens humanas de quem **não** é o vendedor atribuído (um admin, por exemplo, registra `first_human_message_by` mas só assume em nome do atribuído se for o painel dele; eco de celular não identifica autor e só assume quando a conversa tem o vendedor atribuído como único responsável).

Critério técnico: a mensagem precisa ter `role = human_agent` e origem humana comprovada (envio pelo painel com usuário autenticado, ou eco `fromMe` sem `evolution_message_id` conhecido do sistema). Há testes específicos para cada exclusão acima (seção 13).

### 6.2 Calendário comercial
O helper atual `isWithinBusinessHours` usa `America/Sao_Paulo`, mas considera **somente a hora do dia**: não conhece domingos, dias não úteis nem períodos fechados. Por isso a spec cria um calendário novo, sem alterar o helper dos follow-ups.

`business_calendar` (configuração da organização):
- `timeZone` (padrão `America/Sao_Paulo`).
- `weekly`: janelas por dia da semana, **totalmente configurável**. Padrão: segunda a sexta 08:00–18:00, sábado e domingo fechados. Se houver atendimento comercial aos sábados, configura-se uma janela própria (por exemplo 08:00–12:00); nada é fixo na lógica.
- `closedDates`: datas fechadas (feriados) e `closedPeriods`: períodos fechados com motivo.

Funções puras e testáveis em `packages/shared`:
- `isBusinessOpen(date, calendar)`.
- `addBusinessMinutes(start, minutes, calendar)`: se `start` cai fora do expediente, o relógio começa na próxima abertura; o prazo nunca corre de madrugada, aos domingos ou em período fechado. Tem limite de varredura para evitar laço infinito com calendário mal configurado.

O prazo é calculado **na atribuição** e gravado em `sla_due_at`. Alterar o calendário depois não muda prazos já gravados.

### 6.3 Varredura de SLA
- Fila nova `lead-sla` (BullMQ), job repetido a cada **1 minuto**.
- **Redistribuição (`sla_action = 'redistribute'`, só lead novo do rodízio):** consulta indexada `status = pending AND sla_action = 'redistribute' AND sla_due_at <= now()`. Para cada vencida o worker calcula o novo `sla_due_at` e chama `redistribute_assignment(id, novo_sla)`, que trava a linha, confere se ainda está `pending` e vencida (segura contra dois workers) e então:
  - marca a atual como `expired` com `sla_breached = true` e `redistribution_reason`;
  - cria a nova atribuição ao outro vendedor `available` que ainda não recebeu aquela cadeia (`reason = sla_redistribution`), ligada à anterior;
  - se não existir vendedor elegível, cria exceção `all_reps_sla_breached`.
- **Alerta (`sla_action = 'alert'`, dono existente e atribuição manual):** o cliente **não muda de vendedor**. Cada varredura chama `flag_sla_alerts()`, que marca `sla_breached = true` nas atribuições `pending` já vencidas. O card mostra o atraso em vermelho e o gestor vê a lista de alertas. Um cliente que já pertence à Marina não passa ao Márcio só porque ela demorou 15 minutos.
- A redistribuição é interna: o cliente não recebe mensagem por causa dela.
- Resultado prático: redistribuição em até cerca de 1 minuto depois do vencimento real, e não até 15 minutos depois.

### 6.4 KPIs de tempo
Todos calculáveis por uma view `lead_response_metrics` a partir dos marcos acima:
- `handoff_at → first_human_message_at` (tempo total desde o handoff da Mariana até a primeira resposta humana, **principal KPI comercial**, medido na cadeia inteira, inclusive após redistribuições);
- `assigned_at → first_human_message_at`;
- `assigned_at → accepted_at`.

Além disso, contagem de SLAs estourados por vendedor.

## 7. Fila de exceções

Linhas `status = exception` com motivo estruturado:

| Motivo | Quando |
|---|---|
| `no_available_rep` | nenhum vendedor `available` no momento |
| `all_reps_sla_breached` | todos os vendedores elegíveis da cadeia já estouraram |
| `invalid_existing_owner` | dono existente que não se resolve |
| `distribution_error` | falha inesperada na distribuição (a transação é revertida e o erro registrado) |
| `manual_review` | conflito que exige decisão humana (ex.: donos diferentes em negócios abertos) |

O gestor vê a fila em um painel, atribui manualmente (cria nova linha com `reason = manual`, ligada à exceção) e registra `resolved_by` e `resolution`. Aviso ativo (e-mail ou push) está fora da fase 1; o painel mostra um contador.

## 8. Permissões e isolamento

**Papéis:** `owner` e `admin` são gestores. `agent` é vendedor.
- **Gestor:** vê todos os leads, a fila de exceções, reatribui, configura o rodízio e muda estados.
- **Vendedor:** vê apenas os leads atribuídos a ele.

### Fase 1: isolamento de aplicação
O filtro por vendedor é aplicado **na API e na tela**:
- Na API, um helper de visibilidade devolve `all` (gestor) ou `own` (vendedor) e é aplicado em: lista de negócios, tarefas sem negócio, "a identificar", lista de tarefas, "Hoje" e leitura de atribuições.
- Na tela: funil, tarefas e inbox com filtro "Minhas".

**Limite assumido e registrado:** o isolamento desta fase é **de aplicação, não uma garantia do banco**. O inbox, o realtime e algumas telas leem direto do Supabase com as regras atuais por organização. Um membro com conhecimento técnico ainda poderia ler dados de outros vendedores por fora da API.

### Fase 2: reforço por RLS (registrada, não faz parte desta entrega)
Políticas de RLS por vendedor em `conversations`, `messages`, `tasks`, `opportunities` e tabelas dependentes, mais revisão do realtime e testes de regressão do inbox. Deve ter spec própria. Até que seja feita, o produto não deve prometer isolamento forte entre vendedores.

## 9. Interface

- Card do lead: selo do vendedor, botão **Assumir lead** e contagem regressiva do SLA.
- Detalhe do lead: aba de histórico com a linha do tempo das atribuições (vendedor, hora, motivo, aceite, SLA estourado, motivo da redistribuição, vendedor seguinte).
- Cabeçalho: seletor de disponibilidade do próprio vendedor.
- Gestor: painel de exceções e reatribuição.
- Configurações → Distribuição: flag, prazo do SLA, calendário comercial, lista de vendedores com estado.
- A fila livre não existe.

## 10. Preparação para o futuro (nada ativo)

- A escolha é uma função pura `pickRep(candidatos, contexto)`; o contexto já recebe origem, operação e produto, e a atribuição grava `strategy_version`.
- Peso, limite de leads ativos, especialidade e score entram preenchendo colunas de `sales_reps` que já existem e trocando a estratégia.
- Prioridade por origem: o `origin_source` já é gravado em cada atribuição; uma tabela de regras só será criada quando a regra existir.
- Proteção e expiração de carteira: `owner_assigned_at`, `last_commercial_activity_at` e `assigned_at` já ficam gravados.

## 11. Decisões finais sobre os pontos abertos

1. **Sábado:** calendário configurável; sábado fechado por padrão, com janela própria se houver atendimento.
2. **Celular:** a primeira mensagem humana do vendedor atribuído assume e preenche `accepted_at`, desde que a identificação seja confiável (6.1.1), com testes específicos.
3. **Janela do último responsável:** 30 dias; atividade comercial relevante atualiza `last_commercial_activity_at`.
4. **Aviso de exceção:** painel e contador na fase 1; sem e-mail nem push.
5. **`out`:** não redistribui nada automaticamente; só afasta o vendedor dos novos leads. Redistribuição em massa é ação administrativa separada.

## 11A. Modo sombra (shadow) antes da ativação

Flag `lead_distribution_shadow_enabled` (ignorada quando `lead_distribution_enabled` está ligada). Com ela ligada, cada handoff roda a **mesma lógica de decisão** da distribuição real (função `_lead_decide`, compartilhada, sem cópia), mas:
- **não** cria atribuição, não altera conversa, negócio nem tarefas, e não move o ponteiro real do rodízio;
- registra a decisão em `lead_distribution_shadow_log` (quem receberia, motivo, exceção, ponteiro antes e depois, `sla_due_at` que seria usado), idempotente por `handoff_event_id`;
- usa um ponteiro próprio (`shadow_last_rotation_order`) para simular a alternância sem tocar no real.

Limitação conhecida: como o modo sombra não grava dono, um segundo handoff do mesmo cliente durante a simulação aparece como `round_robin` (não como `existing_owner` simulado); o dono existente só é reconhecido quando já existia antes. Serve para validar alternância, dono existente real, calendário e prazo, e exceções. A redistribuição por SLA não é simulada: valida-se com os primeiros leads reais e `lead_sla_minutes` reduzido (runbook).

## 11B. Dívida técnica explícita (fase de RLS e isolamento por vendedor)

- O isolamento por vendedor da fase 1 é de **aplicação**: inbox, realtime e página de tarefas leem direto do Supabase e só têm filtro de tela. Não é garantia do banco.
- A visibilidade é a versão **branda**: o vendedor não vê o que pertence claramente ao outro vendedor; lead sem dono e carteira antiga continuam visíveis. Não se migra a carteira antiga nesta fase.
- Etapa futura própria: saneamento e migração da carteira, endurecimento do isolamento (RLS em `conversations`, `messages`, `tasks`, `opportunities` e dependentes, revisão do realtime) e atividade comercial além de mensagem humana (mudança de etapa e tarefa concluída **não** atualizam `last_commercial_activity_at` por decisão desta fase).

## 12. Ativação e reversão

1. Aplicar a migration e publicar. A flag nasce desligada e o comportamento atual não muda.
2. Convidar o Márcio como membro `agent`, criar os registros de `sales_reps` (Marina e Márcio) e conferir o calendário.
3. Ligar `lead_distribution_enabled`. O sistema grava `lead_distribution_activated_at` e só handoffs a partir daí entram.
4. Validar com handoffs reais, conferindo uma atribuição de cada tipo (rodízio, dono existente, redistribuição por SLA e exceção).
5. **Reversão:** desligar a flag. O histórico permanece, os leads atribuídos continuam com seus donos e o fluxo volta a usar o responsável padrão de handoff.

## 13. Testes

- **Funções puras:** `pickRep` (alternância, pular pausado e fora, empate, ponteiro) e `addBusinessMinutes` / `isBusinessOpen` (madrugada, domingo, feriado, período fechado, início fora do expediente, calendário inválido).
- **SQL em PGlite:** dois handoffs simultâneos recebem vendedores distintos; idempotência por `handoff_event_id`; precedência do dono (negócio aberto > conversa > último responsável dentro da janela; negócio antigo não prende); dono `out` em um novo handoff volta ao rodízio e **nenhum lead é movido** ao marcar `out`; histórico imutável (`DELETE` e campos protegidos rejeitados); índice `(chain_id, rep_id)` impede vai e volta; exceções com cada motivo; redistribuição por SLA mantém o ponteiro consistente.
- **Identificação de ação humana (6.1.1):** resposta da Mariana, follow-up automático, cadência, despedida, template, mídia automática, eco de mensagem enviada pelo próprio sistema (mesmo `evolution_message_id`) e mensagem de outro humano **não** assumem o lead nem preenchem `first_human_message_at`; mensagem do painel pelo vendedor atribuído e eco de celular legítimo assumem.
- **Worker:** a varredura processa vencidos, ignora não vencidos, é segura com dois workers e gera exceção quando ninguém é elegível.
- **API:** vendedor só enxerga os próprios leads, gestor vê todos, aceite só pelo vendedor atribuído ou admin.
- **Validação manual pós-deploy:** cartão com contagem regressiva, botão **Assumir lead**, histórico e painel de exceções.

## 14. Riscos

| Risco | Mitigação |
|---|---|
| Isolamento só de aplicação | Registrado como limite; fase 2 de RLS com spec própria |
| Calendário mal configurado empurra prazos | Limite de varredura e valores padrão válidos; teste de calendário inválido |
| Eco do celular assume lead indevidamente | Regra de origem humana comprovada (6.1.1), testes específicos e `accepted_via = phone_echo` para auditar |
| Redistribuição inesperada | Só ocorre após SLA vencido; tudo registrado no histórico imutável |
| Dois workers redistribuindo o mesmo lead | Trava de linha e conferência de estado dentro da função |
