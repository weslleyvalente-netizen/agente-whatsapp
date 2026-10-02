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

## Follow-up direto da tarefa (2026-09-29) — implementado, aguardando deploy

Plano completo, decisões (D1-D7) e requisitos adicionais em
`docs/plano-followup-tarefa.md`. Branch `feat/followup-na-tarefa`.

**Bug pré-existente encontrado e corrigido durante o planejamento:** toda
mensagem enviada pelo painel (`/messages/send`) era salva com
`evolution_message_id: null`, então o eco da Evolution (que volta pelo
webhook como `fromMe`) nunca batia com `messageExistsByEvolutionId` e
**duplicava a linha da mensagem** no banco — não afeta o cliente, mas polui
o histórico. Corrigido no worker (`send-message.ts` agora captura o id real
retornado pela Evolution e faz o backfill); o webhook já tratava
corretamente o caso de duplicata (`if (!humanMessage) skip`), só faltava
ter algo pra comparar. Testes de regressão nos três níveis (worker, service,
webhook).

**O que foi feito:**
1. **Sugestão de follow-up por IA:** `generateTaskFollowupSuggestion`
   (`packages/agent-runtime`) — mesmo padrão "nunca inventa dado" do gerador
   do LiberaCred (Fase 2); reaproveita a descrição já gerada para tarefas
   `libera_cred_resumption` na primeira geração; grava `ai_usage_events`
   (fonte `task_followup_suggestion`).
2. **Elegibilidade (D1/D2):** 13 tipos de tarefa elegíveis (fica de fora
   `run_quote`/`update_quote`/`other`); gate por `waiting_on=scheduled_date`
   não vencido (reaproveita `decideFollowupGate` da Fase 2); tarefa sem
   `conversation_id` cai para a conversa aberta do contato
   (`findOpenConversationByContact`), sem criar conversa nova.
3. **Envio (D3/D4):** `sendPanelMessage` extraído de `/messages/send` para
   ser reaproveitado — por padrão o envio **não ativa takeover**
   (configurável por organização); nada é gravado em `handoff_events` (não
   é um handoff de verdade), só `task_events` (`followup_sent`) e a nova
   tabela `task_followup_sends`.
4. **Proteção anti-ban (D5):** intervalo mínimo (padrão 45s) e limite diário
   (padrão 40) contados por `evolution_instance_id`, não por organização —
   uma org pode ter até 3 números.
5. **Limite de regenerações (requisito 3):** `followup_regeneration_count`
   por tarefa, configurável (padrão 5); a primeira geração nunca conta.
6. **Contexto da Helena (requisito 2):** a seção fixa "Notas operacionais"
   do prompt foi generalizada — cobre qualquer mensagem `human_agent` no
   histórico (não só saudação curta), sem precisar marcar a origem da
   mensagem.
7. **Métricas (D7):** endpoint agregado
   `GET /organizations/:id/followups/metrics` (total/original/editado);
   sem página de relatório dedicada — fica para uma Fase de Medição futura.
8. **Painel:** bloco "Follow-up" na tarefa (aba Tarefas e visão "Hoje", que
   agora abre o mesmo painel — D6); card novo em Configurações.
9. **Tudo desligado por padrão** (`task_followup_enabled`), mesmo padrão
   das fases anteriores.

**Migration `00030`** (não aplicada ainda): `tasks.followup_suggested_message`
/ `followup_suggestion_generated_at` / `followup_regeneration_count` /
`followup_pending_message_id` + tabela `task_followup_sends`. Aditiva e
reversível.

**Testes:** TDD em toda a lógica nova — eco duplicado (3 níveis),
elegibilidade, throttle, geração de sugestão, `task-followup.service.ts`,
rotas. Suíte completa do monorepo verde (só a falha pré-existente e não
relacionada de `costs/index.test.ts`). `pnpm build` do `apps/web`
verificado sem erros.

### Reforços de robustez (2026-09-29) — 4 pontos levantados antes do runbook

