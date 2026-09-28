# Diagnóstico Fase 0 — Handoff e Fechamento do Funil

> Consultado direto no banco de produção (Supabase, via REST com a service role key já configurada em `.env`), somente leitura, sem alteração de dados. Janela: últimos 30 dias (a partir de 2026-09-28). Nenhum dado pessoal (nome, telefone, CPF) é reproduzido abaixo — exemplos são anonimizados/parafraseados.
>
> Organização única em produção: 1 org (`Weslley Valente`), single-tenant de fato — confirma a nota da seção 12 do `RESUMO_PROJETO.md`.

---

## 1. Takeover disparado por mensagem `fromMe` curta

**Metodologia:** como não existe hoje uma tabela de "episódios de takeover" (é exatamente o que `handoff_events` da Fase 1 resolveria), reconstruí os episódios a partir de `messages`: um episódio de takeover começa numa mensagem `role=human_agent` cuja mensagem anterior na mesma conversa **não** é `human_agent` (ou é a primeira mensagem da conversa). "fromMe" = mensagens que chegaram pelo webhook da Evolution com `evolution_message_id` preenchido (distingue de resposta digitada no painel, que sempre salva `evolution_message_id = null`). "Curta" = conteúdo com ≤ 15 caracteres, ou só emoji.

| Métrica | Valor |
|---|---|
| Conversas com pelo menos 1 mensagem humana nos últimos 30 dias | 751 |
| Conversas com **início** de episódio de takeover na janela | 699 |
| Total de episódios de takeover na janela (uma conversa pode reabrir várias vezes) | 2.842 |
| Episódios cujo gatilho é `fromMe` + curto | 1.864 (65,6% dos episódios) |
| **Conversas em que pelo menos 1 episódio começou por `fromMe` curto** | **648 de 699 (92,7%)** |

**Leitura:** a esmagadora maioria dos takeovers é disparada por mensagem curta enviada direto do celular conectado — não por decisão deliberada de assumir a conversa. Isso é agravado por um padrão que apareceu muito na amostra: sequências repetidas de **saudação (`Bom dia`/`Boa tarde`) + um código curto + o nome da atendente + um número de 11 dígitos (formato compatível com CPF)**, mandadas direto pelo WhatsApp (fora do painel) para dezenas de conversas diferentes — parece um fluxo manual de verificação/repasse de documento que roda por fora do sistema. Vale investigar o que é esse fluxo separadamente: se for envio de CPF em texto puro pelo WhatsApp, é um risco de exposição de dado sensível (diferente do CPF que fica criptografado em `conversation_qualifications`).

---

## 2. Amostra de 40 conversas com takeover — motivo provável

Amostra determinística (seed fixa) de 40 conversas dentre as 699 com início de episódio na janela, olhando as ~4 mensagens antes do gatilho para inferir o motivo.

| Motivo provável | Contagem | Exemplo anonimizado |
|---|---|---|
| (a) IA errou ou travou | 0 | Não observado nesta amostra |
| (b) Cliente pediu humano | 0 | Não observado nesta amostra |
| (c) Negociação real (desconto, proposta, documentos) | 7 (17,5%) | Cliente já negociando modelo/prazo com a IA; humano escreve direto "vamos prosseguir com a compra do [modelo], temos pronta entrega" — cliente responde que a parcela ficou pesada e vai aguardar |
| (d) Humano entrou sem necessidade aparente | 32 (80%) | IA já havia respondido tudo e nada pendia do cliente; humano manda só "Bom dia"/"Boa tarde" para a conversa, sem pedido novo — interrompe o atendimento automático sem motivo visível na própria mensagem |
| (e) Outro | 1 (2,5%) | Humano responde com um áudio (conteúdo não identificável só pelo texto) durante um follow-up de análise em andamento |

**Leitura:** isso é consistente com a seção 1 — na prática, a maior parte das "751 conversas com intervenção humana" não é escalonamento por necessidade, é a atendente mandando uma saudação avulsa direto pelo celular (provavelmente hábito de relacionamento/prospecção) que, pelas regras atuais, derruba o atendimento automático daquela conversa. Nenhum caso de "IA travou" ou "cliente pediu humano" apareceu nesta amostra de 40 — não significa que não existam no total, mas indica que são uma fração pequena frente ao padrão dominante.

---

## 3. Distribuição das 1.384 tarefas

