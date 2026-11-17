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
- **Ordem:** mais antigo primeiro, com "esperando há X". Mostra 10 por lista e informa o total.
- **Visibilidade:** vendedor só vê o que é dele (mesmo `resolveLeadVisibility` do "Hoje"). **Sem dono** aparece em bloco separado **só para gestor** (`owner`/`admin`) — escolha conservadora minha; o filtro legado `isLeadVisible` deixaria vendedor ver sem dono.
- **Flag** `needs_reply_queue_enabled` (só `true` liga). Desligada (padrão): rota devolve `{enabled:false}` sem consultar o banco e a tela mantém "Tarefas urgentes" como está. Ligada: o painel novo **substitui** "Tarefas urgentes".

## Fica para a etapa seguinte
Botões "Já respondi", "Sem ação necessária" e atalhos de agendar retorno. Regra já decidida: agendar retorno **não** tira da fila uma mensagem ainda sem resposta.

## Custo no banco (aviso de Disk IO do Supabase)
A função lê só conversas com mensagem nos últimos 30 dias (índice `idx_conversations_org_last_msg`) e, por conversa, usa `idx_messages_conversation (conversation_id, created_at)`. Nunca varre `messages` inteira; `p_limit` limita cada lista. A API chama no carregamento da tela inicial (sem polling). Antes de ligar a flag, medir `EXPLAIN (ANALYZE, BUFFERS)` em produção.

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
- 17 + 7 itens aguardam há mais de 7 dias: o topo da lista (mais antigo primeiro) tende a ser backlog antigo, não "agora". Sugestão para decidir no piloto: janela padrão de 7 dias e um rótulo "antigos" à parte.
- Mensagem automática de terceiros (ex.: aviso de ausência de WhatsApp Business/financeira) conta como mensagem do cliente.
- A mediana de 44 min inclui horário fora do expediente.
