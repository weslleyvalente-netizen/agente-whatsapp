# Rodízio: responsável explícito, exceção que fecha com a resposta e encaminhamento repetido (fase C)

Data: 27/11/2026. Plano de estabilização aprovado pelo dono em 26/11: reaproveitar o #102, resolvendo os conflitos com a main.

## Problema (medido de 16 a 26/11)
- Dos 132 leads únicos distribuídos, 23% foram respondidos no prazo, 55% fora do prazo e 22% nunca receberam resposta humana.
- Quando todos os vendedores deixam vencer o prazo, `redistribute_assignment` grava uma exceção **sem vendedor** (`rep_id` NULL):
  - a conversa e o card ficam com o último vendedor, mas ninguém é avisado;
  - a exceção só sai da fila com reatribuição manual;
  - **não fecha quando alguém responde**: havia 16 exceções já atendidas e ainda abertas.
- **Encaminhamentos repetidos:** 161 no período, 147 deles durante atendimento humano. Destes, 38 reiniciaram o ciclo de atribuição e 9 mandaram o cliente a outro vendedor no meio do atendimento.

## O que entra
1. **#102 incorporado:** triagem de exceções, alertas 0/15/30/60 min úteis e eventos auditáveis. Os conflitos com a main foram resolvidos e a migração foi renomeada para `20261127130000`. Tudo continua desligado por padrão, como no #102.
2. **Migração `20261127140000_rodizio_responsavel_explicito.sql`:**
   - **`lead_assignments.responsible_rep_id`:** na exceção por rodízio esgotado, recebe o último vendedor da cadeia. Na exceção direta (sem vendedor disponível, dono inválido, conflito), recebe o vendedor que já está com a conversa. É só dado: quem fica com a conversa e o card não muda (hoje já é esse vendedor); passa a ficar explícito.
   - **`lead_assignments.last_customer_followup_at`:** registra quando o cliente voltou a escrever num atendimento ativo.
   - **`record_human_message`:** com `exception_auto_resolve_enabled`, a resposta do vendedor fecha a exceção aberta da conversa como `answered_by_seller`, com autor e horário. Uma resposta anterior à exceção não fecha.
   - **`distribute_lead`:** com `repeat_handoff_keeps_assignment_enabled`, o novo encaminhamento **não reinicia o prazo nem o rodízio** em três casos. Em todos, só grava `last_customer_followup_at`.
     - **Atribuição pendente** (o cliente ainda aguarda a primeira resposta humana): já não reiniciava hoje, e o `sla_due_at` é protegido pelo gatilho de imutabilidade. Agora também registra o retorno do cliente.
     - **Atribuição aceita** com mensagem do vendedor nas últimas 24 h.
     - **Rodízio esgotado** (exceção aberta) sem resposta humana depois: a exceção continua com o responsável explícito e na fila do gestor, em vez de recomeçar o rodízio do zero com prazo novo.
   - **Regras preservadas, com testes:** redistribuição por vencimento (`redistribute_assignment`), vendedor indisponível que não recebe, transferência manual pelo gestor (`manual_assign`).
   - **Mensagens simultâneas:** vários encaminhamentos no mesmo instante, ou o mesmo reprocessado, geram uma única atribuição. A idempotência é por encaminhamento e a trava `FOR UPDATE` em `lead_distribution_state` serializa as chamadas.
   - Os corpos das funções foram copiados das versões vigentes (`distribute_lead` de 20261027120000; `redistribute_assignment` e `record_human_message` de 20261119130000), com as mudanças comentadas.
3. **Alertas do #102:** com `responsible_rep_id`, avisam o responsável e os gestores, e não todos os vendedores. Se o responsável não for mais vendedor ativo, voltam a avisar todos, para nunca ficar sem destinatário.
4. **Painel "Atraso no atendimento":** a linha da exceção mostra "responsável: Nome".

## Chaves (todas desligadas por padrão)
- `exception_auto_resolve_enabled`
- `repeat_handoff_keeps_assignment_enabled`
- As do #102: `exception_triage_panel_enabled`, `exception_alerts_mode` e `exception_alerts_activated_at`.

## Fora do escopo
- Especialização por produto no rodízio. O campo `sales_reps.specialties` existe, mas a distribuição não o usa; fica para o projeto de rodízio inteligente.
- Mudar o prazo de 36 min úteis.

## Implantação (cada passo com autorização)
1. Ensaiar e aplicar as migrações `20261127130000` (#102) e `20261127140000`.
2. Merge e deploy: comportamento igual ao de hoje, exceto `responsible_rep_id` gravado nas novas exceções.
3. Ligar `exception_auto_resolve_enabled`.
4. Ligar `repeat_handoff_keeps_assignment_enabled`.
5. Ligar a triagem e os alertas do #102 em sombra, depois `on`.
