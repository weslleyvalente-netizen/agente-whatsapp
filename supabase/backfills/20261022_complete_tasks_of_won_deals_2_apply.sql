-- ARQUIVO 2 de 2: APLICAR (uma única instrução, autocommit). Rode SÓ depois de conferir o preview (arquivo 1).
-- Rode ESTE arquivo sozinho, no editor do Supabase, com "Limit results" = "No limit" (o limite de linhas do editor poderia cortar o resultado).
-- Começa com WITH de propósito (evita que o editor acrescente "limit 100" a uma instrução que começa com SELECT).
-- Devolve (opportunity_id, task_id, previous_status) de cada tarefa concluída; o status anterior também fica na nota do task_event.
-- Reexecutável: só pega tarefas ainda abertas. Tarefas travadas por outra transação são puladas (o editor não mostra o RAISE NOTICE):
-- depois de aplicar, rode o preview de novo e, se sobrar 'CONCLUI', rode este arquivo outra vez.
--
-- REVERSÃO (cada tarefa guarda o status anterior na nota do task_event). Use a janela exata em que rodou. ATENÇÃO: se o gatilho
-- de ganho concluiu outras tarefas na mesma janela, elas voltariam também: confira a lista antes (SELECT no lugar do UPDATE).
--   UPDATE public.tasks t SET status = substring(e.note from 'status anterior: ([a-z_]+)'), completed_at = NULL
--     FROM public.task_events e
--    WHERE e.task_id = t.id AND e.event_type = 'completed' AND e.note LIKE 'Encerrada automaticamente; status anterior: %'
--      AND t.status = 'completed' AND e.created_at >= '<inicio da execucao>' AND e.created_at < '<fim da execucao>';
--   e depois: DELETE FROM public.task_events e WHERE e.event_type = 'completed' AND e.note LIKE 'Encerrada automaticamente; %' AND e.created_at >= ... AND e.created_at < ...;

WITH w AS (
  SELECT o.id, (SELECT max(e.created_at) FROM public.opportunity_events e WHERE e.opportunity_id = o.id AND e.event_type = 'won') AS won_at
    FROM public.opportunities o WHERE o.status = 'won'
   ORDER BY 2 DESC NULLS LAST, 1 OFFSET 0
)
SELECT w.id AS opportunity_id, c.task_id, c.previous_status
  FROM w
 CROSS JOIN LATERAL public._complete_tasks_of_won_opportunity(w.id, w.won_at) c
 WHERE w.won_at IS NOT NULL;
