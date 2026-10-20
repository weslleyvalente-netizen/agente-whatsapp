-- Backfill: aplica a regra de 20261021120000_human_task_opens_opportunity.sql às tarefas humanas abertas JÁ existentes.
-- NÃO rode antes de aplicar a migration. Rode o bloco 1 (preview) primeiro, confira, e só então o bloco 2 (dentro de transação).
-- Mesma regra do gatilho: flag sales_auto_pipeline_enabled = true, tarefa humana aberta (pending/in_progress/rescheduled),
-- contato sem nenhum negócio aberto, telefone fora de organization_ignored_contacts; 1 negócio por contato (tarefa mais antiga).
-- Dono = assignee_id se for vendedor (sales_reps); senão sem dono (e o gatilho trg_owner_on_opportunity_open herda da conversa).
-- Operação = a do último negócio do contato, ou 'vehicle_sale'; etapa 'interest_received'.

-- ===== 1) PREVIEW (rode primeiro; somente leitura) =====
-- SELECT DISTINCT ON (t.organization_id, t.contact_id) t.organization_id, t.contact_id, t.id AS task_id, t.assignee_id,
--        EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = t.organization_id AND r.user_id = t.assignee_id) AS owner_is_rep
--   FROM public.tasks t
--   JOIN public.organizations org ON org.id = t.organization_id AND org.settings->'sales_auto_pipeline_enabled' = 'true'::jsonb
--   JOIN public.wa_contacts w ON w.id = t.contact_id AND w.organization_id = t.organization_id
--  WHERE t.assignee_type = 'human' AND t.status IN ('pending','in_progress','rescheduled')
--    AND NOT EXISTS (SELECT 1 FROM public.opportunities o WHERE o.organization_id = t.organization_id AND o.contact_id = t.contact_id AND o.status = 'open')
--    AND NOT EXISTS (SELECT 1 FROM public.organization_ignored_contacts i WHERE i.organization_id = w.organization_id AND i.phone = w.phone)
--  ORDER BY t.organization_id, t.contact_id, t.created_at, t.id;

-- ===== 2) APLICAR =====
BEGIN;
-- Trava os contatos afetados na ordem do id para não competir com sync_sales_pipeline/gatilho.
SELECT w.id FROM public.wa_contacts w
 WHERE w.id IN (SELECT t.contact_id FROM public.tasks t WHERE t.assignee_type = 'human' AND t.status IN ('pending','in_progress','rescheduled'))
 ORDER BY w.id FOR UPDATE;

WITH pick AS (
  SELECT DISTINCT ON (t.organization_id, t.contact_id) t.organization_id, t.contact_id, t.id AS task_id, t.assignee_id
    FROM public.tasks t
    JOIN public.organizations org ON org.id = t.organization_id AND org.settings->'sales_auto_pipeline_enabled' = 'true'::jsonb
    JOIN public.wa_contacts w ON w.id = t.contact_id AND w.organization_id = t.organization_id
   WHERE t.assignee_type = 'human' AND t.status IN ('pending','in_progress','rescheduled')
     AND NOT EXISTS (SELECT 1 FROM public.opportunities o WHERE o.organization_id = t.organization_id AND o.contact_id = t.contact_id AND o.status = 'open')
     AND NOT EXISTS (SELECT 1 FROM public.organization_ignored_contacts i WHERE i.organization_id = w.organization_id AND i.phone = w.phone)
   ORDER BY t.organization_id, t.contact_id, t.created_at, t.id
), ins AS (
  INSERT INTO public.opportunities(organization_id, contact_id, operation, initial_operation, stage, status, owner_id, owner_assigned_at, last_progress_at)
  SELECT p.organization_id, p.contact_id, op.operation, op.operation, 'interest_received', 'open',
         rep.user_id, CASE WHEN rep.user_id IS NOT NULL THEN now() END, now()
    FROM pick p
    CROSS JOIN LATERAL (SELECT coalesce((SELECT o.operation FROM public.opportunities o WHERE o.organization_id = p.organization_id AND o.contact_id = p.contact_id ORDER BY o.created_at DESC, o.id LIMIT 1), 'vehicle_sale') AS operation) op
    LEFT JOIN LATERAL (SELECT r.user_id FROM public.sales_reps r WHERE r.organization_id = p.organization_id AND r.user_id = p.assignee_id LIMIT 1) rep ON true
  RETURNING id, organization_id, contact_id, operation
), ev AS (
  INSERT INTO public.opportunity_events(organization_id, opportunity_id, event_type, new_value, evidence, changed_by_type)
  SELECT i.organization_id, i.id, 'created', jsonb_build_object('operation', i.operation, 'stage', 'interest_received', 'backfill', '20261020_open_opportunities_for_human_tasks'),
         'Negócio criado porque o vendedor recebeu uma tarefa sem negócio', 'system'
    FROM ins i
  RETURNING opportunity_id
)
UPDATE public.tasks t SET opportunity_id = i.id
  FROM pick p JOIN ins i ON i.organization_id = p.organization_id AND i.contact_id = p.contact_id
 WHERE t.id = p.task_id AND t.opportunity_id IS NULL;

-- Confira antes de confirmar:
-- SELECT count(*) FROM public.opportunity_events WHERE new_value->>'backfill' = '20261020_open_opportunities_for_human_tasks';
COMMIT;  -- ou ROLLBACK;

-- ===== 3) REVERSÃO =====
-- Desvincula as tarefas e apaga SOMENTE os negócios criados por este backfill que ninguém mexeu depois (sem outros eventos):
-- BEGIN;
-- WITH mine AS (
--   SELECT e.opportunity_id FROM public.opportunity_events e
--    WHERE e.new_value->>'backfill' = '20261020_open_opportunities_for_human_tasks'
--      AND NOT EXISTS (SELECT 1 FROM public.opportunity_events x WHERE x.opportunity_id = e.opportunity_id AND x.id <> e.id)
-- ), unl AS (UPDATE public.tasks SET opportunity_id = NULL WHERE opportunity_id IN (SELECT opportunity_id FROM mine) RETURNING 1)
-- DELETE FROM public.opportunities WHERE id IN (SELECT opportunity_id FROM mine);
-- COMMIT;
-- (tasks.opportunity_id tem ON DELETE SET NULL e opportunity_events ON DELETE CASCADE; o UPDATE explícito é só por clareza.)
