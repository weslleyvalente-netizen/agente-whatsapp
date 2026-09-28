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

**Leitura:** a esmagadora maioria dos takeovers é disparada por mensagem curta enviada direto do celular conectado — não por decisão deliberada de assumir a conversa. Na primeira passada deste diagnóstico eu tinha atribuído boa parte disso a uma sequência recorrente de 4 mensagens (saudação + código + nome + número de 11 dígitos). Investigando a fundo (seção 1.1 abaixo), essa sequência é real, mas **não é o que explica os 92,7%** — é um problema isolado e bem menor, de natureza completamente diferente do que eu tinha suposto. O grosso dos 92,7% continua sendo, como a amostra da seção 2 mostra, saudação avulsa (`Bom dia`/`Boa tarde`) sem relação com essa sequência.

---

## 1.1 Investigação do padrão "saudação + 8121 + nome + número" (a pedido)

Você pediu para eu verificar a hipótese de que esse padrão fosse uma assistente paga desconectada, com um código de protocolo sequencial e um telefone com DDD. **Nenhuma das duas hipóteses se confirmou — a explicação real é uma terceira coisa, e é bem mais simples de resolver.**

### O que é, de fato

Todas as ocorrências desse padrão (198, desde sempre) pertencem a **um único contato** (`wa_contacts.id = 1887f620...`, `name = null`, telefone com DDD 11, **já com `ai_disabled = true`**) espalhado por 6 registros de `conversations` diferentes (a conversa "expira"/fecha e uma nova é aberta para o mesmo contato periodicamente). Não são 6 clientes — é 1 número só.

Lendo o conteúdo das mensagens do lado "cliente" dessas 6 conversas, ele se identifica literalmente como:

> "Boas-vindas ao canal de atendimento digital da **Yamaha Serviços Financeiros**!" / "Esta não é uma resposta válida. Por favor, *Selecione um botão a seguir*"

Ou seja: **esse "contato" é o próprio bot oficial de atendimento por WhatsApp da Yamaha Serviços Financeiros** (um menu de botões/lista, típico de WhatsApp Business API) — não é um cliente, é um sistema de terceiro. Em algum momento alguém da loja (Marina, provavelmente) usou o número conectado da Moto e Trilha para *falar com* esse bot da Yamaha (provavelmente para consultar o status de um financiamento), e como o webhook da Evolution trata qualquer mensagem recebida nesse número como se fosse um lead, o sistema abriu uma "conversa" para esse bot e a Helena (nossa IA) começou a tentar atender o menu de botões da Yamaha como se fosse um cliente confuso — gerando um looping de mensagens automáticas dos dois lados. Isso já foi percebido internamente: **`ai_disabled` está true para esse contato**, e as 7 tarefas que chegaram a ser criadas para ele já estão todas `cancelled`. O que não foi feito é impedir que o número continue gerando novas "conversas".

O padrão de 4 mensagens fromMe (`oi` → `8121` → nome de quem está atendendo → número) é a **atendente navegando manualmente o menu do bot da Yamaha pelo WhatsApp**: reinicia o menu ("oi"), informa um código fixo (provavelmente uma opção de menu ou código de loja/revenda), digita o próprio nome (variações e erros de digitação confirmam que é texto humano, não copiado por um script: `marina`, `marins`, `maria9`, `marioa`, `mm`, `ma`, `mjm`, e uma vez até `weslley valente`) e por fim o número de 11 dígitos — que em várias ocorrências aparece **formatado exatamente como CPF (`XXX.XXX.XXX-XX`)**, e uma vez até como CNPJ (`XX.XXX.XXX/0001-XX`). Isso é o CPF/CNPJ do cliente cujo financiamento está sendo consultado no bot da Yamaha — não um telefone.

### Respostas ponto a ponto

