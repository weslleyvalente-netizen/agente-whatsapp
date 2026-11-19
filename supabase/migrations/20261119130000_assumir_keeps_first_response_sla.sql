-- Assumir não encerra o prazo da primeira resposta; só uma mensagem humana CONFIRMADA e SEM FALHA encerra a espera.
--
-- DEPENDE de 20261119120000_sla_escalation_respect_prior_contact.sql (este arquivo redefine _alert_assignment_answered por cima dela).
--
-- Problema: accept_assignment (botão Assumir) move a atribuição para status 'accepted', e TODA a maquinaria de SLA (flag_sla_alerts,
-- redistribute_assignment, escalate_alert_assignment, list_escalation_candidates e os pushes) só olha status 'pending'. Clicar Assumir
-- sem responder tirava o cliente da cobrança e da escalada.
--
-- Decisão (mantém o que já funcionava):
--   * o clique CONTINUA gravando status='accepted', accepted_at e accepted_via='button'/'admin' => o roteamento pelo ÚLTIMO RESPONSÁVEL
--     (_lead_decide lê status='accepted') e o selo "assumido" do web ficam exatamente como estão;
--   * NOVA coluna lead_assignments.awaiting_first_response (default false): accept_assignment (button/admin) e o aceite pela 1ª mensagem do
--     painel a ligam; "assumida e ainda sem resposta confirmada" passa a contar como "aguardando 1ª resposta" para todas as funções de SLA;
--   * sla_due_at é imutável (guarda da tabela): o prazo NÃO reinicia com o clique.
--   * linhas aceitas ANTES desta migração têm a coluna false: nada do passado é cobrado nem movido (sem efeito em massa ao implantar).
--
-- O que ENCERRA a espera (_awaiting_first_response deixa de valer):
--   * atribuição de carteira ('alert': dono existente / manual): _alert_assignment_answered (mensagem confirmada sem falha, ligação, tarefa,
--     nota, atividade comercial, negócio ganho/perdido...);
--   * rodízio de lead novo ('redistribute'): mensagem humana confirmada e sem falha desde a atribuição.
--   "Confirmada" = evolution_message_id preenchido; "sem falha" = metadata.send_failed_at nulo. Mensagem EM VOO (salva, ainda sem id e sem
--   falha, com menos de 10 min) também suspende a troca: a próxima varredura a vê confirmada (encerra) ou falhada (volta a cobrar).
--   CORREÇÃO junto: o marco first_human_message_at / aceite 'first_message' e a atividade comercial do negócio (last_commercial_activity_at)
--   são gravados quando o envio é PEDIDO, não quando chega. Se só houver mensagens com falha (nenhuma confirmada nem em voo) desde a
--   atribuição, o marco deixa de contar como resposta e a atividade comercial feita dentro da JANELA DE ENVIO também não conta.
--   JANELA DE ENVIO = 10 min contados da criação da mensagem (o mesmo prazo em que uma mensagem em voo adia a decisão):
--     * em voo (sem id, sem falha, < 10 min): adia a troca/redistribuição por no máximo 10 min;
--     * falhou (send_failed_at) em qualquer momento, inclusive depois de 1 min: a cobrança volta na varredura seguinte;
--     * presa (sem id, sem falha, > 10 min): tratada como NÃO ENVIADA, não adia mais;
--     * a atividade gravada no pedido de envio (que pode ocorrer minutos depois da criação da mensagem, em anexo/áudio lento) é ignorada
--       dentro da janela; ligação, tarefa, nota e atividade DEPOIS da janela continuam valendo.
--
-- Efeito por tipo de atribuição depois do clique, sem resposta, com o prazo vencido:
--   carteira ('alert'): flag_sla_alerts marca sla_breached (push "SLA estourado" ao dono + quadro "Atraso no atendimento"); aos 2x o SLA a
--     escalada troca o vendedor UMA vez por cadeia, se ninguém o atendeu (regra da 110: atendimento comprovado protege).
--   rodízio ('redistribute'): redistribute_assignment passa o lead ao próximo vendedor (como já fazia com o lead pendente).
-- Depois que há atendimento comprovado: novos atrasos (novo encaminhamento) geram cobrança mantendo o responsável (regra da 110).
--
-- Corrida (mesma ordem de locks de sempre: estado da organização -> linha da atribuição FOR UPDATE):
--   resposta primeiro => a função vê a mensagem (confirmada ou em voo) e não troca; troca primeiro => a nova atribuição nasce, a resposta
--   tardia (anterior à nova atribuição) só registra atividade comercial e o lead não volta (no máximo uma escalada por cadeia).
--
-- Reverter: DROP das funções novas e recriação das antigas (20261007120200 accept/record/flag, 20261007120400 redistribute,
--   20261027120200 escalate/list_escalation_candidates, 20261119120000 _alert_assignment_answered); a coluna pode ficar (inócua).
-- NÃO aplicada automaticamente.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.lead_assignments ADD COLUMN IF NOT EXISTS awaiting_first_response boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS lead_assignments_awaiting_first_response ON public.lead_assignments (sla_due_at) WHERE status = 'accepted' AND awaiting_first_response;

