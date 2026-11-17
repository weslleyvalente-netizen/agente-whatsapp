# "Precisam de resposta" — primeira versão (flag desligada)

Tela inicial do CRM, duas listas curtas para Marina e Márcio verem quem precisa de atendimento agora:
**Cliente aguardando resposta** e **Lead sem primeiro atendimento**. Somente leitura. Não altera dono, rodízio nem dados.

## Regras (uma só, usada pela API e pelo baseline)
Código: `packages/shared/src/attention-queue.ts` (regra pura) + `supabase/migrations/20261117120000_attention_queue.sql` (leitura).

- **Atendimento humano** = mensagem `human_agent` que chegou a enviar. Resposta da IA (`agent`, inclusive `automatic_followup`) e `system` **não contam**. Mensagem humana com `metadata.send_failed_at` **não conta**.
- **Sai da fila** quando existe resposta humana **posterior** à mensagem do cliente. A espera conta desde a primeira mensagem do cliente sem resposta.
- **Funciona sem takeover, sem tarefa e sem negócio.** Conversa com dono (`assigned_to`) entra sempre; sem dono só entra com takeover ligado (sem dono e sem takeover é conversa da IA).
- **Cortesia** (reaproveita `isSubstantiveCustomerMessage`): "obrigado/ok/👍" depois de um atendimento **não** reabre a fila; pedido novo (pergunta, número, áudio, frase com conteúdo) reabre. Sem atendimento anterior, qualquer mensagem sem resposta conta.
- **Lead sem primeiro atendimento** = `lead_assignments` pendente sem `first_human_message_at` (ou exceção não resolvida), e sem resposta humana enviada depois da atribuição.
- **Mesmo cliente nas duas listas** aparece uma vez, em "aguardando resposta".
- **Ordem:** primeiro os casos de **até 7 dias**, do mais antigo ao mais recente, com "esperando há X" (10 por lista, com o total). Os de **mais de 7 dias** ficam numa seção recolhível **"Mais de 7 dias"** (fechada por padrão), com contador e a lista (até 50, mesma ordem). A **janela total continua de 30 dias** e a regra é a mesma da linha de base: total de comparação = até 7 dias + mais de 7 dias.
- **Visibilidade:** vendedor só vê o que é dele (mesmo `resolveLeadVisibility` do "Hoje"); o filtro é aplicado **no banco** (`p_owner`), então o vendedor também lê menos. **Sem dono** aparece em bloco separado **só para gestor** (`owner`/`admin`), decisão confirmada pelo dono.
- **Flag** `needs_reply_queue_enabled` (só `true` liga). Desligada (padrão): rota devolve `{enabled:false}` sem consultar o banco e a tela mantém "Tarefas urgentes" como está. Ligada: o painel novo **substitui** "Tarefas urgentes".

## Fica para a etapa seguinte
Botões "Já respondi", "Sem ação necessária" e atalhos de agendar retorno. Regra já decidida: agendar retorno **não** tira da fila uma mensagem ainda sem resposta.

## Validação em PostgreSQL 17 isolado (dados sintéticos; nenhuma consulta em produção)
Script: `packages/database/scripts/attention-queue-pg17-validation.mjs` (PostgreSQL 17.11 descartável via `embedded-postgres`, esquema = as 64 migrações do repositório; banco e pasta de dados apagados no fim). Relatório bruto: `assets/2026-11-17-precisam-de-resposta-validacao-pg17.json`.

**Migração:** aplica sem erro; reaplicação idempotente; só `service_role` executa (`anon`/`authenticated` não); `DROP FUNCTION` remove; o esquema (colunas, índices, policies, gatilhos, nº de linhas) é **idêntico** antes, depois e após o rollback.

**Correção em volume:** oráculo por força bruta (janelas sobre todas as mensagens) × função devolvem **o mesmo conjunto** (447 casos em 3 mil conversas; 4.785 em 30 mil).

**Leituras da consulta (estatísticas exatas do PostgreSQL por execução; 0 varreduras sequenciais em `messages`; índice usado em `messages`: `idx_messages_conversation`):**

| Cenário | Escala | Linhas de `messages` lidas | Mediana (5 execuções) |
|---|---|---|---|
| Gestor (`p_owner` nulo) | 3 mil conversas / 125 mil mensagens | 34.329 | 12 ms |
| Vendedor (`p_owner` = dono) | idem | 15.345 / 15.490 | 8 ms |
| Gestor | 30 mil conversas / 1,29 milhão de mensagens (stress, ~10x) | 398.802 | 136 ms |
| Vendedor | idem | 171.243 / 171.665 | 51–53 ms |

Outros índices usados: `conversations_pkey` e `wa_contacts_pkey` (junções). `conversations` e `lead_assignments` são lidas por varredura sequencial (tabelas pequenas; a seletividade da janela de 30 dias é alta). A escala menor tem mais mensagens por 7 dias (17 mil) e mais leads pendentes (33) que os proxies conhecidos de produção (806 episódios/7 d, 25 leads), então é conservadora; o volume real de `messages` em produção **não foi medido** (sem consultas pesadas nesta etapa).

**Depois do `/dashboard/summary` (mesmas consultas, `max-rows` padrão 1000 do PostgREST — não verifiquei a configuração do projeto):** o resumo lê 1.000 linhas de mensagens dos últimos 7 dias + 1 por conversa em takeover, e varre `conversations` três vezes (statuses, takeover, handoffs). **A rota nova NÃO duplica essas leituras de mensagens: ela acrescenta leituras novas** (34 mil / 15 mil no volume menor). O que se repete: a linha de `organizations` (resumo, hoje e esta rota leem) e `sales_reps` (hoje e esta rota, só gestor); mais uma varredura de `conversations`.

