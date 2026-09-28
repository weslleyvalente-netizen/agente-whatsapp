CONTEXTO
Este é o monorepo aula-agente (CRM + agente de IA Helena, WhatsApp via Evolution API). Hoje UMA única atendente humana (a Marina) cuida de todos os leads que a IA recebe. Nos últimos 30 dias foram 6.220 mensagens humanas contra 5.288 da IA, 751 conversas com intervenção humana e 1.384 tarefas criadas. No funil, 304 oportunidades foram criadas e só 2 foram marcadas como ganhas, porque o fechamento acontece fora do sistema e ninguém volta para marcar.

Objetivo: (A) reduzir a carga da atendente e tornar o handoff explícito e mensurável; (B) fazer o funil registrar de verdade o que foi vendido ou perdido.

REGRAS DE TRABALHO
- NÃO faça push na main (o deploy é automático). Trabalhe na branch feat/handoff-e-fechamento-funil.
- Antes de codar cada fase, me mostre um PLANO com as migrations, os arquivos que vai alterar e as decisões em aberto. Espere minha aprovação.
- Migrations reversíveis. Nada de nome de pessoa hardcoded: o responsável padrão pelo handoff é uma configuração da organização.
- Siga os padrões que já existem: evidência obrigatória em opportunity_events, dedup de tarefas, RLS por organization_id.
- Escreva testes para as funções puras novas (packages/shared).
- Ao terminar cada fase, registre neste arquivo (seção "PROGRESSO", no final) o que foi feito, as decisões tomadas e o que ficou pendente.

FASE 0 — DIAGNÓSTICO (só leitura, antes de qualquer mudança)
Consulte o banco de produção (sem expor dados pessoais) e me entregue:
1. Das conversas com takeover humano nos últimos 30 dias, quantas começaram por uma mensagem fromMe curta (≤ 15 caracteres, ou só emoji/"ok"/"blz"/"👍").
2. Uma amostra de 40 conversas com takeover. Classifique cada uma pelo motivo provável: (a) IA errou ou travou; (b) cliente pediu humano; (c) negociação real (desconto, proposta, documentos); (d) humano entrou sem necessidade aparente; (e) outro. Mostre a contagem por motivo e 1 exemplo anonimizado de cada.
3. A distribuição das 1.384 tarefas por tipo, a quantidade por oportunidade/contato, quantas ainda estão abertas e quantas foram concluídas.
4. Onde as oportunidades estão paradas: contagem por funil e estágio, e dias desde o último progresso.
Pare aqui e me mostre o resultado. Os ajustes das fases seguintes podem mudar conforme o diagnóstico.

FASE 1 — HANDOFF EXPLÍCITO
1. Nova ferramenta do agente: requestHuman(motivo, resumo, urgencia).
   - motivo: enum (cliente_pediu, negociacao_valor, proposta_pronta, documentos, reclamacao, fora_do_escopo, ia_sem_resposta).
   - Ativa is_human_takeover, define assigned_to com o responsável padrão da organização e grava um evento de handoff (nova tabela handoff_events com conversation_id, trigger_type, motivo, resumo, urgência, criado_por = ia|humano|sistema, handed_at, first_human_reply_at — trigger_type generalizado no item 6 abaixo).
   - Avisa a responsável: notificação no painel via Realtime e, opcionalmente, mensagem para um número interno configurável com nome do cliente, motivo, resumo de 3 linhas e link da conversa.
   - A IA avisa o cliente com naturalidade que um consultor vai continuar o atendimento. Fora do horário comercial, informa quando ele será atendido.
   - Atualize o prompt/regras de "Transferência para humano" para usar essa ferramenta em vez de createTask.
2. Contatos ignorados (novo, a partir do achado do bot da Yamaha na Fase 0): lista configurável por organização (tela Configurações) de números que o webhook ignora antes de criar conversa, chamar a IA ou gerar tarefa.
   - Nova tabela organization_ignored_contacts (organization_id, phone, label, retention_mode, created_by, created_at).
   - retention_mode tem 2 opções por entrada: "no_store" (não grava nada — nem contato, nem conversa, nem mensagem; resposta 200 imediata no webhook) ou "minimal_record" (grava conversa+mensagem, mas com conteúdo substituído por um placeholder fixo, sem IA, sem tarefa, sem takeover).
   - Verificação entra em apps/api/src/routes/webhooks/evolution.ts logo após identificar a organização (via instance), antes de ensureConversation — vale para mensagens normais e para fromMe.
   - Inclui, como primeira entrada a ser cadastrada após o deploy (não via migration): o contato do bot "Yamaha Serviços Financeiros" identificado na Fase 0.
   - Limpeza do histórico já gravado desse contato (CPFs em texto puro): ação de dados única, fora do código da feature — ver decisão em aberto A abaixo.