-- Mensagens humanas por situação de envio, desde um instante.
CREATE OR REPLACE FUNCTION public._human_msg_confirmed(p_org uuid, p_conv uuid, p_since timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = p_conv AND m.organization_id = p_org AND m.role = 'human_agent'
                   AND m.evolution_message_id IS NOT NULL AND (m.metadata->>'send_failed_at') IS NULL AND m.created_at >= p_since)
$$;
CREATE OR REPLACE FUNCTION public._human_msg_in_flight(p_org uuid, p_conv uuid, p_since timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = p_conv AND m.organization_id = p_org AND m.role = 'human_agent'
                   AND m.evolution_message_id IS NULL AND (m.metadata->>'send_failed_at') IS NULL
                   AND m.created_at >= GREATEST(p_since, now() - interval '10 minutes'))
$$;
-- NÃO ENVIADA: sem id do WhatsApp e (marcada como falha OU parada há mais de 10 min). Mensagem presa não pode adiar a decisão para sempre.
CREATE OR REPLACE FUNCTION public._human_msg_unsent(p_org uuid, p_conv uuid, p_since timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = p_conv AND m.organization_id = p_org AND m.role = 'human_agent'
                   AND m.evolution_message_id IS NULL AND m.created_at >= p_since
                   AND ((m.metadata->>'send_failed_at') IS NOT NULL OR m.created_at < now() - interval '10 minutes'))
$$;

-- "Já atendido" (carteira): igual à 20261119120000, com duas correções: mensagem EM VOO também vale (suspende a troca) e o marco de primeira
-- mensagem não vale quando só há mensagens com falha desde a atribuição.
CREATE OR REPLACE FUNCTION public._alert_assignment_answered(a public.lead_assignments)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE since timestamptz; conv_status text; first_handoff timestamptz; prev_other timestamptz; run_start timestamptz; opp_since timestamptz := a.assigned_at;
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
  -- Marco de primeira mensagem / aceite por mensagem: só vale se o envio não falhou (o botão Assumir, sozinho, nunca vale).
  IF (a.first_human_message_at IS NOT NULL OR a.accepted_via IN ('first_message', 'phone_echo'))
     AND NOT (public._human_msg_unsent(a.organization_id, a.conversation_id, a.assigned_at)
              AND NOT public._human_msg_confirmed(a.organization_id, a.conversation_id, a.assigned_at)
              AND NOT public._human_msg_in_flight(a.organization_id, a.conversation_id, a.assigned_at)) THEN RETURN true; END IF;
  IF public._human_msg_confirmed(a.organization_id, a.conversation_id, since) OR public._human_msg_in_flight(a.organization_id, a.conversation_id, since) THEN RETURN true; END IF;
  -- Devolução manual a vendedor com atendimento anterior comprovado (autoria registrada, mensagem confirmada e sem falha no período dele).
  IF a.reason = 'manual' AND a.rep_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.lead_assignments y JOIN public.sales_reps r ON r.id = y.rep_id
        WHERE y.conversation_id = a.conversation_id AND y.rep_id = a.rep_id AND y.assigned_at < a.assigned_at
          AND y.first_human_message_at IS NOT NULL AND (y.first_human_message_by = r.user_id OR y.accepted_via = 'phone_echo')
          AND EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = a.conversation_id AND m.organization_id = a.organization_id
                        AND m.role = 'human_agent' AND m.evolution_message_id IS NOT NULL AND (m.metadata->>'send_failed_at') IS NULL
                        AND m.created_at >= y.assigned_at
                        AND m.created_at < COALESCE((SELECT min(z.assigned_at) FROM public.lead_assignments z
                                                      WHERE z.conversation_id = a.conversation_id AND z.rep_id IS NOT NULL AND z.rep_id <> a.rep_id AND z.assigned_at > y.assigned_at), a.assigned_at))
     ) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.sales_call_logs l WHERE l.organization_id = a.organization_id AND l.called_at >= a.assigned_at
               AND (l.contact_id = a.contact_id OR l.opportunity_id IN (SELECT o.id FROM public.opportunities o WHERE o.organization_id = a.organization_id AND o.contact_id = a.contact_id))) THEN RETURN true; END IF;
  -- record_human_message grava last_commercial_activity_at quando o envio é PEDIDO (antes de saber se saiu). Se só houve envio NÃO ENVIADO
  -- (falhou ou ficou preso), a atividade comercial feita dentro da JANELA DE ENVIO (10 min após a criação da última dessas mensagens)
  -- não conta como atendimento. Ligação, tarefa, nota e atividade depois da janela continuam valendo.
  IF public._human_msg_unsent(a.organization_id, a.conversation_id, a.assigned_at)
     AND NOT public._human_msg_confirmed(a.organization_id, a.conversation_id, a.assigned_at)
     AND NOT public._human_msg_in_flight(a.organization_id, a.conversation_id, a.assigned_at) THEN
    opp_since := GREATEST(a.assigned_at, (SELECT max(m.created_at) FROM public.messages m WHERE m.conversation_id = a.conversation_id AND m.organization_id = a.organization_id
                                              AND m.role = 'human_agent' AND m.evolution_message_id IS NULL AND m.created_at >= a.assigned_at
                                              AND ((m.metadata->>'send_failed_at') IS NOT NULL OR m.created_at < now() - interval '10 minutes')) + interval '10 minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.opportunities o WHERE o.organization_id = a.organization_id AND o.contact_id = a.contact_id AND o.status = 'open'
               AND o.last_commercial_activity_at >= opp_since) THEN RETURN true; END IF;
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