**1) Texto idêntico entre conversas? Código sequencial?**
Sim, a estrutura é sempre a mesma (saudação → texto explicativo → código → nome → texto → número), mudando só o texto livre e o número final (cliente diferente sendo consultado a cada vez). O código **não é sequencial — é sempre exatamente `8121`**, em 100% das 198 ocorrências, de agosto a setembro. Não é protocolo/ticket (que incrementaria); é mais provável que seja uma opção fixa de menu ou um código de loja/revendedor dentro do fluxo do bot da Yamaha.

**2) Intervalo entre as mensagens**
Segundos, não minutos: nas amostras, 3 a 96 segundos entre uma mensagem e a próxima. Isso é consistente com alguém navegando rápido um menu de bot que responde na hora (bot pergunta, humano já sabe a resposta e digita em seguida) — não com digitação de uma frase longa, mas também não é indício de script automatizado nosso (o ritmo varia, tem erro de digitação no nome).

**3) O que o payload da Evolution revela sobre a origem**
Não consegui confirmar por essa via. Dois motivos técnicos:
- O schema Zod que valida o webhook (`evolutionWebhookPayloadSchema` em [packages/shared/src/schemas/evolution.ts](../packages/shared/src/schemas/evolution.ts)) **descarta qualquer campo fora do que está definido** antes mesmo de chegar ao código que salva a mensagem — campos como `source`, `device` ou `participant`, se vierem da Evolution, nunca são persistidos. Só `evolution_message_id` (o `key.id`) fica salvo.
- Tentei consultar a Evolution API diretamente (`/chat/findMessages`, usando a `EVOLUTION_API_KEY` já presente no `.env`) para tentar recuperar o payload bruto, mas a chamada falhou por rede — `EVOLUTION_API_URL` aponta para um host que não é alcançável a partir deste ambiente (provavelmente só acessível de dentro da rede interna do EasyPanel).
- Isso ficou sem importância prática: o **conteúdo** das mensagens (o bot se identificando como "Yamaha Serviços Financeiros", e o `contact_id` sendo o mesmo em todas as 6 conversas) já confirma a origem com certeza, sem precisar do payload bruto.

**4) Data da primeira/última ocorrência e frequência semanal — parou ou continua?**
Primeira ocorrência do código `8121`: **2026-08-07**. Última: **2026-09-25** — 3 dias antes deste diagnóstico. **Continua acontecendo**, sem sinal de parar: 11 a 43 ocorrências por semana nas últimas 8-9 semanas, sem tendência de queda.

| Semana (início) | Ocorrências |
|---|---|
| 2026-08-02 | 11 |
| 2026-08-09 | 43 |
| 2026-08-16 | 36 |
| 2026-08-23 | 22 |
| 2026-08-30 | 31 |
| 2026-09-06 | 18 |
| 2026-09-13 | 14 |
| 2026-09-20 | 19 |

**5) Em quantas das 648 conversas o takeover veio dessa sequência? Quantas tiveram mensagem humana real depois?**
**Nenhuma.** O padrão nunca aparece como a mensagem que *inicia* um episódio de takeover — ele sempre acontece dentro de uma conversa que já estava em modo humano por outro motivo (geralmente a IA já havia travado tentando responder ao menu de botões do bot da Yamaha, o que por si só é considerado handoff automático). E, à parte do gatilho: das 6 conversas totais afetadas por esse padrão (todas do mesmo contato-bot), **nenhuma teve uma resposta humana real** depois — porque não há um "cliente real" do outro lado para responder. Esse achado específico é irrelevante para os 92,7% da seção 1: ele nunca funcionou como gatilho de takeover para nenhuma conversa real de cliente.

**6) Reclassificação da amostra de 40 e recorte de período**
Nenhuma das 40 conversas amostradas na seção 2 pertence a esse contato-bot — conferi cruzando os IDs. **A classificação original (7 negociação real / 32 sem necessidade aparente / 1 outro) continua válida sem alteração.** Como a sequência não parou (ainda ocorre hoje), também não há um "período posterior" para recalcular a seção 1 — os números de lá (92,7%) já refletem o período todo e não precisam de ajuste por causa desse achado.