3. Saudação não é takeover: mensagens fromMe que forem só saudação ou confirmação curta (lista configurável por organização + limite de caracteres, mais checagem fixa de "só emoji") NÃO ativam is_human_takeover. A mensagem continua sendo salva (role=human_agent, aparece no painel normalmente) e enviada no histórico para a IA, mas o prompt passa a ter uma instrução fixa (nova seção "Notas operacionais", sempre incluída, não editável pelo painel) dizendo à Helena para não repetir a saudação nem tratar isso como novo pedido — só continuar o atendimento de onde parou. Configuração ligada por padrão, desligável por organização.
4. Timeout de takeover: quando o handoff vier de requestHuman, a IA NÃO retoma sozinha após 30 min. Em vez disso, se não houver resposta humana em X min (configurável) dentro do horário comercial, gere um alerta de "handoff sem resposta" no painel.
5. Painel Início: um card "Handoffs aguardando" com o tempo de espera de cada um e, na conversa, um resumo do handoff no topo do painel lateral.
6. Métrica de gatilho (para medir antes/depois): handoff_events (item 1) passa a ser gravado em TODA ativação de takeover, não só via requestHuman — trigger_type = request_human | painel_manual | fromMe_real. Toda vez que uma mensagem fromMe é filtrada pelo item 3 (uma saudação que NÃO virou takeover), grava também um handoff_events com trigger_type = fromMe_greeting_filtered, só quando a conversa não estava em takeover ainda (não registra a cada "Bom dia" de uma conversa já assumida). Isso permite comparar, antes e depois do item 3 entrar no ar, quanto do que hoje aparece como "751 conversas com intervenção humana" era saudação evitável.

FASE 2 — TRIAGEM DE TAREFAS
1. Consolidação: no máximo 1 tarefa aberta de acompanhamento por oportunidade. Novas pendências da mesma oportunidade atualizam a tarefa existente (com evento em task_events) em vez de criar outra.
2. Encerramento automático: tarefas do tipo "aguardando cliente" são fechadas com evento quando o cliente responde e a pendência foi resolvida.
3. Score de prioridade (função pura em packages/shared, testada), baseado em: valor da oportunidade, estágio, dias parado, waiting_on, urgência da qualificação e se é handoff.
4. Nova visão "Hoje" na tela Início: as 10 tarefas/oportunidades de maior score, com botão de ação direta (abrir conversa, concluir, adiar).

FASE 3 — FECHAMENTO DO FUNIL
1. Botões "Vendeu" e "Perdeu" de 1 clique, na conversa e no card do Kanban.
   - Vendeu: modal curto com produto/valor já pré-preenchidos, data e observação opcional. A evidência é gerada automaticamente ("Marcado como ganho por <usuário> em <data>").
   - Perdeu: motivo obrigatório escolhido de um catálogo.
2. Catálogo fechado de motivos de perda (tabela ou enum): preco, credito_negado, comprou_concorrente, sem_resposta, desistiu, adiou_compra, fora_do_perfil, outro (com texto). Mantenha lost_reason_detail em texto livre. Classifique os lost_reason históricos no catálogo e me mostre o mapeamento antes de aplicar.
3. Sugestão de resultado pela IA: ferramenta suggestOutcome(resultado, evidencia) para quando o cliente disser que já comprou, fechou ou desistiu. Ela NÃO fecha a oportunidade, só cria uma sugestão que a atendente confirma com 1 clique.
4. Integração de vendas de consórcio: endpoint autenticado POST /integrations/consorcio-vendas que recebe {cpf, grupo, cota, data_venda, valor_credito}. Ele calcula o hash HMAC do CPF (mesma função usada em conversation_qualifications), encontra a oportunidade aberta do funil Consórcio desse contato e marca como ganha, com evidência "Cota <grupo>/<cota> vendida em <data> (Newcon)". Se não achar oportunidade, registra num log de "vendas sem oportunidade". Esse endpoint vai ser alimentado depois por um robô Python externo que acessa o portal Newcon. Documente o contrato do endpoint.

