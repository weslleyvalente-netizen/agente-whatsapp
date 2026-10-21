-- Negócio marcado como GANHO encerra as tarefas abertas dele (em produção: tarefas ficavam in_progress/atrasadas para sempre
-- depois da venda). Feito no banco para cobrir todos os caminhos (web, API, ferramentas da IA, funções SQL).
--
-- Regra (gatilho AFTER UPDATE OF status em public.opportunities, só quando NEW.status='won' e OLD.status <> 'won'):
--   tarefas da MESMA organização, abertas (pending, in_progress, rescheduled), humanas e da IA, que
--     (a) apontam para este negócio (opportunity_id = NEW.id); ou
--     (b) não apontam para nenhum negócio (opportunity_id IS NULL), são do mesmo contato, e o contato NÃO tem outro negócio ABERTO.
--   viram status='completed', completed_at=now(); updated_at é mantido por trg_tasks_updated_at (BEFORE UPDATE).
--   Auditoria: task_events (event_type 'completed', o mesmo da conclusão manual em apps/api task.service.ts) com nota
--   'Encerrada automaticamente: negócio <id> ganho', created_by_type 'ai' (a constraint só aceita ai/human; 'ai' é o que os
--   gatilhos SQL já usam, ex.: opportunity_auto_linked) e created_by_id NULL.
--   NÃO mexe em: tarefas de outros contatos/organizações, tarefas já concluídas/canceladas, tarefas ligadas a OUTRO negócio,
--   negócios perdidos (decisão à parte). Reabrir o negócio não reabre tarefas.
--
-- Núcleo compartilhado: public._complete_tasks_of_won_opportunity(opp_id) devolve os ids concluídos (o backfill usa o mesmo núcleo).
--
-- INTERAÇÕES
--   * trg_human_task_opens_opportunity (AFTER INSERT OR UPDATE OF assignee_type,status em tasks): dispara com status='completed',
--     o filtro barato dele só aceita pending/in_progress/rescheduled e devolve cedo: concluir não abre negócio.
--   * trg_tasks_updated_at (BEFORE UPDATE em tasks): só atualiza updated_at.
--   * trg_owner_on_opportunity_open (BEFORE INSERT em opportunities) e trg_sync_owner_on_conversation_assign (conversations):
--     não escutam status de negócio nem tarefas; sem relação.
--   * set_opportunity_freeze / refresh_freeze_task: refresh_freeze_task trava a tarefa (FOR UPDATE) e atualiza só tarefas de
--     congelamento; este gatilho não chama nenhum dos dois. Tarefa de congelamento aberta do negócio ganho também é concluída
--     (ela perde o sentido); depois disso refresh_freeze_task numa tarefa concluída só reescreve apresentação, sem reabrir.
--   * Sem recursão: o gatilho escuta UPDATE OF status em opportunities e só escreve em tasks/task_events; nenhum gatilho de
--     tasks escreve em opportunities. Sem UPDATE em opportunities aqui (next_action_due_date de negócio ganho fica como está:
--     clearStaleNextAction só age em negócios abertos e o funil não lista ganhos).
--   * UPDATE em lote: o gatilho é AFTER ROW, roda depois da instrução inteira; ao avaliar "outro negócio aberto" já enxerga todos
--     os negócios ganhos pela mesma instrução. Dois negócios do mesmo contato ganhos juntos: resultado igual em qualquer ordem.
--
-- ORDEM DE LOCKS: (1) o UPDATE já travou a linha do negócio; (2) aqui só se travam linhas de TASKS, em ordem de id, com
--   FOR UPDATE SKIP LOCKED. Nenhum lock de contato é tomado (diferente de sync_sales_pipeline, que faz contato -> negócio -> tarefas),
--   e nenhum lock de negócio é tomado depois de um lock de tarefa. Mesma direção de set_opportunity_freeze (negócio -> tarefas).
--   Como nunca espera lock de tarefa, não forma ciclo de espera e não derruba o markWon por deadlock. Contrapartida: tarefa
--   travada por outra transação naquele instante é PULADA (some do fechamento); o backfill (mesma função) pega o resto.
--   Leituras (existência de outro negócio aberto) são sem lock.
--
-- Idempotente. NÃO altera dados existentes (backfill separado: supabase/backfills/20261022_complete_tasks_of_won_deals.sql).
-- Reverter: DROP TRIGGER IF EXISTS trg_won_closes_open_tasks ON public.opportunities;
--   DROP FUNCTION IF EXISTS public.won_closes_open_tasks(); DROP FUNCTION IF EXISTS public._complete_tasks_of_won_opportunity(uuid);
--   Tarefas já concluídas por ele: task_events.note LIKE 'Encerrada automaticamente: negócio %' (o status anterior não é guardado
--   por tarefa; era um dos três abertos, o backfill devolve os ids e o status anterior não é recuperável sem a lista).

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public._complete_tasks_of_won_opportunity(p_opportunity_id uuid)
RETURNS SETOF uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o public.opportunities;
BEGIN
  SELECT * INTO o FROM public.opportunities WHERE id = p_opportunity_id;
  IF NOT FOUND OR o.status IS DISTINCT FROM 'won' THEN RETURN; END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT x.id FROM public.tasks x
     WHERE x.organization_id = o.organization_id
       AND x.status IN ('pending', 'in_progress', 'rescheduled')
       AND (x.opportunity_id = o.id
            OR (x.opportunity_id IS NULL AND x.contact_id = o.contact_id
                AND NOT EXISTS (SELECT 1 FROM public.opportunities z
                                 WHERE z.organization_id = o.organization_id AND z.contact_id = o.contact_id
                                   AND z.status = 'open' AND z.id <> o.id)))
     ORDER BY x.id
       FOR UPDATE SKIP LOCKED),
  done AS (
    UPDATE public.tasks t SET status = 'completed', completed_at = now()
     WHERE t.id IN (SELECT id FROM picked)
    RETURNING t.id, t.organization_id),
  ev AS (
    INSERT INTO public.task_events(task_id, organization_id, event_type, note, created_by_type)
    SELECT id, organization_id, 'completed', 'Encerrada automaticamente: negócio ' || o.id::text || ' ganho', 'ai' FROM done
    RETURNING task_id)
  SELECT id FROM done;
END $$;

CREATE OR REPLACE FUNCTION public.won_closes_open_tasks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'won' AND OLD.status IS DISTINCT FROM 'won' THEN
    PERFORM public._complete_tasks_of_won_opportunity(NEW.id);
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public._complete_tasks_of_won_opportunity(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.won_closes_open_tasks() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_won_closes_open_tasks ON public.opportunities;
CREATE TRIGGER trg_won_closes_open_tasks
  AFTER UPDATE OF status ON public.opportunities
  FOR EACH ROW WHEN (NEW.status = 'won' AND OLD.status IS DISTINCT FROM 'won')
  EXECUTE FUNCTION public.won_closes_open_tasks();
