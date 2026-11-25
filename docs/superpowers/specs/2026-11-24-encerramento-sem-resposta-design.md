# Encerramento automático após 3 follow-ups sem resposta — design

Data: 24/11/2026. Status: aprovado com ajustes em 25/11.

## Por quê

Leads que não respondem ficam abertos indefinidamente: hoje a vendedora encerra à mão (ex.: conversa 2acaf16c, 24/11 15:02 —
despedida enviada e negócio marcado perdido "sem_resposta"). Nos últimos 45 dias: 16 conversas com 3+ follow-ups sem resposta,
63 com 2, 234 com 1. O dono quer que, depois de 3 follow-ups sem resposta, a IA mande a despedida e dê o lead como perdido sozinha.

## O que já existe

- Cadência de baixa intenção (`sales_low_intent_cadence_enabled`, ligada desde 20/10): 2 follow-ups + despedida
  (`sales_low_intent_closing_message`). Só vale para conversas atendidas só pela IA, sem valores, e **não** marca o negócio perdido.
- `markLost` (opportunity.service) grava status `lost`, `lost_reason` e o evento com evidência.

## Decisões do dono (24/11)

1. **Alcance:** todas as conversas, inclusive com vendedor, **exceto negociação** (proposta/valor ou etapa avançada).
2. **Contagem:** qualquer insistência — mensagens da IA ou do vendedor; cada dia com envio conta 1 (várias no mesmo dia = 1).
3. **Espera:** 24 h depois do 3º follow-up, só em horário comercial.
4. **Atrasados:** aplicar também nas conversas que já estão com 3+ follow-ups (espaçadas, sem rajada).

## Regra

Uma conversa é **elegível** quando, depois da última mensagem do cliente (ou desde o início, se ele nunca respondeu):

- a última mensagem da conversa é nossa (IA ou vendedor);
- há envios nossos em **4 ou mais dias distintos** (horário de Brasília): o dia da resposta + 3 dias de follow-up;
- o último envio tem **24 h ou mais**;
- ainda não houve despedida depois da última mensagem do cliente (nem desta rotina, nem da cadência de baixa intenção,
  nem do lote de anúncios, nem a mandada à mão com "encerrar").

**Fica de fora** (nada é enviado):

- negócio aberto em etapa diferente de `interest_received`/`qualification`, ou com `sale_amount`/`credit_amount` > 0;
- proposta registrada (`proposal_followups`) depois da última mensagem do cliente;
- tarefa aberta com data futura na conversa (o vendedor marcou um retorno);
- contato congelado, ignorado ou com IA desligada; grupos;
- conversa sem instância de WhatsApp.

Negociação parada **não** é encerrada: continua com o alerta de negociação parada que já existe (nada novo).

## Ação

1. Envia a mesma despedida da cadência (`sales_low_intent_closing_message`) como mensagem da IA, com
   `metadata.no_reply_closure` (data e contagem de follow-ups). Tentativa única, nunca reenvia sozinho (mesmo padrão da cadência).
2. Só **depois do envio confirmado**: marca como perdido cada negócio aberto do contato que passou no filtro —
   `lost_reason = 'sem_resposta'`, evidência "Encerramento automático: N follow-ups sem resposta (último em DD/MM)", autor IA.
3. Cancela as tarefas automáticas de "cliente parou de responder" da conversa. Tarefas criadas pelo vendedor ficam como estão.
4. Todas as rotinas de follow-up passam a pular a conversa enquanto a última mensagem for uma despedida. Se o cliente
   responder, a conversa volta ao normal (o negócio perdido pode ser reaberto pelo vendedor, como hoje).

A cadência de baixa intenção também passa a marcar o negócio perdido depois da despedida dela (mesmo passo 2), para as duas
saídas terminarem igual.

## Ritmo e segurança

- Flag `no_reply_closure_enabled` (desligada por padrão) e `no_reply_closure_wait_hours` (24).
- Roda no ciclo de 15 min já existente; só envia em horário comercial (8h–20h).
- No máximo 1 despedida a cada 15 min por instância e dentro do limite diário que já existe (40), então os atrasados saem aos poucos.
- Antes de ligar: prévia somente leitura com a lista de quem receberia, para o dono conferir.

## Fora do escopo

- Descobrir o número real de contatos `@lid` (assunto separado).
- Mudar a cadência de baixa intenção além do passo 2.
- Encerrar negociações.

## Parte 2 — Novo negócio para cliente que volta (decisões do dono 25/11, design aprovado com ajustes)

Hoje `_contact_has_deal_history` impede qualquer card novo para quem já teve negócio fechado (ex.: Rosângela, Bruno).
Com o encerramento automático, isso vai piorar. Nova regra:

- **O que decide é a intenção comercial atual**, não o motivo do fechamento anterior (perdido por qualquer motivo ou ganho).
- **Classificação pelo contexto da conversa**: a IA lê as últimas mensagens (até 40, 14 dias) + o resumo do gatilho e classifica
  `commercial` / `administrative` / `unclear`. O `motivo` do handoff não separa (quase tudo vem `fora_do_escopo`) e o resumo engana
  (Clemilson: resumo parecia recompra, a conversa mostra pedido de troca do que já comprou = pós-venda).
  Respostas automáticas (WhatsApp Business, robôs) são filtradas antes do modelo. Erro do modelo => `unclear`.
- **Incerta não cria**, mas fica em `returning_customer_decisions` (outcome `needs_review`) e, no modo escrita, vira pendência
  "confirmar se é nova negociação" para o vendedor (tarefa `other`, consolidada com as existentes).
