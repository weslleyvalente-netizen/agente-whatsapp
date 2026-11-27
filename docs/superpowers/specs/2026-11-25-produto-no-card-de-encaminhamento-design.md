# Produto no card de encaminhamento — design

Data: 25/11/2026. Aprovado pelo dono em 25/11 (PR separado, sem depender dos PRs #123/#124).

## Por quê

Caso Ruben (25/11): veio do anúncio "Seu próximo carro — consórcio ou carta contemplada", perguntou "Quais cartas contempladas vocês têm
hoje?" e o card nasceu em "Venda de veículos". Causa: o `requestHuman` não passa produto para o encaminhamento; sem dado, o banco grava o
padrão `vehicle_sale` com `operation_is_default` ("a confirmar"). Em 30 dias, 114 de 129 cards de encaminhamento nasceram no padrão.

## Regra (decisão do dono)

Prioridade de evidência: 1) intenção explícita do cliente; 2) contexto recente da conversa; 3) resumo do encaminhamento; 4) produto do
anúncio de origem — evidência complementar, nunca decide sozinho. Sem evidência suficiente: produto a confirmar (o padrão de hoje), sem
assumir venda de veículo. Atendimento administrativo (boleto, segunda via, comprovante, Detran, transferência de cota, revisão,
troca de óleo) nunca vira produto.

## Como

- `inferHandoffOperation` (packages/shared, função pura, sem IA): fala mais recente do cliente com um único produto decide (o texto do
  anúncio colado na mensagem não conta); mensagem com dois produtos não decide; nossas últimas mensagens valem como contexto, exceto
  quando listam opções; no resumo vale o produto depois do verbo de intenção ("quer saber das cartas..."); "carta de crédito" sem
  "contemplada" = carta com confiança média.
- `requestHuman` passa `context.operation` ao `distribute_lead` só quando há evidência; qualquer falha => sem operação (nunca impede o
  encaminhamento). Janela: mensagens dos últimos 14 dias e anúncio dentro da janela de atribuição.
- **Sem migração.** `distribute_lead` já aceita `ctx.operation` (vai para o card e para `lead_assignments.operation`).

## O que não muda (garantido por teste)

- Rodízio: o mesmo encaminhamento escolhe o mesmo vendedor com ou sem operação (a operação não entra em `_lead_decide`).
- Duplicidade/histórico: contato com negócio aberto ou fechado não ganha card por causa da operação.
- Origem do anúncio: `lead_ad_touches`/`opportunity_ad_origins` não leem a operação.

## Validação retroativa (somente leitura, 30 dias, 100 cards que nasceram no padrão)

- Decidiria 71 (51 carta, 12 consórcio, 5 veículo, 3 financiamento); 29 ficariam a confirmar; 10 administrativos detectados
  (8 reais: comprovante Pix, boleto, transferência de cota, troca de óleo; 2 falsos positivos corrigidos com teste).
- Comparado ao levantamento manual dos cards abertos: 49 de 55 iguais.
- Dos 35 que o vendedor corrigiu depois, 17 divergem — quase todos o cliente pediu explicitamente um produto ("quais cartas
  contempladas vocês têm hoje?") e o vendedor mudou o funil conforme a negociação andou. O card nasce com a intenção inicial; o vendedor
  continua podendo mover.

## Limites / fora do escopo

- "A confirmar" continua tecnicamente no funil de venda de veículos com o aviso "Operação a confirmar" (o CHECK de `operation` não tem
  valor "a definir"). Uma faixa/filtro "A confirmar" no funil é outro PR.
- Card de atendimento administrativo ainda é criado pelo encaminhamento (hoje); este PR só não lhe dá produto. Bloquear/anular é decisão
  separada (ver PR #124).
- Os 62 cards abertos não são alterados (levantamento entregue à parte, sem escrita no banco).
