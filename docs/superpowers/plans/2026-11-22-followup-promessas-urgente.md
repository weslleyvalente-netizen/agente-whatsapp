# Follow-up de proposta, promessas e urgentes — plano de implementação

> Execução nativa (superpowers:executing-plans). Passos em ordem TDD.

**Goal:** Implementar o desenho de 22/11: feriados, identificação de proposta, lembrete de 30 min, promessas com prazo, clientes que
escapam, cards urgentes x follow-up e métricas. Tudo atrás de flags desligadas, sem implantar.

**Spec:** docs/superpowers/specs/2026-11-22-followup-promessas-urgente-design.md

**Tech:** TypeScript (pnpm/turbo), vitest, Supabase/Postgres, BullMQ, Next.js.

## Global Constraints

- Nenhuma mensagem automática ao cliente nesta entrega. Tudo é tarefa interna ou visual.
- Flags novas desligadas por padrão (`=== true` para ligar): `commitments_enabled`, `escape_distribution_enabled`,
  `lid_auto_merge_enabled`, `urgent_cards_enabled`. Feriados só com `business_calendar.holiday_set === "posse_go"`.
- Migração nova idempotente e com `SET LOCAL lock_timeout = '5s'`. Não é aplicada nesta entrega.
- Texto visível em português. Fuso America/Sao_Paulo.
- Mensagem com horário original (`metadata.wa_original_at`, ou `created_at`) a mais de 24 h de `now` não gera proposta nem promessa.

## Review Focus

1. Promessa encerrada por mensagem genérica do vendedor. Não pode acontecer.
2. Imagem sozinha ou etapa "Negociação" virando proposta. Não pode acontecer.
3. Rodar a rotina duas vezes seguidas criando tarefa ou registro repetido.
4. Junção @lid com conflito deixando dados pela metade. A transação tem que desfazer tudo.
5. Feriado móvel (Sexta-feira Santa) e `open_days` reabrindo um feriado.

---

### Task 1: Feriados no calendário
- Files: create `packages/shared/src/holidays-br.ts`; modify `packages/shared/src/business-calendar.ts`
  (`resolveBusinessCalendar`) e `packages/shared/src/index.ts`. Test: `packages/shared/src/holidays-br.test.ts`.
- Produces: `easterSunday(year): {m,d}`, `posseGoHolidays(year): Array<{date, name}>`,
  `resolveBusinessCalendar` com `holiday_set`, `extra_holidays` e `open_days`.
- Testes: Sexta-feira Santa 2026 = 2026-04-03 e 2027 = 2027-03-26; lista de 2026 com 14 datas únicas (26/07 aparece uma vez);
  `addBusinessMinutes` sexta 03/04/2026 conta a partir da segunda; `open_days` reabre; sem `holiday_set` nada muda.

### Task 2: Classificadores puros (proposta e promessa)
- Files: create `packages/shared/src/commitments.ts`. Test: `packages/shared/src/commitments.test.ts`.
- Produces:
  - `detectProposalEvidence({content, mediaType, fileName}): {strong: boolean; evidence: string|null}`
  - `detectSellerPromise(content, sentAt, calendar, defaultMinutes=120): {kind:"quick"|"standard"|"explicit_time"|"tomorrow"; dueAt: Date; phrase: string}|null`
  - `PROPOSAL_STAGES`, `isWithinHistoryWindow(sentAt, now)`.
- Testes: "R$ 80.000 com entrada de 10 mil e parcelas de 1.200" é forte; imagem sem texto não é; "R$ 500" sem termo não é;
  PDF "proposta.pdf" é forte; "já te falo" dá 30 min; "vou verificar" dá 120 min; "te retorno às 15h" às 10:00 vence às 15:00
  do mesmo dia; às 16:00 vence no dia útil seguinte; "amanhã" dá abertura + 120; "bom dia" dá null; "não vou verificar" dá null.

### Task 3: Migração
- File: create `supabase/migrations/20261122120000_commitments_followup.sql`.
- Conteúdo:
  - tabela `proposal_followups` (unique `seller_message_id`, RLS só leitura para membros);
  - `handoff_events.trigger_type` passa a aceitar `sistema_sem_resposta`;
  - função `merge_wa_contact(p_org, p_from, p_to)`, SECURITY DEFINER, só service_role. Move as referências a `wa_contacts`
    encontradas em `pg_constraint`, marca o contato de origem em `metadata.merged_into` e troca o telefone dele para
    `<phone>#merged`. Se algo falhar, desfaz tudo e lança erro.
- Teste: o teste de migração do repositório (se existir), mais a leitura da sintaxe.

### Task 4: Rotina `commitments` (5 min)
- Files: create `apps/worker/src/workers/commitments.ts` e `packages/database/src/queries/commitments.ts`; modify o worker index e
  as filas. Test: `apps/worker/src/workers/commitments.test.ts`.
- Fluxo por organização com `commitments_enabled === true`:
  1. Lê as mensagens `human_agent` dos últimos 3 dias, a mais recente por conversa.
  2. Promessa: cria ou atualiza a `return_customer` com `due_date`/`due_time` e `metadata.source_message_id`.
  3. Proposta: insere em `proposal_followups` (conflito: não faz nada). Aos 30 min úteis sem resposta do cliente e sem nova
     mensagem do vendedor, cria a `proposal_followup`.
  4. Resolve tarefas:
     - `proposal_followup` e `customer_nudge`: encerram com mensagem do cliente posterior ou do vendedor;
     - `return_customer` de promessa: só encerra com evidência forte posterior ou negócio fechado.
  5. Atualiza `proposal_followups`: primeira nova mensagem do vendedor, primeira resposta do cliente e resultado do negócio.
- Testes: os quatro pedidos do dono (atraso, reabertura, duplicidade e calendário via Task 1), mais promessa não encerrada por
  "ok".

### Task 5: Clientes que escapam
- Files: modify `apps/worker/src/workers/unanswered-lead-sweep.ts` (deps `distributeEscaped`), `apps/api/src/routes/webhooks/evolution.ts`
  (antes de `ensureConversation`: `adoptLidContact`), `packages/shared/src/uazapi/translate.ts` (`chatlid` no key) e
  `packages/shared/src/schemas/evolution.ts`.
- Testes:
  - a varredura distribui só sem dono, só com a flag ligada e só uma vez;
  - a tradução leva `chatlid`;
  - a adoção troca o telefone quando não existe contato real, junta quando existe, e com conflito segue o fluxo antigo.

### Task 6: Cards urgentes e follow-up
- Files: modify `apps/api/src/services/sales-workspace.service.ts` (`urgent` e `followup` em `sales_state`, mais a cobertura),
  `packages/shared/src/sales-workspace.ts`, `packages/shared/src/sales-queue.ts` (urgente ordena primeiro dentro de
  "Cliente respondeu"; o urgente de promessa vai para `customer_replied`) e `apps/web/src/components/opportunities/opportunity-kanban.tsx`.
- Testes:
  - `classifySalesQueue` põe o urgente em `customer_replied` e na frente;
  - o follow-up fica em `due_today` e não pisca;
  - a cobertura conta os alertas sem card.

### Task 7: Métricas
- Files: create `packages/shared/src/proposal-metrics.ts` (agregação pura), a rota `GET /organizations/:id/proposal-metrics`
  (gestor) e `apps/web/src/components/dashboard/proposal-metrics-card.tsx`.
- Testes: a agregação por vendedor separa "cliente respondeu antes" e conta as faixas de 30 min, 1 dia e 3 dias e os ganhos.
