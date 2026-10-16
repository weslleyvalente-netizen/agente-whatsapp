-- Quando a conversa é atribuída a um responsável, o negócio aberto e as tarefas humanas abertas do mesmo cliente acompanham.
-- Evita o caso "negócio de um, conversa e tarefa de outro", em que o vendedor vê o card mas não consegue tratar o lead.
-- Cobre todos os caminhos (tela, API e funções do rodízio), pois é um gatilho na própria tabela de conversas. Idempotente.
CREATE OR REPLACE FUNCTION public.sync_owner_on_conversation_assign()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.assigned_to IS NULL OR NEW.assigned_to IS NOT DISTINCT FROM OLD.assigned_to THEN
    RETURN NEW;
  END IF;
  -- Só acompanha quando o novo responsável é um vendedor cadastrado: atribuir a conversa à conta compartilhada (encaminhamento da IA)
  -- não deve tirar o negócio de quem já cuida dele.
  IF NOT EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = NEW.organization_id AND r.user_id = NEW.assigned_to) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.opportunity_events(organization_id, opportunity_id, event_type, previous_value, new_value, evidence, changed_by_type)
  SELECT o.organization_id, o.id, 'owner_changed', jsonb_build_object('owner_id', o.owner_id), jsonb_build_object('owner_id', NEW.assigned_to),
         'Responsável do negócio acompanhou a atribuição da conversa', 'system'
    FROM public.opportunities o
   WHERE o.organization_id = NEW.organization_id AND o.contact_id = NEW.contact_id AND o.status = 'open'
     AND o.owner_id IS DISTINCT FROM NEW.assigned_to;

  UPDATE public.opportunities
     SET owner_id = NEW.assigned_to, owner_assigned_at = now()
   WHERE organization_id = NEW.organization_id AND contact_id = NEW.contact_id AND status = 'open'
     AND owner_id IS DISTINCT FROM NEW.assigned_to;

  UPDATE public.tasks
     SET assignee_id = NEW.assigned_to, assignee_type = 'human'
   WHERE organization_id = NEW.organization_id AND contact_id = NEW.contact_id
     AND status IN ('pending', 'in_progress', 'rescheduled')
     AND assignee_type = 'human' AND assignee_id IS DISTINCT FROM NEW.assigned_to;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.sync_owner_on_conversation_assign() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_owner_on_conversation_assign ON public.conversations;
CREATE TRIGGER trg_sync_owner_on_conversation_assign
  AFTER UPDATE OF assigned_to ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.sync_owner_on_conversation_assign();