FASE 4 — MEDIÇÃO
Um relatório simples (tela ou seção no Início) com: handoffs por motivo e tempo médio até a primeira resposta humana; conversão por funil (ganhas/fechadas); motivos de perda; tarefas abertas vs. concluídas por semana.

Ao final de cada fase: rode os testes, faça commit na branch e me mande um resumo do que mudou e do que devo testar no painel.

PROGRESSO

## Fase 0 — Diagnóstico (concluída em 2026-09-28)
Ver docs/diagnostico-fase0.md. Achados principais: 92,7% dos takeovers do mês
começaram por mensagem fromMe curta (majoritariamente saudação avulsa, não o
padrão "8121" — esse é um caso isolado de 1 contato, o bot da Yamaha Serviços
Financeiros, tratado como lead por engano); só 2,2% das tarefas têm
opportunity_id; libera_cred/plan_term_presented concentra 137 oportunidades
paradas.

## Fase 1 — Handoff explícito (concluída em 2026-09-28)

**O que foi feito:**
1. Ferramenta `requestHuman` (packages/agent-runtime/src/tools/request-human.ts):
   ativa is_human_takeover, atribui ao responsável padrão da organização
   (`organizations.settings.default_handoff_assignee_id`), reassina tarefas
   abertas, grava `handoff_events` e opcionalmente notifica um número interno
   (`handoff_notification_phone`) via fila de envio existente. Toggle em
   Agentes → Ferramentas.
2. Contatos ignorados: tabela `organization_ignored_contacts`
   (retention_mode `no_store`/`minimal_record`, padrão `no_store`), checada no
   webhook antes de criar conversa — vale para mensagens do cliente E fromMe
   (a loja consultando o bot). UI em Configurações.
3. Saudação não ativa takeover: `isGreetingOrShortConfirmation`
   (packages/shared) — só filtra combinação exata de palavra configurada (ou
   emoji puro) dentro do limite de caracteres, nunca por tamanho isolado. A
   mensagem continua no histórico; uma seção fixa "Notas operacionais" no
   prompt compilado instrui a Helena a não repetir a saudação. Configurável
   por organização (liga/desliga, lista de palavras, limite), ligado por
   padrão.
4. Timeout diferenciado: `getExpiredTakeovers` agora exclui conversas com
   handoff `request_human` ainda sem resposta — só encerram via resposta
   humana real (`markFirstHumanReply`) ou ficam visíveis como "sem resposta"
   no card do Início após `handoff_unanswered_alert_minutes`.
5. Card "Handoffs aguardando" na tela Início + resumo do handoff no topo do
   painel lateral da conversa.
6. Métrica: `handoff_events.trigger_type` (`request_human`, `painel_manual`,
   `fromMe_real`, `fromMe_greeting_filtered`) gravado nos 3 pontos reais de
   handoff mais no filtro de saudação (só quando evitou um takeover novo).

**Decisões tomadas (conforme aprovado):** retention_mode padrão `no_store`,
válido para fromMe também; instrução de "não repetir saudação" fixa no
código, não configurável; `fromMe_greeting_filtered` só registrado quando
evitou um takeover novo.

**Testes:** TDD nas partes com lógica pura/orquestração — `greeting-filter.ts`,
`prompt-builder.ts` (seção fixa), `request-human.ts`, `registry.ts`,
`getExpiredTakeovers`, `buildPendingHandoffs`, e um teste de integração
dedicado provando que uma saudação filtrada NÃO enfileira `process-message`
nem ativa takeover (verificado also fazendo o teste falhar de propósito antes
de reverter). Suítes completas de shared/database/agent-runtime/api/worker
rodadas — tudo verde, exceto uma falha pré-existente e não relacionada em
`apps/api/src/routes/costs/index.test.ts` (confirmada antes das minhas
alterações, na branch base).

## Ajustes pós-aprovação (2026-09-28)

