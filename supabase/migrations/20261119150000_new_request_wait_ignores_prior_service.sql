-- Atendimento ANTERIOR protege a continuidade (a escalada não troca o responsável), mas NÃO encerra a espera pela resposta ao NOVO pedido.
--
-- DEPENDE de 20261119140000_message_author_in_sla_rules.sql.
--
-- Caso David (19/11): a Marina atendeu de manhã (cotações às 14:46), o cliente voltou reclamando, a IA encaminhou de novo (17:12), ela clicou em
-- Assumir e não respondeu. O prazo (sla_due_at 17:48) venceu e o quadro "Atraso no atendimento" não mostrou o cliente: flag_sla_alerts (que liga
-- sla_breached, lido pelo quadro) usa _awaiting_first_response, e para atribuição ASSUMIDA ele chamava _alert_assignment_answered, cuja janela
-- inclui as mensagens do período anterior da mesma vendedora (regra de continuidade da #110). A mesma atribuição, ainda PENDENTE, era cobrada
-- (status='pending' não consulta essa função); depois do clique, não. O push "SLA estourado" (listSlaBreachCandidates, conta mensagens desde assigned_at)
-- já avisava; só o quadro ficava de fora.
--
-- Decisão: duas perguntas diferentes.
--   1. "Este cliente já foi atendido por este vendedor?" (continuidade: escalada/troca de responsável)  => _alert_assignment_answered(a), INALTERADA.
--   2. "Este NOVO pedido já recebeu resposta?" (cobrança/quadro/espera)                                  => _alert_answered(a, true): só conta o que
--      aconteceu DESDE ESTA atribuição (mensagem confirmada e sem falha, ligação, tarefa, nota, atividade comercial, negócio ganho/perdido...).
--      Atendimento anterior não vale, nem a "devolução manual" por atendimento comprovado.
-- O prazo continua sendo o sla_due_at original (imutável): o clique em Assumir não o reinicia.
--
-- Só muda quem decide a ESPERA: _awaiting_first_response (usada por flag_sla_alerts, redistribute_assignment e escalate_alert_assignment).
-- A escalada exige as duas respostas: a espera ainda aberta (pergunta 2) E o vendedor sem atendimento no período (pergunta 1). Por isso o
-- cliente atendido continua com o mesmo responsável, mas o atraso do novo pedido é cobrado e aparece no quadro.
-- Efeito ao aplicar: linhas 'accepted' + awaiting_first_response de carteira cujo prazo já passou e que só tinham atendimento anterior passam a
-- ser marcadas sla_breached na próxima rodada do flag_sla_alerts (no momento da escrita: 1 linha, a do David). Nenhum responsável muda.
-- Reverter: recriar _awaiting_first_response com _alert_assignment_answered(a) (20261119140000); as funções novas podem ficar.
-- NÃO aplicada automaticamente.
SET LOCAL lock_timeout = '5s';

-- Núcleo: igual a _alert_assignment_answered (20261119140000); p_new_request => só conta o que aconteceu desde esta atribuição.
CREATE OR REPLACE FUNCTION public._alert_answered(a public.lead_assignments, p_new_request boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE since timestamptz; conv_status text; first_handoff timestamptz; prev_other timestamptz; run_start timestamptz; opp_since timestamptz := a.assigned_at; rep_user uuid; other_last timestamptz;
BEGIN
  SELECT r.user_id INTO rep_user FROM public.sales_reps r WHERE r.id = a.rep_id;
  IF a.reason = 'manual' OR p_new_request THEN
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
  -- Marco de primeira mensagem: o autor registrado (first_human_message_by) precisa ser o vendedor; autor nulo (celular da loja / registro antigo) é desconhecido e vale.
  IF ((a.first_human_message_at IS NOT NULL AND (a.first_human_message_by IS NULL OR a.first_human_message_by IS NOT DISTINCT FROM rep_user)) OR a.accepted_via IN ('first_message', 'phone_echo'))
     AND NOT (public._human_msg_unsent(a.organization_id, a.conversation_id, a.assigned_at, rep_user)
              AND NOT public._human_msg_confirmed(a.organization_id, a.conversation_id, a.assigned_at, rep_user)
              AND NOT public._human_msg_in_flight(a.organization_id, a.conversation_id, a.assigned_at, rep_user)) THEN RETURN true; END IF;
  IF public._human_msg_confirmed(a.organization_id, a.conversation_id, since, rep_user) OR public._human_msg_in_flight(a.organization_id, a.conversation_id, since, rep_user) THEN RETURN true; END IF;
  -- Devolução manual a vendedor com atendimento anterior comprovado (autoria registrada, mensagem confirmada e sem falha no período dele).
  IF NOT p_new_request AND a.reason = 'manual' AND a.rep_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.lead_assignments y JOIN public.sales_reps r ON r.id = y.rep_id
        WHERE y.conversation_id = a.conversation_id AND y.rep_id = a.rep_id AND y.assigned_at < a.assigned_at
          AND y.first_human_message_at IS NOT NULL AND (y.first_human_message_by = r.user_id OR y.accepted_via = 'phone_echo')
          AND EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = a.conversation_id AND m.organization_id = a.organization_id
                        AND m.role = 'human_agent' AND m.evolution_message_id IS NOT NULL AND (m.metadata->>'send_failed_at') IS NULL
                        AND (public._msg_author(m.metadata) IS NULL OR public._msg_author(m.metadata) = r.user_id)
                        AND m.created_at >= y.assigned_at
                        AND m.created_at < COALESCE((SELECT min(z.assigned_at) FROM public.lead_assignments z
                                                      WHERE z.conversation_id = a.conversation_id AND z.rep_id IS NOT NULL AND z.rep_id <> a.rep_id AND z.assigned_at > y.assigned_at), a.assigned_at))
     ) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.sales_call_logs l WHERE l.organization_id = a.organization_id AND l.called_at >= a.assigned_at
               AND (l.contact_id = a.contact_id OR l.opportunity_id IN (SELECT o.id FROM public.opportunities o WHERE o.organization_id = a.organization_id AND o.contact_id = a.contact_id))) THEN RETURN true; END IF;
  -- record_human_message grava last_commercial_activity_at quando o envio é PEDIDO (antes de saber se saiu). Se só houve envio NÃO ENVIADO
  -- (falhou ou ficou preso), a atividade comercial feita dentro da JANELA DE ENVIO (10 min após a criação da última dessas mensagens)
  -- não conta como atendimento. Ligação, tarefa, nota e atividade depois da janela continuam valendo.
  IF public._human_msg_unsent(a.organization_id, a.conversation_id, a.assigned_at, rep_user)
     AND NOT public._human_msg_confirmed(a.organization_id, a.conversation_id, a.assigned_at, rep_user)
     AND NOT public._human_msg_in_flight(a.organization_id, a.conversation_id, a.assigned_at, rep_user) THEN
    opp_since := GREATEST(a.assigned_at, (SELECT max(m.created_at) FROM public.messages m WHERE m.conversation_id = a.conversation_id AND m.organization_id = a.organization_id
                                              AND m.role = 'human_agent' AND m.evolution_message_id IS NULL AND m.created_at >= a.assigned_at
                                              AND (rep_user IS NULL OR public._msg_author(m.metadata) IS NULL OR public._msg_author(m.metadata) = rep_user)
                                              AND ((m.metadata->>'send_failed_at') IS NOT NULL OR m.created_at < now() - interval '10 minutes')) + interval '10 minutes');
  END IF;
  -- A atividade comercial também é gravada quando OUTRA pessoa (autor conhecido, ex.: o gestor) pede o envio de uma mensagem: não é atendimento
  -- do vendedor. Se só há mensagens de outros autores (nenhuma do vendedor/desconhecida, em nenhum estado), ignora a atividade feita dentro da
  -- janela de envio (10 min) da última mensagem alheia ou do marco de primeira mensagem alheio.
  other_last := GREATEST(
    (SELECT max(m.created_at) FROM public.messages m WHERE m.conversation_id = a.conversation_id AND m.organization_id = a.organization_id AND m.role = 'human_agent'
        AND m.created_at >= a.assigned_at AND public._msg_author(m.metadata) IS NOT NULL AND public._msg_author(m.metadata) IS DISTINCT FROM rep_user),
    CASE WHEN a.first_human_message_by IS NOT NULL AND a.first_human_message_by IS DISTINCT FROM rep_user THEN a.first_human_message_at END);
  IF other_last IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.messages m WHERE m.conversation_id = a.conversation_id AND m.organization_id = a.organization_id AND m.role = 'human_agent'
          AND m.created_at >= a.assigned_at AND (public._msg_author(m.metadata) IS NULL OR public._msg_author(m.metadata) = rep_user)) THEN
    opp_since := GREATEST(opp_since, other_last + interval '10 minutes');
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

