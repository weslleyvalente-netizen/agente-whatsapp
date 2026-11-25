# Cliente que volta + encerramento sem resposta — plano de implementação

> Execução: inline (executing-plans), uma migração + dois workers + testes. Sem merge, deploy ou flag sem autorização.

**Goal:** card novo para cliente que volta com intenção comercial (modo sombra primeiro) e encerramento automático após 3 follow-ups.
**Spec:** `docs/superpowers/specs/2026-11-24-encerramento-sem-resposta-design.md`

## Global Constraints
- Todas as flags novas desligadas por padrão; nada é enviado nem criado no deploy.
- Única mudança ativa no deploy: histórico/duplicidade pelo grupo de identidade (só bloqueia mais).
- Envio de despedida: tentativa única, 1 por instância a cada 15 min, limite diário ≤ 40, 8h–20h.
- Perdido só depois do envio confirmado; nunca para despedidas anteriores a `no_reply_closure_started_at`.
- Nunca `supabase db push`.

## Tasks
1. **Migração** `20261125120000_returning_customer_and_no_reply_closure.sql`: `_br_phone_key`, `_contact_identity_ids`,
   `_contact_has_deal_history` e `_open_opportunity_for_task` pelo grupo, `previous_opportunity_id`, `returning_customer_decisions`,
   `returning_customer_context`, `open_returning_customer_opportunity`, `_is_farewell_message`, `no_reply_closure_candidates`,
   `apply_no_reply_closure`. Testes: `packages/database/src/sql/returning-customer-and-closure.test.ts` (15) + suíte SQL existente
   rodando com a migração no fixture compartilhado.
2. **Classificação** `apps/worker/src/lib/returning-customer-intent.ts`: pré-filtro de resposta automática, prompt com contexto,
   `decideStage`. Testes: `returning-customer-intent.test.ts`.
3. **Worker cliente que volta** `apps/worker/src/workers/returning-customer.ts` (sombra/escrita, revisão de incertos). Testes: `returning-customer.test.ts`.
4. **Worker encerramento** `apps/worker/src/workers/no-reply-closure.ts` (aplica confirmadas, envia 1/instância). Testes: `no-reply-closure.test.ts`.
5. **Integração**: ciclo de 15 min chama os dois; `shouldConsiderAutomaticFollowup` e a checagem base ignoram conversa encerrada por despedida.
   Testes: `task-helpers.test.ts`, suítes do stale/low-intent.

## Review Focus
- @lid nunca resolvido (sem vínculo): fica `unresolved_lid`; medir no modo sombra.
- Filtros JSON do PostgREST em `applyConfirmedClosures` (não exercitados contra PostgREST real nos testes).
- Ligar `no_reply_closure_enabled` sem `no_reply_closure_started_at` não faz nada (proteção contra aplicação em massa).
- Custo do `_contact_identity_ids` dentro das funções chamadas por gatilho (índice por chave de telefone).
- Tarefa de revisão `other` não dispara criação de negócio (tipo sem mapeamento).

## Revisão 25/11 (fix pass)
Regressões escritas primeiro e vistas falhando no af744f5 (12 SQL + 3 worker + 1 worker de encerramento), depois corrigidas:
`returning_customer_triggers`, `returning_customer_pending_decisions`, `returning_customer_mark_attempt`, `returning_customer_owner`,
identidade transitiva indexada, captura/reconferência do negócio no encerramento, origem histórica × nova, vínculo de tarefas
posteriores ao fechamento, contagem só de envios confirmados. Ver a seção "Revisão independente" do spec.