1. **Limpeza do contato Yamaha — concluída, ponta a ponta.** Apaguei
   `wa_contacts` (o delete fez cascade em `conversations`, `messages`,
   `tasks` e `conversation_qualifications` — as FKs já são `ON DELETE
   CASCADE`); contagens confirmadas em zero para as 5 tabelas. Migrations
   00027/00028 aplicadas em produção via `supabase db push` (2026-09-28, você
   rodou) — tabelas `organization_ignored_contacts` e `handoff_events`
   confirmadas existindo. Contato cadastrado na lista de ignorados: telefone
   `551124316100`, label "Bot Yamaha Serviços Financeiros", `retention_mode
   = no_store` (id `c7d609ec-13c6-407c-ae77-bb60c4c6777c`).
2. **Filtro de saudação — normalização reforçada.** Agora ignora
   maiúsculas/minúsculas, acentos, pontuação e emoji nas bordas (início e
   fim) da mensagem antes de comparar — "Bom dia!", "bom dia 😊", "Boa
   tarde." casam normalmente. Lista padrão ganhou "bom dia tudo bem", "boa
   tarde tudo bem", "boa noite tudo bem", "oi tudo bem", "olá tudo bem" (com
   ou sem vírgula/pontuação, ex. "Bom dia, tudo bem?" também casa). Limite de
   caracteres padrão subiu de 15 para 22 (cobre a frase mais longa da lista)
   e agora é medido no texto já normalizado, não no texto bruto.
3. **Rollout seguro — defaults de cada funcionalidade nova:**
   - Filtro de saudação: `takeover_greeting_filter_enabled` — **desligado por
     padrão** (`DEFAULT_GREETING_FILTER_ENABLED = false`). Sem isso, órgão
     nenhum muda de comportamento até ativar em Configurações.
   - Ferramenta `requestHuman`: `tools_config.request_human` — **desligada
     por padrão** (já seguia o mesmo padrão de `create_task`), por agente, em
     Agentes → Ferramentas.
   - Timeout diferenciado + card "Handoffs aguardando" + alerta de handoff
     sem resposta: não têm chave própria — ficam automaticamente inertes
     enquanto `requestHuman` estiver desligada (não existe handoff
     `request_human` para excluir do timeout ou alertar). Uma vez a
     ferramenta ligada, o alerta usa `handoff_unanswered_alert_minutes`
     (padrão 15 min).
   - Contatos ignorados: tabela vazia por padrão — zero efeito até alguém
     cadastrar um número em Configurações.
   - Métrica `handoff_events` para `painel_manual`/`fromMe_real`: **essa
     parte grava desde o merge**, sem chave — é só leitura/registro (não
     muda nenhum comportamento visível, protegida por try/catch), e é
     proposital: dá a linha de base "antes" para comparar depois de ativar
     as outras.
   - Todos os 3 pontos novos de escrita que dependem das tabelas novas
     (`getIgnoredContact`, o `createHandoffEvent` do filtro de saudação, e
     `getPendingHandoffs` no dashboard) têm fallback: se a tabela não existir
     ainda, o webhook e o painel continuam funcionando normalmente (testado
     com teste dedicado, inclusive fazendo falhar de propósito antes do
     fix).
4. **Pendência registrada, não corrigida agora:** falha pré-existente e não
   relacionada em `apps/api/src/routes/costs/index.test.ts` — mantida como
   está, a corrigir depois, fora do escopo da Fase 1.

## Deploy e ativação em produção (2026-09-28) — concluído

- Migrations aplicadas via `supabase db push` (00026 pendente antiga + 00027 +
  00028). Merge `feat/handoff-e-fechamento-funil` → `main` fast-forward, sem
  conflito, push feito por você. Deploy automático no EasyPanel confirmado
  saudável: `/health` OK, container reiniciado (hostname novo), webhook
  `/webhooks/evolution` processando mensagens reais com `200` nos logs.
- Ativação gradual, na ordem do runbook:
  - **Filtro de saudação:** ligado (`organizations.settings.
    takeover_greeting_filter_enabled = true`). **Validado com dado real de
    produção**, sem precisar de teste manual: às 15:56:28 um humano mandou
    "Boa tarde" numa conversa que não estava em takeover → filtrado
    corretamente (`handoff_events.trigger_type = fromMe_greeting_filtered`,
    sem ativar takeover); 18s depois o mesmo humano mandou uma mensagem com
    conteúdo real → aí sim ativou takeover (`fromMe_real`). Confirma o
    comportamento desenhado ponta a ponta.
  - **`requestHuman`:** ligada e publicada — confirmado em
    `agents.tools_config.request_human = true` na config ao vivo da Helena
    (não só no rascunho).
  - Alerta de handoff sem resposta e card "Handoffs aguardando": ativos
    automaticamente a partir de agora, já que `requestHuman` está ligada.
    **Ainda não testados manualmente** — combinado pular o teste por ora.
  - Contatos ignorados: já tinha o Yamaha cadastrado desde o passo 1.