- **Gatilho**: encaminhamento para humano **ou** tarefa comercial criada pela IA (o Bruno só gerou tarefa, sem encaminhamento).
- **Identidade**: telefone (com/sem 55 e nono dígito) + vínculo @lid (`metadata.lid`, `merged_into`) formam um grupo
  (`_contact_identity_ids`). Histórico, negócio aberto e trava passam a considerar o grupo. Limite: @lid nunca resolvido não tem
  vínculo conhecido; a decisão registra `identity_status = 'unresolved_lid'` para medir no modo sombra.
- **Sem duplicidade, sem bloquear outro produto**: bloqueia se o grupo já tem negócio aberto da MESMA operação (ou com operação a
  confirmar). Operação diferente coexiste. Trava de todos os contatos do grupo em ordem fixa + reconferência depois da trava;
  uma decisão por gatilho (UNIQUE) => reprocessar ou eventos simultâneos (handoff + tarefa) nunca criam dois cards.
- **Reabertura**: o app não tem caminho de reabertura de negócio (nenhuma tela/API usa o evento `reopened`); nada a travar.
  Criação manual pelo vendedor continua decisão humana.
- **Preserva o anterior**: o negócio fechado não muda (status, motivo, valores, datas, indicadores).
- **Vínculo**: `opportunities.previous_opportunity_id` (coluna nova) + `previous_opportunity_id` no evento `created`.
- **Dono**: vendedor do negócio anterior se ativo (`sales_reps.availability <> 'out'`); senão o vendedor que o rodízio entregou na
  atribuição ativa da conversa; senão o vendedor da conversa.
- **Origem**: `wa_contacts.metadata.lead_origin` (selo do card) + último `lead_ad_touches` no evento de criação.
  (Divergência do Bruno: a origem existe em `lead_origin` — anúncio Meta no Status, 12/11; a consulta manual de 24/11 olhou o campo
  errado e os toques só são gravados desde 13/11.)
- **Tarefas**: tarefas comerciais abertas do grupo sem negócio passam a apontar para o novo; administrativas ficam como estão.
- **Etapa**: inicial; qualificação se o cliente deu detalhes; etapa de proposta só se o modelo aponta uma mensagem NOSSA do contexto
  com a proposta. Financiamento nunca passa de qualificação pela IA (mesma regra do `sync_sales_pipeline`).
- **Log**: evento `created` com `source = 'returning_customer'`, decisão, intenção, motivo, gatilho, negócio anterior, regra do dono e origem.
- **Flags independentes**: `returning_customer_card_enabled` + `returning_customer_card_mode` (`shadow` padrão / `write`) +
  `returning_customer_card_started_at` (nunca avalia gatilhos anteriores). Modo sombra grava só a decisão.
- **Encerramento automático só depois** de validar a reativação em sombra.

### Caminhos automáticos de criação de negócio (verificação do item 8)

1. `sync_sales_pipeline` — IA identificou interesse; só contato sem histórico. Agora pelo grupo de identidade.
2. `_open_opportunity_for_handoff` (card de encaminhamento) — todo encaminhamento de contato sem histórico, **sem avaliar intenção**.
   Foi o caminho dos cards indevidos do Cleber e do Rosival (cadastro @lid separado = "sem histórico"). Corrigido para o grupo de
   identidade. Para lead realmente novo continua sem classificação (fora do escopo deste PR; o modo sombra não mede esse caminho).
3. `_open_opportunity_for_task` — tarefa humana de follow-up comercial; só contato sem histórico. Agora pelo grupo de identidade.
4. API `POST /opportunities` — criação manual pelo vendedor (decisão humana).
5. Novo: `open_returning_customer_opportunity` — só com decisão `commercial` em modo escrita.
Nenhum caminho automático cria card para quem tem histórico, exceto o 5.

### Simulação retrospectiva (30 dias até 25/11, somente leitura)

Contatos com negócio fechado, sem card aberto, que geraram encaminhamento (14 eventos) ou tarefa comercial da IA:
- **Criaria corretamente (4):** Diego Souza (financiamento negado; Márcio ofereceu carta/consórcio, sem card), ney Oliveira
  (anúncio de carta contemplada), Rosângela, Bruno (este só via tarefa).
- **Não criaria, corretamente (5):** Cleber (assembleia/lance), Lorena (documento Detran), Rosival (entrega/documento após compra),
  Maria (arquivos sem objetivo), Clemilson (pedido de troca da bike comprada — o resumo do encaminhamento sugeria recompra).
- **Risco de falso positivo (1):** Erica — resposta automática do WhatsApp Business dela gerou tarefa de proposta. Coberto pelo pré-filtro.
- **Duplicidade evitada:** 4 contatos tiveram 2 encaminhamentos em menos de 2 dias (Cleber, Rosival, Maria, Ricardo).
- **Bug encontrado:** cards de pós-venda via cadastro @lid separado (Cleber 18/11 marcado ganho; Rosival 21/11 aberto).

## Cards indevidos (Cleber e Rosival) — proposta, nada alterado

Não existe hoje mecanismo de invalidação: status só `open/won/lost`, eventos fixos, e os indicadores contam por `status`.
Proposta (PR separado, com autorização): status `void` ("anulado") + `void_reason` + evento `voided` (auditoria preservada,
reversível), excluído do funil e de todos os indicadores de ganho/perda/conversão; só gestor anula. Depois aplicar aos dois.

## Implantação

PR com testes → aprovação → merge/deploy com autorização → aplicar a migração (correção de identidade vale já no deploy) →
ligar `returning_customer_card_enabled` em modo sombra → avaliar decisões → modo escrita → só então `no_reply_closure_enabled`
(com `no_reply_closure_started_at`, que impede aplicar despedidas antigas da cadência).