1. **Corrida do eco (achado: também afeta as mensagens da própria Helena).**
   O eco da Evolution podia chegar pelo webhook antes do backfill do
   `evolution_message_id` — não só no follow-up da tarefa, mas em **toda**
   mensagem de saída, inclusive as respostas normais da IA (`role=agent`,
   salvas via `createMessage` direto em `process-message.ts` e
   `stale-conversation-followup.ts`, fora do `saveMessage`). Sem correção,
   o eco de uma resposta da Helena podia ser gravado como mensagem humana
   nova e ativar takeover em cima da própria conversa da IA. Corrigido no
   webhook (`matchPendingOutboundMessage`): casa o eco por conversa +
   conteúdo (texto) ou conversa + `media_type` (áudio/imagem — o eco não
   traz o texto real, só um placeholder fixo), numa janela de 2 min, mais
   antigo primeiro em caso de empate.
2. **Confirmação de envio.** `sendTaskFollowup` não era síncrono (erro meu
   de design anterior) — só enfileirava e concluía a tarefa na hora, sem
   nenhuma confirmação. Agora: `tasks.followup_pending_message_id` marca um
   envio em voo; espera até 12s pelo backfill do `evolution_message_id`
   (prova de que a Evolution aceitou o envio — não espera o eco, que
   depende de mais um salto de rede). Confirmado → conclui a tarefa. Não
   confirmado → estado "não confirmado" (nunca "falhou"), nada mais é
   escrito. Um clique duplicado ou nova tentativa reconsulta o MESMO envio
   pendente em vez de mandar de novo — cobre duplo clique de graça. Só
   `force` explícito manda uma mensagem nova por cima de um pendente.
   `enqueueSendMessage` ganhou `attempts: 1` para follow-ups da tarefa — o
   retry automático de 3 tentativas do BullMQ (que existe hoje em
   `/messages/send` também, não alterado por instrução sua) poderia
   reenviar de verdade uma mensagem cuja resposta HTTP se perdeu depois de
   já ter sido entregue.
3. **Coordenação com a cadência automática de 1h/23h.** Confirmado em
   produção: `followup_automatico.ativo = true` para a Helena
   (`primeiro_followup_horas: 1`, `segundo_followup_horas: 23`). O
   automático já se protege sozinho contra o follow-up manual (só dispara
   quando a última mensagem da conversa é da própria Helena — extraído e
   testado como `shouldConsiderAutomaticFollowup`). Faltava o caminho
   inverso: antes de enviar pela tarefa, checa o último toque de saída
   (automático ou manual) e quantos toques sem resposta já houve
   (`task_followup_min_hours_since_last_touch`, padrão 4h;
   `task_followup_max_touches_without_reply`, padrão 3 — ao atingir,
   sugere marcar a oportunidade como perdida, não bloqueia
   automaticamente). `force` ignora essas duas checagens, mas nunca o
   limite anti-ban por instância.
4. **Painel:** mostra o último toque (quem, há quanto tempo) e a contagem
   antes de gerar a sugestão; estados bloqueados (`recent_touch`,
   `touch_limit_reached`, `unconfirmed`) mostram aviso específico com botão
   "Confirmar envio mesmo assim".

**Deploy e ativação:** ver runbook completo entregue no chat — migration
00030 pendente (confirmado: é a única), push e merge por você, verificação
de saúde, teste manual específico do Bloco 0 (mudança no envio manual do
painel) com plano de rollback, e ativação gradual das flags.


### Follow-up na tarefa — deploy verificado (2026-09-30)

- Merge `caf6c2d`: implantação confirmada com `Success` nos logs de API,
  worker e web do EasyPanel. API HTTP 200 em 30/09 às 18:01 (Brasília).
- Banco às 18:05 confirma mensagens novas de cliente e respostas da Helena
  com identificador Evolution; estrutura das quatro colunas de tarefas e
  tabela `task_followup_sends` presente.
- `task_followup_enabled` e `task_followup_takeover_on_send` ausentes:
  funcionalidade e takeover desligados por padrão. Auto-link de oportunidade
  permanece ligado. Nenhuma configuração alterada nesta verificação.