- **Tudo que foi pedido nesta rodada está em produção e ativo.** Falta só,
  quando você quiser, gerar um handoff de teste via `requestHuman` pra ver o
  card do Início e o painel lateral da conversa na prática.

## Incidente de produção — requestHuman sem resposta (2026-09-28)

Cliente real (conversa `008df306-8b1e-4ff4-8e6d-b8a92fab6288`) perguntou sobre
documentos do consórcio, `requestHuman` foi chamado, e o cliente nunca
recebeu resposta nem a equipe foi avisada. Três correções, branch
`fix/request-human-drops-reply-during-handoff`:

1. **Bug corrigido:** `process-message.ts` descartava a própria resposta do
   `requestHuman` — a checagem de "humano assumiu durante a geração" não
   distinguia o takeover que o próprio `requestHuman` tinha acabado de
   ativar. Nova função pura `shouldDropReplyForTakeover`
   (`packages/shared/src/conversation-helpers.ts`), TDD. Isso afetava **todo**
   handoff via `requestHuman`, não só este caso.
2. **Lacuna fechada:** sem `default_handoff_assignee_id` nem
   `handoff_notification_phone` configurados (caso da organização
   `cf01d00d`), `requestHuman` agora cria uma tarefa de fallback (vinculada à
   oportunidade, igual ao `createTask`) em vez de o handoff ficar invisível.
3. **Descrição do tool ajustada:** removido "coletar/confirmar documentos" —
   isso empurrava a Helena a chamar handoff numa pergunta informativa simples.
   Perguntas informativas agora vão para o FAQ; `requestHuman` fica para
   quando o cliente já quer negociar/aderir/fechar. Validado no Playground
   (pergunta de documentos → FAQ, sem handoff).
4. **FAQ criada em produção, efeito imediato:** `knowledge_faqs`
   (id `77630127-1671-41d9-9b0d-c518c1146269`), agente `3ada5b0a`, pergunta
   "Quais documentos preciso para fazer o consórcio?", exatamente o texto que
   você forneceu.

### Etapa 1 — Deploy do hotfix (2026-09-28) — concluída

- Merge `fix/request-human-drops-reply-during-handoff` → `main`, fast-forward
  limpo (`f30c033..e42a242`), sem conflito. Suíte completa do monorepo
  rodada antes do push — verde (só a falha pré-existente e não relacionada
  de `costs/index.test.ts`).
- Deploy automático confirmado no painel do EasyPanel:
  - `worker`: build 1m47s, `### Success` (18:46:33 UTC), container ativo.
  - `api`: mesmo commit, deploy concluído; `/health` respondendo `200`,
    estável em duas checagens com 20s de intervalo.
  - `web`: também redeployado com o mesmo commit (não inspecionado a fundo,
    não fazia parte do escopo pedido).
- Confirmado no banco: nem `default_handoff_assignee_id` nem
  `handoff_notification_phone` configurados na organização `cf01d00d` — só
  reportado, nada preenchido (o usuário configura pelo painel).

### Investigação — Teste 2 do Playground falhou (2026-09-28) — corrigida, publicada

Depois do hotfix, validação no Playground: Teste 1 (pergunta de documentos)
OK. **Teste 2 falhou** — "Quero fechar o plano de 12x da Factor 150, como
faço?" gerou `updateQualification` + `createTask`, sem chamar `requestHuman`;
a Helena disse ao cliente que a equipe entraria em contato, sem handoff real.

Investigação (sem publicar nada, a pedido):
1. `request_human` confirmado `true` tanto no rascunho (`agent_configs`)
   quanto no publicado (`agents`), mesmo `updated_at` — não era problema de
   habilitação.
