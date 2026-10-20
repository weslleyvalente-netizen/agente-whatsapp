-- Tarefa humana aberta para um cliente SEM negócio aberto cria o negócio (card no funil / fila "Pronto para assumir").
-- Sem isso, tarefas do vendedor só aparecem em Tarefas/"Hoje" (o funil é montado a partir de opportunities).
-- Regras:
--   * só age com organizations.settings.sales_auto_pipeline_enabled = true (mesma flag da criação automática);
--   * só tarefa humana (assignee_type='human') e aberta (pending/in_progress/rescheduled); tarefas da IA nunca abrem negócio;
--   * não age se o contato já tem negócio aberto (de qualquer dono) nem se o telefone está em organization_ignored_contacts;
--   * etapa inicial = a da criação automática (sync_sales_pipeline): stage 'interest_received'; operação = a do último negócio
--     do contato (qualquer status) ou 'vehicle_sale' quando não há histórico (o negócio aparece em "Pronto para assumir" porque
--     a fila deriva de "tarefa humana pendente + exatamente 1 negócio aberto", não da etapa);
--   * dono: assignee_id da tarefa se for vendedor cadastrado (sales_reps), senão NULL e o gatilho BEFORE INSERT
--     trg_owner_on_opportunity_open (20261020120000) herda o vendedor da conversa; o gatilho de conversa
--     (trg_sync_owner_on_conversation_assign) só reage a UPDATE de conversations.assigned_to, então não há laço;
--   * corrida: trava a linha do contato (FOR UPDATE, o mesmo lock de sync_sales_pipeline) e reconfere antes de inserir.
--     Não há índice único parcial de "1 negócio aberto por contato" em produção (e criá-lo poderia falhar com dados antigos).
-- Idempotente (CREATE OR REPLACE / DROP TRIGGER IF EXISTS). Não altera dados existentes: o backfill é um script separado.
-- Reverter: DROP TRIGGER IF EXISTS trg_human_task_opens_opportunity ON public.tasks;
--           DROP FUNCTION IF EXISTS public.human_task_opens_opportunity();
CREATE OR REPLACE FUNCTION public.human_task_opens_opportunity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_opp uuid; v_owner uuid; v_operation text;
BEGIN
  IF NEW.assignee_type IS DISTINCT FROM 'human' OR NEW.status NOT IN ('pending', 'in_progress', 'rescheduled') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = NEW.organization_id AND settings->'sales_auto_pipeline_enabled' = 'true'::jsonb) THEN
    RETURN NEW;
  END IF;
  -- Serializa por contato (mesmo lock do sync_sales_pipeline) e só então confere se já existe negócio aberto.
  PERFORM 1 FROM public.wa_contacts WHERE id = NEW.contact_id AND organization_id = NEW.organization_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.organization_ignored_contacts i JOIN public.wa_contacts w ON w.organization_id = i.organization_id AND w.phone = i.phone
              WHERE w.id = NEW.contact_id AND w.organization_id = NEW.organization_id) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.opportunities WHERE organization_id = NEW.organization_id AND contact_id = NEW.contact_id AND status = 'open') THEN
    RETURN NEW;
  END IF;

  IF NEW.assignee_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = NEW.organization_id AND r.user_id = NEW.assignee_id) THEN
    v_owner := NEW.assignee_id;
  END IF;
  SELECT o.operation INTO v_operation FROM public.opportunities o
   WHERE o.organization_id = NEW.organization_id AND o.contact_id = NEW.contact_id
   ORDER BY o.created_at DESC, o.id LIMIT 1;
  v_operation := coalesce(v_operation, 'vehicle_sale');

  INSERT INTO public.opportunities(organization_id, contact_id, operation, initial_operation, stage, status, owner_id, owner_assigned_at, last_progress_at)
  VALUES (NEW.organization_id, NEW.contact_id, v_operation, v_operation, 'interest_received', 'open', v_owner, CASE WHEN v_owner IS NOT NULL THEN now() END, now())
  RETURNING id INTO v_opp;

  INSERT INTO public.opportunity_events(organization_id, opportunity_id, event_type, new_value, evidence, changed_by_type)
  VALUES (NEW.organization_id, v_opp, 'created', jsonb_build_object('operation', v_operation, 'stage', 'interest_received', 'task_id', NEW.id),
          'Negócio criado porque o vendedor recebeu uma tarefa sem negócio', 'system');

  -- UPDATE de opportunity_id não reaciona o gatilho (ele só escuta assignee_type e status).
  UPDATE public.tasks SET opportunity_id = v_opp WHERE id = NEW.id AND opportunity_id IS NULL;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.human_task_opens_opportunity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_human_task_opens_opportunity ON public.tasks;
CREATE TRIGGER trg_human_task_opens_opportunity
  AFTER INSERT OR UPDATE OF assignee_type, status ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.human_task_opens_opportunity();
