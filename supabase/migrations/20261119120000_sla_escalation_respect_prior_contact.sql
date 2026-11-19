-- Escalada de SLA: cliente que o vendedor JÁ atendeu não troca de dono.
--
-- Caso real (18/11): o Márcio atendeu o cliente na quarta (mensagens e áudios), o cliente voltou, a IA abriu novo pedido de atendimento
-- e o SLA estourou sem resposta. A escalada olhava só mensagens humanas "desde o handoff" e passou o cliente à Marina.
--
-- Regra nova: só troca de vendedor quem nunca entrou em contato depois que a IA atendeu. Para atribuições 'existing_owner' (dono da
-- carteira), qualquer mensagem role='human_agent' na conversa a partir do PRIMEIRO handoff dela conta como "já atendido".
-- Atribuição 'manual' mantém o critério anterior (mensagens desde a atribuição): o gestor escolheu um vendedor novo e o histórico de
-- outro vendedor não prova que ESTE atendeu. Histórico humano anterior ao primeiro handoff (conversa antiga) continua sem bloquear.
-- O rodízio de lead novo ('redistribute') já só troca quando o vendedor não respondeu; não muda.
--
-- Só redefine _alert_assignment_answered (CREATE OR REPLACE); usada por escalate_alert_assignment e list_escalation_candidates.
-- Reverter: reaplicar a definição de 20261027120200_sla_alert_escalation.sql (since = handoff_at). NÃO aplicada automaticamente.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public._alert_assignment_answered(a public.lead_assignments)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE since timestamptz; conv_status text;
BEGIN
  since := CASE WHEN a.reason = 'manual' THEN a.assigned_at
                ELSE LEAST(a.handoff_at, COALESCE((SELECT min(h.handed_at) FROM public.handoff_events h WHERE h.conversation_id = a.conversation_id), a.handoff_at)) END;
  IF a.first_human_message_at IS NOT NULL OR a.accepted_at IS NOT NULL THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = a.conversation_id AND m.organization_id = a.organization_id
               AND m.role = 'human_agent' AND m.created_at >= since) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.sales_call_logs l WHERE l.organization_id = a.organization_id AND l.called_at >= a.assigned_at
               AND (l.contact_id = a.contact_id OR l.opportunity_id IN (SELECT o.id FROM public.opportunities o WHERE o.organization_id = a.organization_id AND o.contact_id = a.contact_id))) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.opportunities o WHERE o.organization_id = a.organization_id AND o.contact_id = a.contact_id AND o.status = 'open'
               AND o.last_commercial_activity_at >= a.assigned_at) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.task_events te JOIN public.tasks t ON t.id = te.task_id
              WHERE t.organization_id = a.organization_id AND t.contact_id = a.contact_id AND te.created_by_type = 'human' AND te.created_at >= a.assigned_at) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.opportunity_events e JOIN public.opportunities o ON o.id = e.opportunity_id
              WHERE o.organization_id = a.organization_id AND o.contact_id = a.contact_id AND e.changed_by_type = 'human' AND e.created_at >= a.assigned_at) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.conversation_notes n WHERE n.conversation_id = a.conversation_id AND n.created_at >= a.assigned_at) THEN RETURN true; END IF;
  SELECT status INTO conv_status FROM public.conversations WHERE id = a.conversation_id;
  IF conv_status IS NOT NULL AND conv_status NOT IN ('open', 'waiting') THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.opportunities o WHERE o.organization_id = a.organization_id AND o.contact_id = a.contact_id
               AND o.status IN ('won', 'lost') AND o.updated_at >= a.handoff_at) THEN RETURN true; END IF;
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION public._alert_assignment_answered(public.lead_assignments) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._alert_assignment_answered(public.lead_assignments) TO service_role;