2. Causa raiz: o rascunho do prompt nunca menciona `requestHuman` pelo nome —
   três trechos mandavam "criar a tarefa"/"encaminhar (tarefa)" para fechar
   negócio, competindo com (e vencendo) a descrição da ferramenta: a seção
   "MÉTODO COMERCIAL" (vale para todos os produtos), a subseção "Encaminhar
   para a equipe" do playbook LiberaCred, e o playbook de Consórcio (mais
   vago, sem citar nenhuma ferramenta).
3. Reescritos os três trechos no **rascunho apenas** (`agent_configs`, sem
   tocar `agents`) para chamar `requestHuman` (com resumo: modelo, plano,
   valores da tabela, urgência, entrada, parcela confortável, restrição,
   pedido concreto) quando o cliente quer fechar/aderir/negociar ou pedir um
   consultor; `createTask` passou a ficar reservado só para pendências
   futuras (cliente vai mandar algo depois, ou retorno combinado numa data).
4. `updateQualification` no Playground **não grava em tabela real** —
   `playground.service.ts` sempre roda com `sandbox: true`, e
   `registry.ts` troca `updateQualification`/`createTask`/`requestHuman` por
   versões mockadas nesse modo. O badge "REAL" que apareceu era um bug de
   rótulo: `SANDBOXED_TOOL_NAMES` em `agent-runner.ts` só listava
   `createTask`/`sendVehiclePhoto`. Corrigido (branch
   `fix/playground-simulated-tool-label`, PR aberto, TDD) para incluir
   `updateQualification`, `requestHuman` e `sendRegisteredImage`.

Validação: re-testado no Playground (fechar 12x Factor 150 → `requestHuman`;
"quero aderir" → `requestHuman`; FAQ de documentos e pergunta de parcela →
sem handoff). **Rascunho publicado pelo usuário.**

## Fase 2 — Triagem de tarefas (2026-09-28) — implementada, aguardando o passo 4 acima

Plano completo, decisões e fórmula do score em
`docs/plano-fase2-triagem-tarefas.md`. Branch `feat/fase2-triagem-tarefas`.

**O que foi feito:**
1. **Vínculo automático + backfill (item 1):** `createTaskWithDedup` vincula
   `opportunity_id` automaticamente quando o contato tem exatamente 1
   oportunidade aberta (flag `task_auto_link_opportunity_enabled`, desligada
   por padrão). Backfill rodado nas tarefas abertas na hora: **60 de 218
   vinculadas** (as outras 158 não tinham oportunidade aberta para vincular),
   evento `opportunity_auto_linked` gravado em cada uma
   (`packages/database/scripts/backfill-task-opportunity-links.ts`).
2. **Consolidação por oportunidade (item 2):** tarefa guarda uma lista de
   pendências (`tasks.consolidated_pendencies`, migration `00029`) — o tipo
   visível é sempre o de maior prioridade da lista, não o mais recente; uma
   pendência resolvida sai da lista sem fechar a tarefa se sobrar outra.
   Flag `task_consolidation_by_opportunity_enabled`, desligada por padrão.
3. **Encerramento automático (item 3):** `awaiting_customer_cpf`/
   `awaiting_customer_data` fecham (ou saem da lista de pendências) só quando
   o campo mudou nesta chamada **e** existe mensagem do cliente depois da
   criação da tarefa. `awaiting_customer_decision` fica de fora (sem sinal
   estrutural). Flag `task_auto_close_awaiting_customer_enabled`, desligada
   por padrão.
4. **Score de prioridade + visão "Hoje" (item 4):** `computeTaskPriorityScore`
   (pesos em `DEFAULT_TASK_PRIORITY_SCORE_WEIGHTS`, ajustável via
   `organizations.settings.task_priority_score_weights`), endpoint
   `GET /organizations/:id/dashboard/today`, card "Hoje" no Início com abrir
   conversa / concluir / adiar. Sem flag — só leitura.
5. **Retomada do LiberaCred (item 5, opção B):** tarefas de retomada para
   oportunidades paradas em `plan_term_presented` — dia 2 cria, dia 7 escala,
   depois sugere marcar como perdida (nunca automaticamente). Mensagem
   sugerida usa só valores da base de conhecimento, nunca estimados; avisa
   quando a tabela está desatualizada/não encontrada. Limite diário de
   criação (padrão 10), priorizado pelo score. Flag
   `libera_cred_resumption_enabled`, desligada por padrão.
