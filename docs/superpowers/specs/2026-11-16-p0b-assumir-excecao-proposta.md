# P0b (PROPOSTA, não implementado): botão "Assumir" para exceções de SLA

Status: somente proposta, para PR e revisão separados do P0a. Nenhum código deste item existe neste PR.

## Objetivo
Permitir que um vendedor **disponível** assuma explicitamente uma exceção (os dois vendedores já estouraram o SLA), com registro de quem assumiu e quando, sem tocar o rodízio 50/50 e sem redistribuição automática.

## Desenho mínimo
- Função SQL `claim_exception(p_org, p_assignment, p_actor)`: trava a linha da exceção (`FOR UPDATE`), exige exceção aberta (`status='exception'`, `resolved_at IS NULL`, sem `resolved_*` em `exception_events`), vendedor `available`, membro da organização e `actor = rep.user_id` (o **servidor** deduz o vendedor pelo login; nunca aceita `rep_id` do corpo). O primeiro vence; chamadas repetidas do mesmo vendedor são idempotentes; outro vendedor recebe conflito.
- Efeito: aplica dono pelo mesmo caminho interno já usado em atribuição manual (`_lead_apply_effects`), grava `exception_events(kind='resolved_confirmed', rep_id, actor)` e uma linha em `lead_assignments` com motivo próprio (`exception_claim`) e `accepted_via` próprio, **sem mover `lead_distribution_state`**. Exige ampliar os `CHECK` de `reason`/`accepted_via` (migração aditiva).
- Rota `POST /organizations/:org/exception-events/:id/claim` (vendedor, não gestor) e botão "Assumir" no painel e no link do push; flag própria `exception_claim_enabled` (desligada) e kill switch.
- A escada de alertas para ao assumir (evento de resolução válido).

## Riscos e perguntas a decidir antes de implementar
- Mexe no dono de cliente (por isso fora do P0a). A regra de elegibilidade (disponibilidade, carga) precisa de decisão do dono.
- Ampliar `CHECK` em `lead_assignments` é alteração de tabela existente (aditiva, mas exige ensaio).
- Corrida entre dois vendedores e entre "Assumir" e `manual_assign` do gestor: testar com duas conexões reais.

## Critérios de aceitação sugeridos
Um único vencedor sob concorrência; rodízio e ponteiro idênticos antes/depois; evento auditável com vendedor e horário; escada cancelada em ≤ 1 ciclo; nenhum cliente marcado como atendido sem aceite ou resposta comprovada; desligar a flag remove o botão sem tocar dados.
