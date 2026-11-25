# Encaminhamento administrativo sem card — design

Data: 25/11/2026. Pedido do dono em 25/11. Empilhado sobre o PR #125 (usa a classificação `inferHandoffOperation`).

## Por quê
Levantamento de 30 dias: pelo menos 8 cards de encaminhamento eram atendimentos administrativos/pós-venda (comprovante de Pix, boleto do
consórcio, transferência de cota, troca de óleo; ex.: Janaina, segunda via de boleto). Viram "oportunidades" que nunca foram venda.

## Regra (decisão do dono)
- Intenção **exclusivamente** administrativa ou pós-venda => não cria card automático, inclusive para contato sem histórico.
- Nunca impede: o encaminhamento humano, a atribuição de responsável (rodízio) e uma tarefa de atendimento.
- Na dúvida (sem evidência, ou administrativo junto com intenção de compra), o card é criado como hoje — não se descarta uma venda.

## Como
- `requestHuman` grava `handoff_events.commercial_intent` (`administrative` só quando a classificação é administrativa e sem intenção
  comercial; `commercial` quando há produto; senão `unclear`) — apenas com a flag `handoff_admin_no_card_enabled` (a coluna é da migração).
- `_open_opportunity_for_handoff` (corpo de 20261027120000) retorna sem criar quando o encaminhamento mais recente da conversa é
  `administrative` e a flag está ligada. Cobre os dois caminhos que chamam a função: `distribute_lead` e a escalada de SLA.
- Atribuição e responsável seguem iguais (`_lead_decide`/`_lead_apply_effects`); a IA cria a tarefa "Atendimento administrativo/pós-venda
  (sem card no funil)" para o responsável do encaminhamento.
- Novo encaminhamento comercial na mesma conversa volta a criar o card (vale o encaminhamento mais recente).

## Compatibilidade
- PR #123: não redefine `_open_opportunity_for_handoff` (verificado); a correção de identidade dele atua dentro de
  `_contact_has_deal_history`, chamada pelo nome — continua valendo. Ordem de migrações: 20261125 (#123) < 20261126120000 (#124) <
  20261126130000 (este).
- PR #125: este PR é empilhado sobre ele (mesma classificação e mesmo ponto do `requestHuman`).

## Implantação
Flag desligada por padrão. Merge do #125 → merge deste → migração 20261126130000 → ligar `handoff_admin_no_card_enabled` (com
autorização) → acompanhar a fila de tarefas administrativas.