6. **Tudo desligado por padrão**, mesmo padrão da Fase 1 — toggles em
   Configurações → "Fase 2 — Triagem de tarefas".

**Testes:** TDD em toda a lógica pura nova
(`task-consolidation`, `task-priority-score`, `libera-cred-resumption-helpers`,
`task-helpers`), testes de integração no `createTaskWithDedup` (auto-link e
consolidação, com e sem flag), no hook de encerramento automático, no worker
de retomada do LiberaCred e no endpoint `/dashboard/today`. Suíte completa do
monorepo verde (só a falha pré-existente e não relacionada de
`costs/index.test.ts`). `next build` do `apps/web` verificado sem erros —
não validei visualmente no navegador (precisa de login real no Supabase de
produção, que não tenho aqui).

## Deploy e ativação — Fase 2 (2026-09-28) — deployado, ativação pendente

1. **Pré-requisito (concluído):** hotfix mergeado e implantado (Etapa 1
   acima), correção do prompt validada e publicada (investigação acima).
   `feat/fase2-triagem-tarefas` atualizada com a `main` (Etapa 2) e suíte
   completa rodada de novo — verde, só a falha pré-existente e não
   relacionada de `costs/index.test.ts`.
2. **Migration `00029` — aplicada.** Coluna `tasks.consolidated_pendencies
   jsonb NOT NULL DEFAULT '[]'` confirmada em produção via REST (rodada pelo
   usuário no SQL Editor do Supabase, já que o CLI `supabase` não está
   instalado localmente).
3. **Merge `feat/fase2-triagem-tarefas` → `main` — concluído** (commit
   `a2a6231`), push do usuário. Deploy automático no EasyPanel confirmado
   `### Success` nos 3 serviços (`api`, `worker`, `web`).
4. **Saudável — confirmado:**
   - `api`: `/health` estável em 3 checagens (`HTTP 200`).
   - `worker`: logs mostram o container novo processando mensagens reais
     sem erro logo após o deploy (`Processed 1 message(s)... Sent message
     to ...`).
5. **Flags — confirmado desligadas.** Consultado `organizations.settings`
   direto no banco: `task_auto_link_opportunity_enabled`,
   `task_consolidation_by_opportunity_enabled`,
   `task_auto_close_awaiting_customer_enabled` e
   `libera_cred_resumption_enabled` todas ausentes (`null`) na única
   organização em produção — os helpers tratam ausência como desligado.
   Nenhuma automação nova está ativa.
6. **Ativação gradual, uma flag por vez, cada uma em Configurações → "Fase 2 —
   Triagem de tarefas":**
   - A visão "Hoje" no Início já está ativa (sem flag) — dá pra conferir
     antes de ligar qualquer automação.
   - `task_auto_link_opportunity_enabled` — baixo risco, só popula um campo.
   - `task_auto_close_awaiting_customer_enabled` — testar com um cliente que
     já tenha task `awaiting_customer_cpf`/`awaiting_customer_data` aberta.
   - `task_consolidation_by_opportunity_enabled` — muda o comportamento de
     dedup existente; acompanhar as primeiras consolidações antes de deixar
     ligado por padrão em todo lugar.
   - `libera_cred_resumption_enabled` — a mais sensível (regera a sugestão
     de mensagem com IA), mas **não envia nada ao cliente sozinha**: só cria
     ou atualiza a tarefa `libera_cred_resumption` com a mensagem sugerida em
     `description`, para a atendente copiar e enviar manualmente — conferido
     no código (`apps/worker/src/workers/libera-cred-resumption.ts` e
     `libera-cred-resumption-message.ts`), nenhum caminho usa a fila de
     envio. Ainda assim, sugiro ligar por último, com o limite diário baixo
     (ex. 3-5) na primeira semana, e conferir as primeiras tarefas criadas
     antes de subir o limite para o padrão (10).
7. **Backfill:** já rodado (60/60) antes do merge — não precisa rodar de novo
   a menos que você queira revisitar tarefas que ganharam oportunidade aberta
   depois desta data.

**Ativação (2026-09-28):** `task_auto_link_opportunity_enabled` — **ligada**
na organização `cf01d00d`, resto de `organizations.settings` preservado.
Demais flags seguem desligadas.