### Custo real do problema (achado à parte, vale corrigir)

Embora irrelevante para a métrica de takeover, esse contato-bot gerou **755 mensagens da IA (`role=agent`)** ao longo de 2 conversas só em 2 dias (5 e 7/ago) tentando atender o menu automatizado da Yamaha como se fosse um cliente confuso — custo de API real e desperdiçado. `ai_disabled` já foi ativado para esse contato e as 7 tarefas criadas já foram canceladas, ou seja, **alguém da equipe já percebeu e limpou manualmente uma vez** — mas o número continua gerando novas linhas em `conversations` (a mais recente está `status = open`, de 14 a 25/set). Vale, fora do escopo das Fases 1-4, considerar impedir que esse contato específico volte a abrir conversa nova (ou identificar e bloquear automaticamente números de canais automatizados de terceiros).

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

**Registro para a Fase 2 (decisão de design a confirmar com você antes de codar):** como só 2,2% das tarefas têm `opportunity_id`, a regra "no máximo 1 tarefa aberta por oportunidade" da Fase 2 item 1, se implementada só por `opportunity_id`, vai deixar de fora quase toda tarefa que existe hoje. A consolidação vai precisar agrupar por **contato+tipo** (que é o padrão dominante e já usado por `getOpenTaskByContactAndType`/`createTaskWithDedup`) como caminho principal, tratando o agrupamento por `opportunity_id` como um caso adicional para quando o vínculo existir — ou, alternativamente, aproveitar a Fase 2 para popular `opportunity_id` de forma mais consistente ao criar tarefas ligadas a uma negociação já aberta. Fica como decisão em aberto para o plano da Fase 2.

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

**Prioridade de follow-up:** `libera_cred/plan_term_presented` é isoladamente o maior gargalo — **137 oportunidades** (quase 1 em cada 3 abertas) travadas exatamente no ponto em que o plano já foi apresentado e falta só a decisão do cliente. É o estágio de maior volume parado e o mais barato de destravar (não depende de terceiro — banco, administradora — só de retomar contato), então deve ser o primeiro alvo real do score de prioridade da Fase 2 e de qualquer ação de reengajamento antes mesmo da Fase 2 estar pronta.

---

## Como isso deve calibrar a Fase 1–2 (para sua decisão, nada aplicado ainda)

- O achado nº 1 é o mais forte sinal para a Fase 1, item 2 (não ativar takeover por `fromMe` curto): quase toda conversa "assumida" no mês começou por uma mensagem trivial, não por decisão real de assumir — e a amostra da seção 2 confirma que na prática é quase sempre uma saudação avulsa ("Bom dia"/"Boa tarde"), não o padrão "8121" (que é um problema à parte, de 1 contato só — ver seção 1.1).
- O achado nº 3 (tarefas quase todas por contato, não por oportunidade) muda a lente da Fase 2, item 1: a consolidação "1 tarefa aberta por oportunidade" só vai valer para os 2,2% dos casos que já têm `opportunity_id` — a regra vai precisar agrupar por contato+tipo como caminho principal (ver nota na seção 3).
- O achado nº 4 aponta 3 estágios concretos para o score de prioridade da Fase 2, item 3, testar primeiro — com `libera_cred/plan_term_presented` (137 paradas) como prioridade nº 1, à frente de `consortium/qualification` (109) e `financing/documentation` (81).
- Achado à parte (seção 1.1): o contato-bot da Yamaha Serviços Financeiros já tem `ai_disabled=true` e as tarefas que gerou já foram canceladas, mas continua abrindo conversas novas (a mais recente, aberta) — vale decidir separadamente se isso entra no escopo de alguma fase ou fica para depois.

Aguardando sua avaliação antes de seguir para o plano da Fase 1.
