-- Escalada de SLA: cliente que o vendedor ATUAL já atendeu não troca de dono.
--
-- Caso real (18/11): o Márcio atendeu o cliente na quarta (mensagens e áudios), o cliente voltou, a IA abriu novo pedido de atendimento
-- e o SLA estourou sem resposta. A escalada olhava só mensagens humanas "desde o handoff" e passou o cliente à Marina.
--
-- O QUE CONTA como "já atendido" (atribuições 'existing_owner' e demais não-manuais; o rodízio de lead novo não passa por aqui):
--   * mensagem role='human_agent' CONFIRMADA (evolution_message_id preenchido) e SEM falha (metadata.send_failed_at nulo);
--   * criada a partir do marco  GREATEST(1º handoff da conversa, LEAST(início do período do vendedor atual, handoff desta atribuição)):
--       - 1º handoff = primeira vez que a IA encaminhou a conversa (histórico humano mais antigo não protege ninguém);
--       - período do vendedor atual = a partir da 1ª atribuição dele depois da última atribuição de OUTRO vendedor na conversa
--         (mensagens do tempo de outro vendedor não protegem; linhas de exceção sem vendedor não quebram o período).
-- LIMITES CONHECIDOS: a tabela messages não guarda o autor. Dentro do período do vendedor atual, uma mensagem humana enviada por outra
--   pessoa (ex.: o gestor pelo painel) é atribuída a ele; o autor só é conhecido no marco first_human_message_by da atribuição.
-- Atribuição 'manual' mantém o critério anterior (mensagens desde a atribuição), agora também só mensagens confirmadas e sem falha.
-- O rodízio de lead novo ('redistribute') já só troca quando o vendedor não respondeu; não muda.
--
-- Só redefine _alert_assignment_answered (CREATE OR REPLACE); usada por escalate_alert_assignment e list_escalation_candidates.
-- Reverter: reaplicar a definição de 20261027120200_sla_alert_escalation.sql (since = handoff_at). NÃO aplicada automaticamente.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public._alert_assignment_answered(a public.lead_assignments)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE since timestamptz; conv_status text; first_handoff timestamptz; prev_other timestamptz; run_start timestamptz;
BEGIN
  IF a.reason = 'manual' THEN
    since := a.assigned_at;
  ELSE
    first_handoff := COALESCE((SELECT min(h.handed_at) FROM public.handoff_events h WHERE h.conversation_id = a.conversation_id), a.handoff_at);
    SELECT max(x.assigned_at) INTO prev_other FROM public.lead_assignments x
     WHERE x.conversation_id = a.conversation_id AND x.rep_id IS NOT NULL AND x.rep_id <> a.rep_id AND x.assigned_at <= a.assigned_at;
    SELECT min(x.assigned_at) INTO run_start FROM public.lead_assignments x
     WHERE x.conversation_id = a.conversation_id AND x.rep_id = a.rep_id AND x.assigned_at <= a.assigned_at AND (prev_other IS NULL OR x.assigned_at > prev_other);
    since := GREATEST(first_handoff, LEAST(COALESCE(run_start, a.assigned_at), a.handoff_at));
  END IF;
  IF a.first_human_message_at IS NOT NULL OR a.accepted_at IS NOT NULL THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = a.conversation_id AND m.organization_id = a.organization_id
               AND m.role = 'human_agent' AND m.evolution_message_id IS NOT NULL AND (m.metadata->>'send_failed_at') IS NULL AND m.created_at >= since) THEN RETURN true; END IF;
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