- Correção do registro anterior: presença da estrutura não confirma o
  histórico de migrations nem que 00030 seja a única pendente; conferir
  `supabase migration list` antes de futuras aplicações.
- Deploy verificado; teste manual dirigido do Bloco 0, validação funcional
  do follow-up e autorização para ativar continuam pendentes.
- Runbook persistido em `docs/plano-followup-tarefa.md`, incluindo teste do
  Inbox com flag desligada, ativação gradual e rollback dos três serviços.

### Oportunidade detalhada, origem e Gerar outra — 30/09/2026

Implementação local na branch codex/oportunidade-detalhada-followup: card ampliado, ações do funil com evidência, filtros de situação, origem automática Wix/Meta/Instagram orgânico e correção manual, correção de cache/regeneração/erros de sugestão. Migration 00031 preparada para custos de sugestões, não aplicada. Sem push e sem alterações em produção nesta etapa. Plano e runbook em docs/plano-oportunidade-detalhada.md.

### Publicação da oportunidade detalhada — 30/09/2026

Após OK do usuário, publicado 453678e na main. Histórico 00029/00030 reconciliado após conferência, 00031 aplicada pelo CLI; nenhuma migration pendente. API saudável, web publicado, worker iniciado e job periódico observado. Card e confirmação de perda conferidos sem alterar negócio real; Gerar outra validado na tarefa Paulo Da Silva, custo gravado e cota preservada ao reabrir. Nenhum envio ao cliente; flags mantidas. Detalhes e limitações em docs/plano-oportunidade-detalhada.md.

### Descrição da tarefa sempre visível — 30/09/2026

Publicado a784445 após autorização. Deploy web concluído com Success; descrição de Paulo Da Silva confirmada no painel, resumo adicional separado e follow-up preservado. API /health ok. Sem migration, envio ao cliente ou alteração de qualificação.


### Funil operacional da Marina — implementação local (01/10/2026)
- Marina é a vendedora; Mariana é a IA. Branch codex/funil-operacao-marina, baseada na main a784445.
- Coluna operacional Pronto para Marina e indicadores; etapa comercial preservada, mais novos primeiro; card grande com chat lateral e tarefas executáveis.
- Cadência sem tarefa para leads iniciais sem intenção:1h/23h/final48h, flag separada e desligada; registro em mensagens, confirmação antes de avançar e sem retry automático.
- Diagnóstico Andreia: áudio da atendente era [audio], sem transcrição. Correção sob demanda com texto salvo, invalidação da sugestão antiga e erro explícito para mídia indisponível. Não houve alteração desse contato em produção.
- 802 testes, tipos e build web passaram. Dois timeouts em testes antigos na execução paralela desapareceram na repetição integral, sem mudar testes.
- Sem migration/push/ativação. Ambas as flags novas ausentes no banco, portanto desligadas. Runbook: docs/plano-funil-marina.md.
- Perda automática, teto global combinado e limpeza das tarefas antigas continuam pendentes para próximo bloco.


### Publicação do funil operacional — 01/10/2026
- Autorizada pelo usuário; main atualizada por fast-forward e push a ce1db09, sem conflitos ou migration.
- EasyPanel: worker Success às 14:21:40, API às 14:21:52 e web às 14:23:38 (Brasília). API /health OK após troca dos containers.
- Worker novo iniciou cinco consumidores e processou/enviou resposta real; banco confirmou cinco mensagens de clientes e uma da IA após 14:21:40.
- Controles novos observados na interface implantada; sales_workspace_enabled e sales_low_intent_cadence_enabled continuam ausentes/desligadas. Não houve ativação ou mensagem de teste enviada pelo assistente.
- Correção de contexto de áudio disponível no fluxo existente de sugestões. Validação manual de envio/áudio e da visão nova ainda pendente, conforme runbook. Primeiro ativar somente a visão do funil; cadência fica para depois dessa validação.


