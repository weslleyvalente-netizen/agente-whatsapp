# Negócio anulado (void) — design

Data: 25/11/2026. Aprovado pelo dono em 25/11 (implementação em PR separado). Empilhado sobre o PR #123 (as funções de histórico que
passam a ignorar o anulado são as mesmas que o #123 redefine pelo grupo de identidade).

## Por quê

Cards que nunca foram oportunidade comercial válida — Cleber (cc87f35d, 18/11, marcado ganho em 19/11) e Rosival (8a9e41ed, 21/11,
aberto), criados por um cadastro @lid duplicado para atendimento de pós-venda. O dono não quer marcá-los como perdidos nem
ganhos: não devem contar em nenhum indicador. Hoje não existe mecanismo: o status só tem open/won/lost.

## Regras (decisões do dono 25/11)

- **Só gestor** (`owner`/`admin`) anula ou desfaz — conferido na API e de novo no banco (`_is_org_manager`).
- **Motivo obrigatório** (10–500 caracteres) — tela, API e banco.
- **Auditoria**: eventos `voided`/`unvoided` com autor, data, motivo e o estado anterior completo; nada é apagado.
- **Reversível**: desfazer devolve exatamente status, motivo de perda e data de retomada anteriores. Desfazer um anulado que era
  ganho **não** conclui de novo as tarefas do contato (o gatilho de ganho ignora a volta do anulado).
- **Fora de todos os indicadores**: status próprio `void` (não é aberto, ganho nem perdido; some do funil e das abas); relatório
  de ligações e métricas de proposta excluem o anulado (inclusive proposta que já tinha resultado "ganho"); view
  `opportunity_ad_origins` exclui o anulado.
- **Fora do histórico comercial**: `_contact_has_deal_history` e `_open_opportunity_for_task` ignoram anulado (não bloqueia card
  novo; não vira "negócio anterior" do cliente que volta).
- **Blindado**: gatilho impede que qualquer outra rotina mude o status de/para `void` ou edite etapa/operação/dono de um anulado;
  a API devolve 409 com orientação em ganho, perdido, edição, etapa e mudança de funil.
- **Tarefas não mudam** (não prejudicar o vendedor); a anulação informa quantas tarefas abertas apontam para o card.

## Efeitos financeiros verificados antes (25/11, somente leitura)

- O banco não tem comissão, meta, bônus nem faturamento (nenhuma tabela/coluna); o CRM separado usa o mesmo banco.
- Cleber: dois ganhos no mesmo cadastro unificado — a65c9bfb (consórcio, 07/10, venda real) e cc87f35d (card indevido, sem valor
  de venda/crédito). O "ganho" indevido não concluiu tarefas (nenhum evento de tarefa no minuto do ganho). Efeito: +1 ganho do Márcio
  nos indicadores; 6 atribuições do rodízio ligadas aos dois negócios.
- Rosival: ganho real c8a5720d (10/10) + card indevido aberto 8a9e41ed, sem valores, com 1 tarefa (já concluída em 25/11).
- Conclusão: anular os dois não tem efeito financeiro; corrige 1 ganho e 1 card aberto indevidos.

## Fora do escopo

- Aba "Anulados" no funil (o anulado aparece na busca com o rótulo "Anulado").
- Aplicar a Cleber e Rosival: só depois de validar este recurso (decisão do dono).

## Implantação

PR com testes → aprovação → merge do #123 → merge deste → migração `20261126120000_opportunity_void.sql` (com autorização) →
gestor anula os dois pela tela (ou por SQL com o gestor como autor).