-- A atribuição ainda espera a primeira resposta? (autoridade única para as funções de SLA)
--   pendente: sim (como sempre);  assumida (awaiting_first_response): sim enquanto não houver resposta confirmada.
CREATE OR REPLACE FUNCTION public._awaiting_first_response(a public.lead_assignments)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.status = 'pending'
      OR (a.status = 'accepted' AND a.awaiting_first_response AND a.rep_id IS NOT NULL
          AND CASE WHEN a.sla_action = 'alert' THEN NOT public._alert_assignment_answered(a)
                   ELSE NOT public._human_msg_confirmed(a.organization_id, a.conversation_id, a.assigned_at)
                    AND NOT public._human_msg_in_flight(a.organization_id, a.conversation_id, a.assigned_at) END)
$$;

-- Assumir: confirma o atendimento (status 'accepted', roteamento e selo como antes) e liga o acompanhamento da primeira resposta.
-- Dois cliques / admin depois do vendedor: o segundo encontra status <> 'pending' e devolve false, sem mudar nada.
CREATE OR REPLACE FUNCTION public.accept_assignment(p_assignment_id uuid, p_actor uuid, p_actor_is_admin boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; rep public.sales_reps;
BEGIN
  SELECT * INTO a FROM public.lead_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF a.id IS NULL OR a.status <> 'pending' THEN RETURN false; END IF;
  SELECT * INTO rep FROM public.sales_reps WHERE id = a.rep_id;
  IF NOT COALESCE(p_actor_is_admin, false) AND p_actor IS DISTINCT FROM rep.user_id THEN
    RAISE EXCEPTION 'Somente o vendedor atribuído (ou um admin) pode assumir o lead';
  END IF;
  UPDATE public.lead_assignments
     SET status = 'accepted', accepted_at = now(), awaiting_first_response = true,
         accepted_via = CASE WHEN COALESCE(p_actor_is_admin, false) AND p_actor IS DISTINCT FROM rep.user_id THEN 'admin' ELSE 'button' END
   WHERE id = a.id;
  RETURN true;
END $$;

-- Igual à 20261007120200; a única mudança: o aceite pela 1ª mensagem do PAINEL liga awaiting_first_response (a mensagem só vale quando for confirmada).
CREATE OR REPLACE FUNCTION public.record_human_message(p_organization_id uuid, p_conversation_id uuid, p_at timestamptz, p_author uuid, p_via text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; rep public.sales_reps; conv_user uuid; may_accept boolean := false;
BEGIN
  IF p_via IS NULL OR p_via NOT IN ('panel','phone_echo') THEN RAISE EXCEPTION 'Origem inválida'; END IF;
  SELECT * INTO a FROM public.lead_assignments
   WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id AND status IN ('pending','accepted') FOR UPDATE;
  IF a.id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO rep FROM public.sales_reps WHERE id = a.rep_id;
  IF p_at < a.assigned_at THEN
    UPDATE public.opportunities SET last_commercial_activity_at = GREATEST(COALESCE(last_commercial_activity_at, p_at), p_at)
     WHERE organization_id = p_organization_id AND contact_id = a.contact_id AND status = 'open';
    RETURN a.id;
  END IF;
  IF a.first_human_message_at IS NULL THEN
    UPDATE public.lead_assignments SET first_human_message_at = p_at, first_human_message_by = p_author WHERE id = a.id;
  END IF;
  UPDATE public.opportunities SET last_commercial_activity_at = GREATEST(COALESCE(last_commercial_activity_at, p_at), p_at)
   WHERE organization_id = p_organization_id AND contact_id = a.contact_id AND status = 'open';
  IF a.status = 'pending' THEN
    IF p_via = 'panel' THEN may_accept := p_author IS NOT DISTINCT FROM rep.user_id;
    ELSE
      SELECT assigned_to INTO conv_user FROM public.conversations WHERE id = p_conversation_id;
      may_accept := p_author IS NULL AND conv_user IS NOT DISTINCT FROM rep.user_id;
    END IF;
    IF may_accept THEN
      UPDATE public.lead_assignments SET status = 'accepted', accepted_at = p_at, awaiting_first_response = (p_via = 'panel'),
             accepted_via = CASE WHEN p_via = 'panel' THEN 'first_message' ELSE 'phone_echo' END WHERE id = a.id;
    END IF;
  END IF;
  RETURN a.id;
END $$;

-- Alerta de SLA (carteira): também para a atribuição assumida que ainda não foi respondida.
CREATE OR REPLACE FUNCTION public.flag_sla_alerts() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE public.lead_assignments SET sla_breached = true
   WHERE sla_action = 'alert' AND sla_due_at <= now() AND NOT sla_breached AND status IN ('pending', 'accepted')
     AND public._awaiting_first_response(lead_assignments);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Rodízio de lead novo: igual à v2 (20261007120400); só o filtro de "ainda espera a 1ª resposta" muda.
CREATE OR REPLACE FUNCTION public.redistribute_assignment(p_assignment_id uuid, p_new_sla_due_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; cur public.sales_reps; nxt public.sales_reps; new_id uuid; opp_id uuid; org uuid; s jsonb;
BEGIN
  SELECT organization_id INTO org FROM public.lead_assignments WHERE id = p_assignment_id;
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.lead_distribution_state WHERE organization_id = org FOR UPDATE;
  SELECT * INTO a FROM public.lead_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF a.status NOT IN ('pending', 'accepted') OR a.sla_action <> 'redistribute' OR a.sla_due_at IS NULL OR a.sla_due_at > now()
     OR NOT public._awaiting_first_response(a) THEN RETURN NULL; END IF;

  SELECT settings INTO s FROM public.organizations WHERE id = a.organization_id;
  IF s->>'lead_distribution_activated_at' IS NOT NULL AND (s->>'lead_distribution_activated_at')::timestamptz > a.assigned_at THEN
    UPDATE public.lead_assignments SET status = 'expired', redistribution_reason = 'stale_before_activation' WHERE id = a.id;
    RETURN NULL;
  END IF;

  SELECT * INTO cur FROM public.sales_reps WHERE id = a.rep_id;
  SELECT r.* INTO nxt FROM public.sales_reps r
   WHERE r.organization_id = a.organization_id AND r.availability = 'available'
     AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = r.organization_id AND m.user_id = r.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.lead_assignments x WHERE x.chain_id = a.chain_id AND x.rep_id = r.id)
   ORDER BY (r.rotation_order > cur.rotation_order) DESC, r.rotation_order LIMIT 1;

  UPDATE public.lead_assignments SET status = 'expired', sla_breached = true, redistribution_reason = 'sla_expired' WHERE id = a.id;

  IF nxt.id IS NULL THEN
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at,
                                         previous_assignment_id, exception_reason, origin_source, operation, product_model, strategy_version)
    VALUES (a.organization_id, a.chain_id, a.handoff_event_id, a.contact_id, a.conversation_id, a.opportunity_id, NULL, 'exception', 'exception', a.handoff_at,
            a.id, 'all_reps_sla_breached', a.origin_source, a.operation, a.product_model, a.strategy_version)
    RETURNING id INTO new_id;
  ELSE
    opp_id := public._lead_apply_effects(a.organization_id, a.conversation_id, a.contact_id, nxt.user_id);
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at, sla_due_at,
                                         previous_assignment_id, origin_source, operation, product_model, strategy_version)
    VALUES (a.organization_id, a.chain_id, a.handoff_event_id, a.contact_id, a.conversation_id, opp_id, nxt.id, 'sla_redistribution', 'pending', a.handoff_at, p_new_sla_due_at,
            a.id, a.origin_source, a.operation, a.product_model, a.strategy_version)
    RETURNING id INTO new_id;
    UPDATE public.lead_distribution_state SET last_rotation_order = nxt.rotation_order, updated_at = now() WHERE organization_id = a.organization_id;
    UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = nxt.id;
  END IF;
  UPDATE public.lead_assignments SET next_assignment_id = new_id WHERE id = a.id;
  RETURN new_id;