### Ativação da visão operacional — 01/10/2026
- Autorizada pelo usuário e realizada pelo painel: sales_workspace_enabled=true; sales_low_intent_cadence_enabled permanece ausente/desligada (confirmado no banco).
- Validado no navegador: coluna Pronto para Marina, indicadores de resposta/tarefas, ordem decrescente de criação, card completo com conversa lateral e tarefas vinculadas ao contato e ao negócio. Painel de tarefa abriu com descrição, resumo e controles de follow-up.
- Nenhuma mensagem enviada, tarefa concluída ou etapa comercial alterada durante a validação. Teste real de envio e remoção de handoff após resposta humana ainda pendente.
- Na Sonia, tarefa com data futura permite envio porque waiting_on é null; o bloqueio existente requer waiting_on=scheduled_date, conforme decisão aprovada. Não foi alterado o agendamento ou a qualificação.

### Busca global no funil e controles do card — 01/10/2026
Implementados em codex/busca-funil-whatsapp: busca entre todos os funis e situações, botão Abrir no WhatsApp e Mover para outro funil com motivo/histórico pelo endpoint já existente. Caso Yara: card está ganho em Consórcio/Adesão, oculto pelo filtro Em andamento; diagnóstico sem alterações na cliente. 812 testes e build web passaram. Sem migration/ativação/publicação; instruções em docs/plano-funil-marina.md.


### Publicação da busca e controles do card — 01/10/2026
- Usuário autorizou; fast-forward na main e push de 870c8a4, incluindo registros de deploy/ativação anteriores.
- EasyPanel Success: worker 14:57:31, API 14:57:39, web 14:57:59 (Brasília). API /health OK.
- Validado em produção: busca por (62) 9636-6089 retorna Yara Arcanjo / Consórcio / Ganho / Adesão; card exibe Abrir no WhatsApp com URL do contato e Mover para outro funil. Seletor e motivo exibidos; cancelado sem mudança.
- Nenhuma mensagem enviada ou negócio modificado. Visão operacional permanece ligada, cadência de 1h/23h/48h desligada. Registro salvo localmente sem novo push de documentação para evitar redeploy redundante.


### Planejamento da próxima fase — 01/10/2026
Plano em docs/plano-funil-automatico.md: criação/avanço com evidência, fila A identificar, congelamento com calendário/motivo/tarefa futura transacional e editor unificado. Diagnóstico read-only encontrou 114 contatos com 170 tarefas abertas e nenhum negócio; classificação e apply dependem de aprovação. Migration 00032 somente proposta, sem schema/código/flag/produção alterados. Aguardando aprovação do plano conforme regras de trabalho.


### Funil automático, congelamento e editor completo — implementação local em 01/10/2026
- Branch codex/plano-funil-automatico. Plano aprovado e implementação concluída, com commit local sem push.
- Congelar/reagendar/descongelar com data e motivo, tarefa futura transacional e preservação das outras pendências. Resposta antecipada destaca o card; não descongela. Data operacional retorna à fila no dia combinado; sem envio automático.
- Guardas persistentes nas cadências, sugestões/envios de tarefa, contagens e worker de envio; watermark mantém invalidação de jobs antigos mesmo após descongelar. Envio manual deliberado e respostas novas seguem disponíveis; avisos internos requestHuman preservados.
- Editor único por seção nos dois lápis: condições, resumo, dados do cliente, CPF protegido, responsável/origem; não recupera condições de outro funil.
- Entrada e avanço conservadores por evidência, confirmação de envio para proposta, sem regressão ou reabertura; A identificar para conversa sem negócio e operação desconhecida.
- 840 testes, tipos, build web e testes SQL em banco temporário passaram. Revisão independente: sete achados importantes corrigidos com regressões; nenhum minor pendente.
- Dry-run: 114 contatos com 171 tarefas abertas sem negócio; 55 candidatos preliminares, 59 sem identificação segura. Nenhum apply.
- Histórico remoto inclui 20260930233509_sync_published_agent_name, espelhada exatamente sem reaplicação. Migration nova 20261001194818_sales_opportunity_freeze (timestamp posterior para evitar --include-all/repair), não aplicada.
- Flags sales_auto_pipeline_enabled e sales_opportunity_freeze_enabled confirmadas null/desligadas em produção. CLI Supabase não disponível neste ambiente: migration list final no terminal do usuário antes de db push.
- Publicação, migration e ativação aguardam autorização. Runbook completo e decisões em docs/plano-funil-automatico.md.

