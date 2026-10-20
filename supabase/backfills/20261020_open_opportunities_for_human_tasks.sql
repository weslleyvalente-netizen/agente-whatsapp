-- Backfill: aplica a regra de 20261021120000_human_task_opens_opportunity.sql às tarefas humanas abertas JÁ existentes.
-- NÃO rode antes de aplicar a migration (usa public._open_opportunity_for_task: mesma regra e mesmos pulos do gatilho).
-- Passos: (1) rode o PREVIEW e confira; (2) rode o bloco APLICAR, que termina em ROLLBACK; confira a contagem;
-- (3) só então troque o ROLLBACK por COMMIT e rode de novo. Este arquivo NUNCA confirma sozinho.
-- Regra: flag sales_auto_pipeline_enabled = true; tarefa humana aberta sem opportunity_id; contato SEM nenhum negócio (aberto,
-- ganho ou perdido); telefone fora de organization_ignored_contacts; operação inferida do tipo da tarefa (consortium_followup,
-- vehicle_followup, financing_followup, libera_cred_resumption); outros tipos NÃO criam e ficam contados no preview.
-- Contatos com a linha travada por outra transação são pulados (SKIP LOCKED); rode de novo depois.

-- ===== 1) PREVIEW (somente leitura): TODAS as tarefas humanas abertas sem negócio aberto, com o motivo =====
-- SELECT t.organization_id, t.contact_id, t.id AS task_id, t.type, t.opportunity_id,
--        public._task_type_operation(t.type) AS operation,
--        (SELECT string_agg(o.status, ',' ORDER BY o.created_at) FROM public.opportunities o WHERE o.organization_id = t.organization_id AND o.contact_id = t.contact_id) AS historico,
--        CASE
--          WHEN org.settings->'sales_auto_pipeline_enabled' IS DISTINCT FROM 'true'::jsonb THEN 'pula: flag desligada'
--          WHEN t.opportunity_id IS NOT NULL THEN 'pula: tarefa ja ligada a um negocio'
--          WHEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.organization_id = t.organization_id AND o.contact_id = t.contact_id) THEN 'pula: contato ja tem historico de negocio'
--          WHEN EXISTS (SELECT 1 FROM public.organization_ignored_contacts i WHERE i.organization_id = w.organization_id AND i.phone = w.phone) THEN 'pula: contato ignorado'
--          WHEN public._task_type_operation(t.type) IS NULL THEN 'pula: operacao nao inferivel pelo tipo da tarefa'
--          WHEN (SELECT count(DISTINCT public._task_type_operation(x.type)) FROM public.tasks x WHERE x.organization_id = t.organization_id AND x.contact_id = t.contact_id AND x.assignee_type = 'human'
--                   AND x.status IN ('pending','in_progress','rescheduled') AND public._task_type_operation(x.type) IS NOT NULL) > 1 THEN 'pula: tipos de tarefa com operacoes diferentes (ambiguo)'
--          ELSE 'CRIA' END AS decisao
--   FROM public.tasks t
--   JOIN public.organizations org ON org.id = t.organization_id
--   JOIN public.wa_contacts w ON w.id = t.contact_id AND w.organization_id = t.organization_id
--  WHERE t.assignee_type = 'human' AND t.status IN ('pending','in_progress','rescheduled')
--    AND NOT EXISTS (SELECT 1 FROM public.opportunities o WHERE o.organization_id = t.organization_id AND o.contact_id = t.contact_id AND o.status = 'open')
--  ORDER BY decisao, t.organization_id, t.contact_id, t.created_at, t.id;
-- Resumo (conte também contatos: count(DISTINCT contact_id) FILTER (WHERE decisao = 'CRIA')): troque o SELECT acima por  SELECT decisao, count(*) ... GROUP BY decisao  (ou envolva em subconsulta).

-- ===== 2) APLICAR (transação; termina em ROLLBACK) =====
BEGIN;
-- Ambíguos (operações diferentes entre as tarefas do contato) são pulados pelo próprio núcleo; nunca se escolhe a "mais antiga" no chute.
-- Rode no psql, ou cada instrução separada no editor; o resultado mostra criados x pulados.
SELECT count(*) FILTER (WHERE s.opportunity_id IS NOT NULL) AS criados, count(*) FILTER (WHERE s.opportunity_id IS NULL) AS pulados FROM (
SELECT public._open_opportunity_for_task(p.task_id, 'human_task_backfill') AS opportunity_id
  FROM (
    SELECT DISTINCT ON (t.organization_id, t.contact_id) t.id AS task_id
      FROM public.tasks t
     WHERE t.assignee_type = 'human' AND t.status IN ('pending','in_progress','rescheduled') AND t.opportunity_id IS NULL
       AND public._task_type_operation(t.type) IS NOT NULL
     ORDER BY t.organization_id, t.contact_id, t.created_at, t.id
  ) p
) s;
-- Confira antes de confirmar:
-- SELECT count(*) FROM public.opportunity_events WHERE new_value->>'source' = 'human_task_backfill' AND created_at >= now() - interval '1 hour';
ROLLBACK;  -- troque por COMMIT; só depois de conferir

-- ===== 3) REVERSÃO (só negócios criados por este backfill; recusa se alguém já usou) =====
-- BEGIN;
-- DO $$
-- DECLARE n_used integer;
-- BEGIN
--   CREATE TEMP TABLE _bf_opps ON COMMIT DROP AS
--     SELECT e.opportunity_id AS id FROM public.opportunity_events e WHERE e.new_value->>'source' = 'human_task_backfill' AND e.event_type = 'created';
--   SELECT count(*) INTO n_used FROM _bf_opps b JOIN public.opportunities o ON o.id = b.id
--    WHERE EXISTS (SELECT 1 FROM public.lead_assignments l WHERE l.opportunity_id = b.id)
--       OR EXISTS (SELECT 1 FROM public.sales_call_logs c WHERE c.opportunity_id = b.id)
--       OR EXISTS (SELECT 1 FROM public.opportunity_events x WHERE x.opportunity_id = b.id AND x.id NOT IN (SELECT id FROM public.opportunity_events WHERE new_value->>'source' = 'human_task_backfill'))
--       OR o.updated_at > o.created_at + interval '1 minute' OR o.status <> 'open';
--   IF n_used > 0 THEN RAISE EXCEPTION 'Reversão recusada: % negócio(s) do backfill já foram usados (distribuição, ligações, eventos, edição ou fechamento); trate-os manualmente', n_used; END IF;
--   UPDATE public.tasks SET opportunity_id = NULL WHERE opportunity_id IN (SELECT id FROM _bf_opps);
--   DELETE FROM public.opportunities WHERE id IN (SELECT id FROM _bf_opps);
-- END $$;
-- COMMIT;  -- confira antes; use ROLLBACK para desistir
