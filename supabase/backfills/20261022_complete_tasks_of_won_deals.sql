-- Backfill: aplica a regra de 20261022120000_won_closes_open_tasks.sql às tarefas abertas que JÁ pertencem a negócios ganhos.
-- NÃO rode antes de aplicar a migration (usa public._complete_tasks_of_won_opportunity: mesma regra do gatilho).
-- Feito para o editor SQL do Supabase (que mostra só o resultado da ÚLTIMA instrução e não mantém transação entre execuções):
-- são DUAS instruções independentes. Rode UMA POR VEZ (selecione o bloco e execute): primeiro o PREVIEW, depois o APLICAR.
--
-- Regra: tarefa aberta (pending/in_progress/rescheduled), humana ou da IA, da mesma organização, que (a) aponta para o negócio
-- ganho, ou (b) não aponta para negócio nenhum, é do contato e o contato não tem outro negócio ABERTO; E FOI CRIADA ATÉ o
-- horário do ganho (último evento 'won' do negócio). Tarefas criadas depois do ganho são trabalho novo de cliente que voltou e
-- NUNCA são tocadas. Negócio ganho SEM evento 'won' é pulado e listado no preview (revisão manual). Perdidos não entram.
-- Se um contato tem 2+ negócios ganhos, a tarefa sem negócio é atribuída ao ganho mais recente cujo horário de ganho seja >= à
-- criação da tarefa (preview e aplicar usam a mesma ordem). completed_at = horário da execução (o dia do backfill).
-- Reexecutável: só pega tarefas ainda abertas. Tarefas travadas por outra transação são puladas (RAISE NOTICE no aplicar):
-- rode o aplicar de novo.
--
-- REVERSÃO (cada tarefa guarda o status anterior na nota do task_event; nada de lista manual). Janela = o horário em que rodou:
--   UPDATE public.tasks t SET status = substring(e.note from 'status anterior: ([a-z_]+)'), completed_at = NULL
--     FROM public.task_events e
--    WHERE e.task_id = t.id AND e.event_type = 'completed' AND e.note LIKE 'Encerrada automaticamente; status anterior: %'
--      AND t.status = 'completed' AND e.created_at >= '<inicio da execucao>' AND e.created_at < '<fim da execucao>';
--   e depois: DELETE FROM public.task_events e WHERE e.event_type = 'completed' AND e.note LIKE 'Encerrada automaticamente; %' AND e.created_at >= ... AND e.created_at < ...;

-- ===== 1) PREVIEW / DRY-RUN (somente leitura; uma única consulta) =====
-- decisao = 'CONCLUI' (seria concluída) ou 'PULA: ganho sem evento won' (negócio sem horário de ganho; task_id vazio, tarefas_abertas_do_contato preenchido).
WITH won AS (
  SELECT o.id, o.organization_id, o.contact_id,
         (SELECT max(e.created_at) FROM public.opportunity_events e WHERE e.opportunity_id = o.id AND e.event_type = 'won') AS won_at
    FROM public.opportunities o WHERE o.status = 'won'
), cand AS (
  SELECT DISTINCT ON (t.id) t.id AS task_id, t.type, t.status, t.assignee_type, t.assignee_id, t.contact_id, t.created_at AS tarefa_criada_em,
         t.opportunity_id AS opp_da_tarefa, w.id AS opportunity_id, w.won_at AS ganho_em
    FROM won w
    JOIN public.tasks t ON t.organization_id = w.organization_id AND t.status IN ('pending', 'in_progress', 'rescheduled') AND t.created_at <= w.won_at
         AND (t.opportunity_id = w.id
              OR (t.opportunity_id IS NULL AND t.contact_id = w.contact_id
                  AND NOT EXISTS (SELECT 1 FROM public.opportunities z WHERE z.organization_id = w.organization_id AND z.contact_id = w.contact_id AND z.status = 'open' AND z.id <> w.id)))
   WHERE w.won_at IS NOT NULL
   ORDER BY t.id, (t.opportunity_id = w.id) DESC, w.won_at DESC, w.id
)
SELECT 'CONCLUI' AS decisao, c.task_id, c.type, c.status AS status_atual, c.assignee_type, c.assignee_id, wc.name AS contato, wc.phone AS telefone,
       c.opportunity_id, CASE WHEN c.opp_da_tarefa = c.opportunity_id THEN 'ligada ao negocio' ELSE 'sem negocio (contato sem outro aberto)' END AS motivo,
       c.tarefa_criada_em, c.ganho_em, floor(extract(epoch FROM (now() - c.ganho_em)) / 86400)::int AS dias_desde_ganho, NULL::bigint AS tarefas_abertas_do_contato
  FROM cand c JOIN public.wa_contacts wc ON wc.id = c.contact_id
UNION ALL
SELECT 'PULA: ganho sem evento won', NULL, NULL, NULL, NULL, NULL, wc.name, wc.phone, w.id, 'sem horario de ganho: revisar manualmente', NULL, NULL, NULL,
       (SELECT count(*) FROM public.tasks t WHERE t.organization_id = w.organization_id AND t.status IN ('pending', 'in_progress', 'rescheduled') AND (t.opportunity_id = w.id OR t.contact_id = w.contact_id))
  FROM won w JOIN public.wa_contacts wc ON wc.id = w.contact_id
 WHERE w.won_at IS NULL
   AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.organization_id = w.organization_id AND t.status IN ('pending', 'in_progress', 'rescheduled') AND (t.opportunity_id = w.id OR t.contact_id = w.contact_id))
 ORDER BY 1, 7, 9;

-- ===== 2) APLICAR: rode só depois de conferir o preview. UMA instrução, autocommit (não há BEGIN/ROLLBACK; o preview é o dry-run) =====
-- Devolve (opportunity_id, task_id, previous_status) de cada tarefa concluída; o status anterior também fica na nota do task_event.
SELECT w.id AS opportunity_id, c.task_id, c.previous_status
  FROM (SELECT o.id, (SELECT max(e.created_at) FROM public.opportunity_events e WHERE e.opportunity_id = o.id AND e.event_type = 'won') AS won_at
          FROM public.opportunities o WHERE o.status = 'won'
         ORDER BY 2 DESC NULLS LAST, 1 OFFSET 0) w
 CROSS JOIN LATERAL public._complete_tasks_of_won_opportunity(w.id, w.won_at) c
 WHERE w.won_at IS NOT NULL;
