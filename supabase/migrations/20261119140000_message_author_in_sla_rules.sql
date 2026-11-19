-- Autor da mensagem do painel nas regras de SLA (#110/#111): mensagem de OUTRA pessoa não protege nem encerra a espera do vendedor.
--
-- DEPENDE de 20261119120000 e 20261119130000. Só redefine funções (nada de dados é alterado).
--
-- O QUE MUDA NA GRAVAÇÃO (código da API): toda mensagem enviada PELO PAINEL passa a levar messages.metadata.sent_by_user_id = usuário que enviou
--   (texto, áudio, anexo e follow-up de tarefa). Mensagem do CELULAR DA LOJA (eco do WhatsApp) NÃO leva a chave: autoria DESCONHECIDA.
--   Registros antigos também não têm a chave: autoria desconhecida (preservados, tratados como antes).
--
-- COMO AS REGRAS USAM (_msg_author(metadata) = uuid ou NULL): para o vendedor V de uma atribuição, uma mensagem humana só conta (confirmada, em voo
--   ou não enviada) se o autor for V OU desconhecido (NULL). Mensagem com autor conhecido DIFERENTE de V (ex.: o gestor pelo painel) é ignorada:
--     * #110 (escalada): não protege V; o cliente que ninguém atendeu de verdade continua escalável;
--     * #111 (Assumir): não encerra a espera da primeira resposta de V; a cobrança continua;
--   O marco first_human_message_at só vale se first_human_message_by for nulo (celular/antigo) ou o próprio V.
--   Prova de atendimento anterior na devolução manual também exige autor V ou desconhecido.
-- LIMITE QUE FICA: autoria desconhecida (celular da loja e registros antigos) continua contando a favor do vendedor atual: não há como provar o contrário.
--
-- Funções _human_msg_confirmed/_in_flight/_unsent ganham o parâmetro p_rep_user (NULL = sem filtro); as versões de 3 argumentos são removidas.
-- Reverter: recriar as versões de 3 argumentos e as duas funções principais de 20261119130000; _msg_author pode ficar.
-- NÃO aplicada automaticamente.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public._msg_author(md jsonb) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN md->>'sent_by_user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (md->>'sent_by_user_id')::uuid END
$$;

-- Mensagens humanas por situação de envio, desde um instante.
CREATE OR REPLACE FUNCTION public._human_msg_confirmed(p_org uuid, p_conv uuid, p_since timestamptz, p_rep_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = p_conv AND m.organization_id = p_org AND m.role = 'human_agent'
                   AND m.evolution_message_id IS NOT NULL AND (m.metadata->>'send_failed_at') IS NULL AND m.created_at >= p_since AND (p_rep_user IS NULL OR public._msg_author(m.metadata) IS NULL OR public._msg_author(m.metadata) = p_rep_user))
$$;
CREATE OR REPLACE FUNCTION public._human_msg_in_flight(p_org uuid, p_conv uuid, p_since timestamptz, p_rep_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = p_conv AND m.organization_id = p_org AND m.role = 'human_agent'
                   AND m.evolution_message_id IS NULL AND (m.metadata->>'send_failed_at') IS NULL
                   AND m.created_at >= GREATEST(p_since, now() - interval '10 minutes') AND (p_rep_user IS NULL OR public._msg_author(m.metadata) IS NULL OR public._msg_author(m.metadata) = p_rep_user))
$$;
-- NÃO ENVIADA: sem id do WhatsApp e (marcada como falha OU parada há mais de 10 min). Mensagem presa não pode adiar a decisão para sempre.
CREATE OR REPLACE FUNCTION public._human_msg_unsent(p_org uuid, p_conv uuid, p_since timestamptz, p_rep_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = p_conv AND m.organization_id = p_org AND m.role = 'human_agent'
                   AND m.evolution_message_id IS NULL AND m.created_at >= p_since AND (p_rep_user IS NULL OR public._msg_author(m.metadata) IS NULL OR public._msg_author(m.metadata) = p_rep_user)
                   AND ((m.metadata->>'send_failed_at') IS NOT NULL OR m.created_at < now() - interval '10 minutes'))
$$;

-- "Já atendido" (carteira): igual à 20261119120000, com duas correções: mensagem EM VOO também vale (suspende a troca) e o marco de primeira
-- mensagem não vale quando só há mensagens com falha desde a atribuição.
CREATE OR REPLACE FUNCTION public._alert_assignment_answered(a public.lead_assignments)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE since timestamptz; conv_status text; first_handoff timestamptz; prev_other timestamptz; run_start timestamptz; opp_since timestamptz := a.assigned_at; rep_user uuid; other_last timestamptz;
BEGIN
  SELECT r.user_id INTO rep_user FROM public.sales_reps r WHERE r.id = a.rep_id;
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
  -- Marco de primeira mensagem: o autor registrado (first_human_message_by) precisa ser o vendedor; autor nulo (celular da loja / registro antigo) é desconhecido e vale.
  IF ((a.first_human_message_at IS NOT NULL AND (a.first_human_message_by IS NULL OR a.first_human_message_by IS NOT DISTINCT FROM rep_user)) OR a.accepted_via IN ('first_message', 'phone_echo'))
     AND NOT (public._human_msg_unsent(a.organization_id, a.conversation_id, a.assigned_at, rep_user)
              AND NOT public._human_msg_confirmed(a.organization_id, a.conversation_id, a.assigned_at, rep_user)
              AND NOT public._human_msg_in_flight(a.organization_id, a.conversation_id, a.assigned_at, rep_user)) THEN RETURN true; END IF;
  IF public._human_msg_confirmed(a.organization_id, a.conversation_id, since, rep_user) OR public._human_msg_in_flight(a.organization_id, a.conversation_id, since, rep_user) THEN RETURN true; END IF;
  -- Devolução manual a vendedor com atendimento anterior comprovado (autoria registrada, mensagem confirmada e sem falha no período dele).
  IF a.reason = 'manual' AND a.rep_id IS NOT NULL AND EXISTS (
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

-- A atribuição ainda espera a primeira resposta? (autoridade única para as funções de SLA)
--   pendente: sim (como sempre);  assumida (awaiting_first_response): sim enquanto não houver resposta confirmada.
CREATE OR REPLACE FUNCTION public._awaiting_first_response(a public.lead_assignments)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.status = 'pending'
      OR (a.status = 'accepted' AND a.awaiting_first_response AND a.rep_id IS NOT NULL
          AND CASE WHEN a.sla_action = 'alert' THEN NOT public._alert_assignment_answered(a)
                   ELSE NOT public._human_msg_confirmed(a.organization_id, a.conversation_id, a.assigned_at, (SELECT r.user_id FROM public.sales_reps r WHERE r.id = a.rep_id))
                    AND NOT public._human_msg_in_flight(a.organization_id, a.conversation_id, a.assigned_at, (SELECT r.user_id FROM public.sales_reps r WHERE r.id = a.rep_id)) END)
$$;


-- Candidatas à escalada: igual à da 20261119130000; sem o pré-filtro first_human_message_at IS NULL (o marco pode ser de OUTRO autor, ex.: o gestor;
-- _alert_assignment_answered, com o autor, é a autoridade).
CREATE OR REPLACE FUNCTION public.list_escalation_candidates(p_per_org integer DEFAULT 50)
RETURNS TABLE(id uuid, organization_id uuid, assigned_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.id, x.organization_id, x.assigned_at FROM (
    SELECT a.id, a.organization_id, a.assigned_at, a.sla_due_at, row_number() OVER (PARTITION BY a.organization_id ORDER BY a.sla_due_at DESC, a.id) AS rn
      FROM public.lead_assignments a
      JOIN public.organizations o ON o.id = a.organization_id
     WHERE o.settings->'lead_distribution_enabled' = 'true'::jsonb AND o.settings->'sla_alert_escalation_enabled' = 'true'::jsonb
       AND a.sla_action = 'alert' AND a.reason IN ('existing_owner', 'manual') AND a.rep_id IS NOT NULL
       AND ((a.status = 'pending' AND a.accepted_at IS NULL) OR (a.status = 'accepted' AND a.awaiting_first_response))
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


DROP FUNCTION IF EXISTS public._human_msg_confirmed(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public._human_msg_in_flight(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public._human_msg_unsent(uuid, uuid, timestamptz);

REVOKE ALL ON FUNCTION public._msg_author(jsonb), public._human_msg_confirmed(uuid, uuid, timestamptz, uuid), public._human_msg_in_flight(uuid, uuid, timestamptz, uuid),
  public._human_msg_unsent(uuid, uuid, timestamptz, uuid), public._alert_assignment_answered(public.lead_assignments), public._awaiting_first_response(public.lead_assignments), public.list_escalation_candidates(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._msg_author(jsonb), public._human_msg_confirmed(uuid, uuid, timestamptz, uuid), public._human_msg_in_flight(uuid, uuid, timestamptz, uuid),
  public._human_msg_unsent(uuid, uuid, timestamptz, uuid), public._alert_assignment_answered(public.lead_assignments), public._awaiting_first_response(public.lead_assignments), public.list_escalation_candidates(integer)
  TO service_role;
