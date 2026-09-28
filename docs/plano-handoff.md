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

1. **Limpeza do contato Yamaha — concluída.** Apaguei `wa_contacts` (o delete
   fez cascade em `conversations`, `messages`, `tasks` e
   `conversation_qualifications` — as FKs já são `ON DELETE CASCADE`).
   Contagens confirmadas em zero para as 5 tabelas depois do delete.
   **Pendente:** cadastrar o contato na lista de ignorados via SQL depende de
   (a) a migration 00027 estar aplicada e (b) eu ter o telefone completo — eu
   só exibi ele mascarado (`5511****00`) nos relatórios anteriores e nunca
   salvei o valor completo em lugar nenhum, e a linha original já foi
   apagada. Preciso que você me passe o número (ou eu não consigo recriá-lo).
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