| Tipo | Qtde |
|---|---|
| customer_unresponsive | 389 |
| return_customer | 251 |
| stalled_negotiation | 246 |
| consortium_followup | 169 |
| financing_followup | 78 |
| run_quote | 75 |
| vehicle_followup | 55 |
| other | 54 |
| proposal_followup | 30 |
| scheduled_callback | 15 |
| awaiting_customer_cpf | 15 |
| awaiting_customer_data | 3 |
| awaiting_customer_decision | 3 |
| request_documents | 1 |

| Status | Qtde |
|---|---|
| completed | 1.093 |
| pending | 137 |
| cancelled | 99 |
| in_progress | 55 |
| **Abertas (pending+in_progress+rescheduled)** | **192** |
| **Concluídas/canceladas** | **1.192** |

| Vínculo | Valor |
|---|---|
| Tarefas ligadas a alguma `opportunity_id` | 30 (2,2% do total) |
| Oportunidades distintas com pelo menos 1 tarefa | 21 — média 1,43 tarefa/oportunidade, máx. 3 |
| Contatos distintos com pelo menos 1 tarefa | 601 — média 2,3 tarefas/contato, máx. 11 |

**Leitura:** quase toda tarefa hoje é amarrada a **contato**, não a **oportunidade** (só 2,2% tem `opportunity_id`) — a regra da Fase 2 de "no máximo 1 tarefa aberta por oportunidade" vai precisar lidar com esse gap, porque a maior parte da dedup hoje já acontece por contato+tipo, não por oportunidade. 601 contatos geraram 1.384 tarefas no mês (2,3 em média, até 11 para um único contato) — head de tarefas por contato é candidato natural para a visão "Hoje" da Fase 2.

---

## 4. Onde as oportunidades estão paradas

446 oportunidades abertas no total (histórico, não só as 304 criadas no mês).

| Funil / Estágio | Qtde abertas |
|---|---|
| libera_cred / plan_term_presented | 137 |
| consortium / qualification | 109 |
| financing / documentation | 81 |
| libera_cred / decision_objections | 46 |
| vehicle_sale / interest_received | 22 |
| consortium / simulation_sent | 12 |
| contemplated_letter / compatible_letter_search | 11 |
| financing / qualification | 7 |
| vehicle_sale / negotiation | 5 |
| libera_cred / interest_received | 4 |
| consortium / decision_negotiation | 4 |
| libera_cred / qualification | 3 |
| consortium / interest_received | 2 |
| financing / negotiation | 1 |
| consortium / decision_objections | 1 |
| financing / interest_received | 1 |

| Dias desde o último progresso (`last_progress_at`, com fallback para `last_interaction_at`/`created_at`) | Qtde |
|---|---|
| < 7 dias | 119 |
| 7–14 dias | 158 |
| 14–30 dias | 147 |
| 30–60 dias | 22 |
| > 60 dias | 0 |

**Leitura:** 68% das oportunidades abertas (305 de 446) estão paradas entre 7 e 30 dias, concentradas em 3 estágios: `libera_cred/plan_term_presented` (137 — plano apresentado, cliente não decidiu), `consortium/qualification` (109 — ainda qualificando) e `financing/documentation` (81 — aguardando documentação). Nenhuma opportunity passou de 60 dias sem progresso — coerente com o funil ser recente (backfill feito há pouco tempo, por RESUMO_PROJETO seção 11).

---

## Como isso deve calibrar a Fase 1–2 (para sua decisão, nada aplicado ainda)

- O achado nº 1 é o mais forte sinal para a Fase 1, item 2 (não ativar takeover por `fromMe` curto): quase toda conversa "assumida" no mês começou por uma mensagem trivial, não por decisão real de assumir. Mas o padrão observado (saudação + código + nome + número de 11 dígitos) sugere que o problema não é só "confirmação de 1 palavra" — é um fluxo manual inteiro rodando fora do painel que vale entender antes de definir a lista/limite configurável.
- O achado nº 3 (tarefas quase todas por contato, não por oportunidade) muda a lente da Fase 2, item 1: a consolidação "1 tarefa aberta por oportunidade" só vai valer para os 2,2% dos casos que já têm `opportunity_id` — pode fazer sentido estender a mesma regra para contato+tipo, que é o padrão dominante hoje.
- O achado nº 4 aponta 3 estágios concretos para o score de prioridade da Fase 2, item 3, testar primeiro: `libera_cred/plan_term_presented`, `consortium/qualification`, `financing/documentation`.

Aguardando sua avaliação antes de seguir para o plano da Fase 1.