END $$;

-- Escalada de carteira: igual à 20261027120200; só o filtro de estado muda (pendente OU assumida aguardando a 1ª resposta).
CREATE OR REPLACE FUNCTION public.escalate_alert_assignment(p_assignment_id uuid, p_escalate_at timestamptz, p_new_sla_due_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; cur public.sales_reps; nxt public.sales_reps; new_id uuid; opp_id uuid; org uuid; s jsonb;
BEGIN
  SELECT organization_id INTO org FROM public.lead_assignments WHERE id = p_assignment_id;
  IF org IS NULL THEN RETURN NULL; END IF;
  SELECT settings INTO s FROM public.organizations WHERE id = org;
  IF s IS NULL OR s->'lead_distribution_enabled' IS DISTINCT FROM 'true'::jsonb OR s->'sla_alert_escalation_enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL; END IF;
  IF p_escalate_at IS NULL OR p_escalate_at > now() THEN RETURN NULL; END IF;

  INSERT INTO public.lead_distribution_state (organization_id) VALUES (org) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.lead_distribution_state WHERE organization_id = org FOR UPDATE;
  SELECT * INTO a FROM public.lead_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF a.status NOT IN ('pending', 'accepted') OR a.sla_action <> 'alert' OR a.reason NOT IN ('existing_owner', 'manual') OR a.rep_id IS NULL
     OR a.sla_due_at IS NULL OR a.sla_due_at > now() OR NOT public._awaiting_first_response(a) THEN RETURN NULL; END IF;
  IF s->>'lead_distribution_activated_at' IS NOT NULL AND (s->>'lead_distribution_activated_at')::timestamptz > a.assigned_at THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.lead_assignments x WHERE x.chain_id = a.chain_id AND x.redistribution_reason = 'sla_escalation') THEN RETURN NULL; END IF;
  IF p_escalate_at < GREATEST(COALESCE((s->>'sla_alert_escalation_activated_at')::timestamptz, '-infinity'::timestamptz), now() - interval '24 hours') THEN RETURN NULL; END IF;
  IF public._alert_assignment_answered(a) THEN RETURN NULL; END IF;

  SELECT * INTO cur FROM public.sales_reps WHERE id = a.rep_id;
  SELECT r.* INTO nxt FROM public.sales_reps r
   WHERE r.organization_id = a.organization_id AND r.availability = 'available' AND r.id <> a.rep_id
     AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = r.organization_id AND m.user_id = r.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.lead_assignments x WHERE x.chain_id = a.chain_id AND x.rep_id = r.id)
   ORDER BY (r.rotation_order > cur.rotation_order) DESC, r.rotation_order LIMIT 1;

  IF nxt.id IS NULL THEN
    UPDATE public.lead_assignments SET redistribution_reason = 'sla_escalation_no_rep', sla_breached = true
     WHERE id = a.id AND redistribution_reason IS DISTINCT FROM 'sla_escalation_no_rep';
    RETURN NULL;
  END IF;

  UPDATE public.lead_assignments SET status = 'redistributed', sla_breached = true, redistribution_reason = 'sla_escalation' WHERE id = a.id;
  opp_id := public._lead_apply_effects(a.organization_id, a.conversation_id, a.contact_id, nxt.user_id, a.operation);
  INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at, sla_due_at, sla_action,
                                       previous_assignment_id, origin_source, operation, product_model, strategy_version)
  VALUES (a.organization_id, a.chain_id, a.handoff_event_id, a.contact_id, a.conversation_id, opp_id, nxt.id, 'sla_redistribution', 'pending', a.handoff_at, p_new_sla_due_at, 'alert',
          a.id, a.origin_source, a.operation, a.product_model, a.strategy_version)
  RETURNING id INTO new_id;
  UPDATE public.lead_assignments SET next_assignment_id = new_id WHERE id = a.id;
  UPDATE public.lead_distribution_state SET last_rotation_order = nxt.rotation_order, updated_at = now() WHERE organization_id = a.organization_id;
  UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = nxt.id;
  RETURN new_id;