-- Continuidade (inalterada para quem a chama): atendimento anterior do período do vendedor protege a troca.
CREATE OR REPLACE FUNCTION public._alert_assignment_answered(a public.lead_assignments)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public._alert_answered(a, false)
$$;

-- A atribuição ainda espera a primeira resposta AO PEDIDO ATUAL? (autoridade única para as funções de SLA)
CREATE OR REPLACE FUNCTION public._awaiting_first_response(a public.lead_assignments)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.status = 'pending'
      OR (a.status = 'accepted' AND a.awaiting_first_response AND a.rep_id IS NOT NULL
          AND CASE WHEN a.sla_action = 'alert' THEN NOT public._alert_answered(a, true)
                   ELSE NOT public._human_msg_confirmed(a.organization_id, a.conversation_id, a.assigned_at, (SELECT r.user_id FROM public.sales_reps r WHERE r.id = a.rep_id))
                    AND NOT public._human_msg_in_flight(a.organization_id, a.conversation_id, a.assigned_at, (SELECT r.user_id FROM public.sales_reps r WHERE r.id = a.rep_id)) END)
$$;

REVOKE ALL ON FUNCTION public._alert_answered(public.lead_assignments, boolean), public._alert_assignment_answered(public.lead_assignments), public._awaiting_first_response(public.lead_assignments)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._alert_answered(public.lead_assignments, boolean), public._alert_assignment_answered(public.lead_assignments), public._awaiting_first_response(public.lead_assignments)
  TO service_role;