### Publicação aprovada — 01/10/2026
Migration sales_opportunity_freeze aplicada com sucesso pelo conector Supabase, versão remota 20261001194818; arquivo local alinhado ao histórico. Flags sales_auto_pipeline_enabled e sales_opportunity_freeze_enabled permanecem ausentes/desligadas. Backfill não aplicado. Publicação e saúde em verificação.

Deploy concluído: main fdb923d. EasyPanel confirmou Success para worker às 19:50:55 UTC, API às 19:51:07 UTC e web às 19:51:31 UTC. API /health ok às 19:51:59 UTC; logs mostram os cinco workers iniciados. Funil carregou e os dois lápis abrem Editar dados do negócio. Flags novas continuam null/desligadas. Após reinício, havia mensagem human_agent registrada, mas ainda nenhuma nova mensagem contact/agent para comprovar resposta orgânica nesta janela. Testes de envio controlado, congelar/descongelar e avanço automático ficam para ativação gradual; nenhum cliente ou tarefa foi alterado durante a verificação.

### Teste após publicação — 01/10/2026, 17:34 BRT
A pedido do usuário: busca no funil por nome e telefone validada; card completo abriu conversa lateral; os dois acessos ao editor foram conferidos sem salvar alterações. API health ok. Harness SQL isolado passou novamente (preservação CPF, idempotência, descongelamento, avanço monotônico e rollback atômico). Flags novas seguem null/desligadas. Banco registra 22 mensagens contact e 54 human_agent após restart, além de 1 agent com evolution_message_id confirmado às 17:18:44 BRT; essa mensagem agent é retomada de conversa antiga, portanto não comprova resposta a uma mensagem nova. Testes reais de congelamento/avanço e envio controlado ainda pendentes de ativação/contato controlado.


### Fila única da Marina no Funil — implementação local (01/10/2026)
- Aprovada a concentração da operação no Funil, respeitando conta compartilhada e preservando todas as tarefas. Branch codex/funil-fila-marina, base de71dcb; sem push, migration ou ativação.
- Fila entre todos os funis: encaminhamentos, respostas, compromissos, pendências e ações; retornos futuros, banco/cliente e silêncio separados. Card grande mantém chat e tarefa executável. Pendências antigas sem negócio aberto ficam acessíveis no próprio Funil.
- Financiamento: Aguardando simulação, análise, aprovado/reprovado; somente humano registra submissão e resultado. Cadastro completo + handoff pendente gera card/tarefa transacional no próximo horário, inclusive com responsável já configurado. Reutiliza tarefa, preserva pendências/prioridade/datas, registra consolidação e não duplica em repetição. Sem perda automática.
- Migration nova 20261002023000_sales_marina_queue.sql apenas preparada. sales_action_queue_enabled e sales_qualified_handoff_task_enabled começam desligadas; criação automática depende de sales_auto_pipeline_enabled. Não há reparo histórico em lote.
- Consulta read-only: 207 tarefas abertas, 147 sem opportunity_id, 71 customer_unresponsive, 143 sem negócio aberto associado. Nenhum registro modificado.
- 856 testes, tipos, build web e SQL transacional local passaram. Flags novas confirmadas ausentes/desligadas em produção. Revisão independente: quatro achados corrigidos, incluindo proteção de resultado na troca de modalidade, cards sem tarefa, pendências consolidadas e painel atualizado após concluir.
- Publicação/ativação e validação visual/controlada pendentes; runbook em docs/runbook-funil-fila-marina.md. Pedro continua caso de reparo histórico a revisar antes de apply; não é lead frio.