**Experimento opcional (só no banco descartável, NÃO está na migração):** índice `messages(conversation_id, role, created_at)` reduz a leitura de `messages` para 10.627 / 4.906 (volume menor) e 120.651 / 54.418 (stress) — cerca de 3x menos. Criar índice em `messages` em produção exigiria `CREATE INDEX CONCURRENTLY` e autorização própria, com o Disk IO já pressionado. Outras opções sem índice: cache curto por organização/vendedor na API (custa frescor da fila) ou janela menor que 30 dias (mudaria a linha de base). Decisão do dono antes de ligar a flag.

## Custo no banco (aviso de Disk IO do Supabase)
A função lê só conversas com mensagem nos últimos 30 dias (índice `idx_conversations_org_last_msg`) e, por conversa, usa `idx_messages_conversation (conversation_id, created_at)`. Nunca varre `messages` inteira; `p_limit` limita cada lista. A API chama no carregamento da tela inicial (sem polling). Em produção, nada foi medido nesta etapa; ver a validação acima.

## Linha de base (produção, só leitura, 2026-11-17 ~08:55 BRT)
Calculada pela **mesma regra** (consulta idêntica à função + o código compilado de `buildAttentionQueue`), janela de 30 dias. Contagens apenas; nenhum dado de cliente neste arquivo.

| | Marina | Márcio | Sem dono (gestor) |
|---|---|---|---|
| Cliente aguardando resposta (total) | 31 | 19 | 1 |
| …há mais de 1 hora | 31 | 19 | 1 |
| …há mais de 24 horas | 26 | 14 | 1 |
| …há mais de 7 dias | 17 | 7 | 1 |
| Lead sem primeiro atendimento (total) | 12 | 7 | 1 |
| …há mais de 24 horas | 11 | 5 | 0 |

Linhas brutas da consulta: 122 (97 aguardando + 25 leads). A regra de cortesia removeu 46 das 97 "aguardando" (só havia "ok/obrigado/bom dia" depois de atendimento).

**Tempo até a resposta humana** (últimos 7 dias, conversas com dono ou takeover; cada "episódio" é uma rajada de mensagens do cliente depois de mensagem nossa): 806 episódios; 726 respondidos por humano (90%), 80 sem resposta; **mediana 44 min**, **p90 862 min (14,4 h)**; **378 (47%) respondidos em até 1 h**.

Como comparar depois do piloto: repetir as duas consultas no mesmo dia da semana. Metas de leitura: queda de "aguardando há mais de 1 hora" (hoje 50 nos dois vendedores) e de leads sem atendimento há mais de 24 h (hoje 16), e aumento do % respondido em até 1 h (hoje 47%).

## Ressalvas
- 17 + 7 itens aguardam há mais de 7 dias: agora ficam na seção recolhível "Mais de 7 dias", e a lista principal mostra só os de até 7 dias.
- Mensagem automática de terceiros (ex.: aviso de ausência de WhatsApp Business/financeira) conta como mensagem do cliente.
- A mediana de 44 min inclui horário fora do expediente.

## Piloto por usuário, janela de 30 dias nas duas categorias e limites (17/11, após a medição de carga)
- **Piloto por usuário.** `organizations.settings.needs_reply_queue_user_ids` (lista de ids de usuário). A fila só liga com `needs_reply_queue_enabled === true` **e** o usuário na lista; ausente/vazia/inválida = ninguém (ligar só a flag não libera a organização). Autoridade no backend (`isNeedsReplyQueueEnabledFor` em `packages/shared`, usada na rota): quem está fora recebe `{enabled:false}` mesmo chamando o endpoint direto, sem consultar a fila nem os vendedores. Vale para todos os papéis (gestor fora da lista também fica de fora). Não muda permissões gerais, dono nem rodízio.
- **Sem chamada à toa.** A tela inicial usa `loadNeedsReply` (`apps/web/src/lib/needs-reply-loader.ts`): flag desligada ou usuário fora do piloto = nenhuma chamada a `/dashboard/needs-reply`. Dentro do piloto continua 1 chamada por montagem da tela (inclusive ao voltar de uma conversa, que tira o caso da fila depois da resposta humana). Sem polling, sem ouvinte de foco.
- **Janela de 30 dias nas duas categorias.** O ramo `new_lead` não aplicava `p_since`; agora exige `la.handoff_at >= p_since` (a espera exibida conta desde `handoff_at`). Regra comercial inalterada.
- **Limites e contadores.** A função devolve `kind_total` (`count(*) OVER ()` antes do `LIMIT`). A API pede até 500 por categoria e responde `truncated: true` quando recebeu menos linhas que o total; a tela avisa "Lista parcial" e os números passam a ser o mínimo (o banco devolve os mais antigos primeiro). Com `truncated: false` os contadores são exatos.
- **Testes novos:** shared (piloto, truncada), banco/PGlite (atribuição antiga pendente e exceção, limite de 30 dias, `kind_total` com corte e sem contar antigas; os dois novos de janela falham sem a correção), API (usuário fora da lista direto no endpoint, gestor fora, flag sem lista, lista sem flag, `truncated`), web (loader sem chamada fora do piloto, 1 chamada por montagem; aviso de lista parcial). Revalidado em PostgreSQL 17 isolado (3 mil e 30 mil conversas): migração idempotente, rollback, esquema idêntico, privilégios e oráculo de força bruta iguais à função.
- **Leitura de catálogo em produção:** `2026-11-17-catalogo-producao-leitura.sql` (somente metadados; sem SELECT nas tabelas, COUNT, EXPLAIN ANALYZE ou DDL).