END $$;

-- Candidatas à escalada: igual à 20261027120200; só a condição de estado/aceite muda.
CREATE OR REPLACE FUNCTION public.list_escalation_candidates(p_per_org integer DEFAULT 50)
RETURNS TABLE(id uuid, organization_id uuid, assigned_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.id, x.organization_id, x.assigned_at FROM (
    SELECT a.id, a.organization_id, a.assigned_at, a.sla_due_at, row_number() OVER (PARTITION BY a.organization_id ORDER BY a.sla_due_at DESC, a.id) AS rn
      FROM public.lead_assignments a
      JOIN public.organizations o ON o.id = a.organization_id
     WHERE o.settings->'lead_distribution_enabled' = 'true'::jsonb AND o.settings->'sla_alert_escalation_enabled' = 'true'::jsonb
       AND a.sla_action = 'alert' AND a.reason IN ('existing_owner', 'manual') AND a.rep_id IS NOT NULL
       AND ((a.status = 'pending' AND a.first_human_message_at IS NULL AND a.accepted_at IS NULL) OR (a.status = 'accepted' AND a.awaiting_first_response))
       AND a.sla_due_at <= now()
       AND a.sla_due_at >= GREATEST(COALESCE((o.settings->>'sla_alert_escalation_activated_at')::timestamptz, '-infinity'::timestamptz) - interval '5 days', now() - interval '5 days')
       AND (o.settings->>'lead_distribution_activated_at' IS NULL OR (o.settings->>'lead_distribution_activated_at')::timestamptz <= a.assigned_at)
       AND NOT EXISTS (SELECT 1 FROM public.lead_assignments c WHERE c.chain_id = a.chain_id AND c.redistribution_reason = 'sla_escalation')
       AND (a.redistribution_reason IS DISTINCT FROM 'sla_escalation_no_rep' OR EXISTS (
             SELECT 1 FROM public.sales_reps r WHERE r.organization_id = a.organization_id AND r.availability = 'available' AND r.id <> a.rep_id
               AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = r.organization_id AND m.user_id = r.user_id)
               AND NOT EXISTS (SELECT 1 FROM public.lead_assignments y WHERE y.chain_id = a.chain_id AND y.rep_id = r.id)))
       AND NOT public._alert_assignment_answered(a)
  ) x WHERE x.rn <= GREATEST(1, p_per_org) ORDER BY x.sla_due_at DESC, x.id
