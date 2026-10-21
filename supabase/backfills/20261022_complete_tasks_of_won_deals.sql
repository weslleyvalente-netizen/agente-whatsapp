-- Backfill: aplica a regra de 20261022120000_won_closes_open_tasks.sql às tarefas abertas que JÁ pertencem a negócios ganhos.
-- NÃO rode antes de aplicar a migration (usa public._complete_tasks_of_won_opportunity: mesma regra do gatilho).
-- Passos: (1) rode o PREVIEW e confira; (2) rode o bloco APLICAR, que termina em ROLLBACK; confira os ids devolvidos;
-- (3) só então troque ROLLBACK por COMMIT e rode de novo. Este arquivo NUNCA confirma sozinho.
-- Regra: tarefa aberta (pending/in_progress/rescheduled), humana ou da IA, da mesma organização, que (a) aponta para o negócio
-- ganho, ou (b) não aponta para negócio nenhum, é do contato do negócio ganho e o contato não tem outro negócio ABERTO.
-- Negócios perdidos não entram. Tarefas travadas por outra transação são puladas (SKIP LOCKED); rode de novo depois.
--
-- REVERSÃO: o status anterior (pending, in_progress ou rescheduled) NÃO é guardado por tarefa. O bloco APLICAR devolve
-- (opportunity_id, task_id): SALVE essa lista (cole em um arquivo/comentário) antes do COMMIT. Sem a lista, só dá para achar as
-- tarefas pelo task_events 'completed' com nota 'Encerrada automaticamente: negócio ...' e o status anterior é irrecuperável.
-- Para desfazer com a lista: UPDATE public.tasks SET status = 'pending', completed_at = NULL WHERE id IN (<ids>) AND status = 'completed';
-- (escolha o status certo por tarefa se o preview mostrou in_progress/rescheduled) e apague os task_events correspondentes.

-- ===== 1) PREVIEW (somente leitura): toda tarefa que seria concluída =====
SELECT DISTINCT ON (t.id)
       t.id AS task_id, t.type, t.status AS status_atual, t.assignee_type, t.assignee_id,
       w.name AS contato, w.phone AS telefone, o.id AS opportunity_id,
       CASE WHEN t.opportunity_id = o.id THEN 'ligada ao negocio' ELSE 'sem negocio (contato sem outro aberto)' END AS motivo,
       floor(extract(epoch FROM (now() - coalesce((SELECT max(e.created_at) FROM public.opportunity_events e WHERE e.opportunity_id = o.id AND e.event_type = 'won'), o.updated_at))) / 86400)::int AS dias_desde_ganho
  FROM public.opportunities o
  JOIN public.tasks t ON t.organization_id = o.organization_id AND t.status IN ('pending', 'in_progress', 'rescheduled')
       AND (t.opportunity_id = o.id
            OR (t.opportunity_id IS NULL AND t.contact_id = o.contact_id
                AND NOT EXISTS (SELECT 1 FROM public.opportunities z WHERE z.organization_id = o.organization_id AND z.contact_id = o.contact_id AND z.status = 'open' AND z.id <> o.id)))
  JOIN public.wa_contacts w ON w.id = o.contact_id
 WHERE o.status = 'won'
 ORDER BY t.id, (t.opportunity_id = o.id) DESC;

-- ===== 2) APLICAR (transação; termina em ROLLBACK) =====
BEGIN;
SELECT o.id AS opportunity_id, tid AS task_id
  FROM public.opportunities o
 CROSS JOIN LATERAL public._complete_tasks_of_won_opportunity(o.id) AS tid
 WHERE o.status = 'won'
 ORDER BY o.id, tid;
ROLLBACK;
-- COMMIT;  -- troque o ROLLBACK acima por COMMIT só depois de conferir e salvar a lista de ids