$$;

REVOKE ALL ON FUNCTION public._human_msg_confirmed(uuid, uuid, timestamptz), public._human_msg_in_flight(uuid, uuid, timestamptz), public._human_msg_unsent(uuid, uuid, timestamptz),
  public._alert_assignment_answered(public.lead_assignments), public._awaiting_first_response(public.lead_assignments),
  public.accept_assignment(uuid, uuid, boolean), public.record_human_message(uuid, uuid, timestamptz, uuid, text), public.flag_sla_alerts(),
  public.redistribute_assignment(uuid, timestamptz), public.escalate_alert_assignment(uuid, timestamptz, timestamptz), public.list_escalation_candidates(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._human_msg_confirmed(uuid, uuid, timestamptz), public._human_msg_in_flight(uuid, uuid, timestamptz), public._human_msg_unsent(uuid, uuid, timestamptz),
  public._alert_assignment_answered(public.lead_assignments), public._awaiting_first_response(public.lead_assignments),
  public.accept_assignment(uuid, uuid, boolean), public.record_human_message(uuid, uuid, timestamptz, uuid, text), public.flag_sla_alerts(),
  public.redistribute_assignment(uuid, timestamptz), public.escalate_alert_assignment(uuid, timestamptz, timestamptz), public.list_escalation_candidates(integer)
  TO service_role;
