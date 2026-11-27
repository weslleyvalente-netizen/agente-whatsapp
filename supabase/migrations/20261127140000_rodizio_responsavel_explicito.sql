-- Fase C do plano de estabilização (26/11): rodízio com responsável explícito, exceção que fecha com a resposta do vendedor e
-- encaminhamento repetido que não reinicia o rodízio durante atendimento ativo.
--   * lead_assignments.responsible_rep_id: na exceção, o vendedor que fica com a conversa/card (último da cadeia ou o atual da conversa).
--     Só dado: gravado sempre (não muda quem atende; hoje a conversa e o card já ficam com esse vendedor).
--   * lead_assignments.last_customer_followup_at: horário em que o cliente voltou a escrever num atendimento ativo (encaminhamento absorvido).
--   * settings.exception_auto_resolve_enabled (padrão desligado): record_human_message fecha a exceção como 'answered_by_seller'.
--   * settings.repeat_handoff_keeps_assignment_enabled (padrão desligado): distribute_lead não reinicia o rodízio quando a atribuição está
--     aceita e o vendedor escreveu nas últimas 24 h.
-- Corpos copiados das versões vigentes (distribute_lead 20261027120000; redistribute_assignment e record_human_message 20261119130000),
-- com as alterações marcadas por comentário.
--
-- Reverter: reaplicar distribute_lead de 20261027120000 e redistribute_assignment/record_human_message de 20261119130000;
--   ALTER TABLE public.lead_assignments DROP COLUMN IF EXISTS responsible_rep_id, DROP COLUMN IF EXISTS last_customer_followup_at;

ALTER TABLE public.lead_assignments
  ADD COLUMN IF NOT EXISTS responsible_rep_id uuid REFERENCES public.sales_reps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_customer_followup_at timestamptz;

CREATE OR REPLACE FUNCTION public.distribute_lead(p_organization_id uuid, p_conversation_id uuid, p_handoff_event_id uuid, p_sla_due_at timestamptz, p_context jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s jsonb; h public.handoff_events; c public.conversations; st public.lead_distribution_state; act public.lead_assignments;
  existing uuid; chain uuid := gen_random_uuid(); d record; rep public.sales_reps; opp record;
  lookback integer; new_id uuid; opp_id uuid; ctx jsonb := COALESCE(p_context, '{}'::jsonb); v_operation text; v_product_model text;
BEGIN
  SELECT settings INTO s FROM public.organizations WHERE id = p_organization_id;
  IF s IS NULL OR s->>'lead_distribution_enabled' IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
  SELECT * INTO h FROM public.handoff_events WHERE id = p_handoff_event_id AND organization_id = p_organization_id AND conversation_id = p_conversation_id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'Handoff inexistente para esta conversa'; END IF;
  IF s->>'lead_distribution_activated_at' IS NOT NULL AND h.handed_at < (s->>'lead_distribution_activated_at')::timestamptz THEN RETURN NULL; END IF;

  -- Trava por organização: serializa as atribuições e protege o ponteiro do rodízio.
  INSERT INTO public.lead_distribution_state (organization_id) VALUES (p_organization_id) ON CONFLICT DO NOTHING;
  SELECT * INTO st FROM public.lead_distribution_state WHERE organization_id = p_organization_id FOR UPDATE;

  -- Idempotência primeiro: qualquer linha deste handoff (raiz de cadeia, continuação de um lead aceito ou distribution_error).
  SELECT id INTO existing FROM public.lead_assignments WHERE handoff_event_id = p_handoff_event_id ORDER BY assigned_at, created_at, id LIMIT 1;
  IF existing IS NOT NULL THEN RETURN existing; END IF;

  SELECT * INTO act FROM public.lead_assignments WHERE conversation_id = p_conversation_id AND status IN ('pending','accepted') FOR UPDATE;
  -- Pendente de outro handoff: o prazo em curso continua valendo; nada muda.
  IF act.status = 'pending' THEN RETURN act.id; END IF;
  -- Encaminhamento repetido com atendimento humano ATIVO (atribuição aceita e mensagem do vendedor nas últimas 24 h): não reinicia o
  -- rodízio nem o prazo; só registra que o cliente voltou a escrever. Atrás de repeat_handoff_keeps_assignment_enabled (padrão: desligado).
  IF act.status = 'accepted' AND s->'repeat_handoff_keeps_assignment_enabled' = 'true'::jsonb
     AND EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = p_conversation_id AND m.role = 'human_agent'
                  AND m.created_at >= act.assigned_at AND m.created_at > now() - interval '24 hours') THEN
    UPDATE public.lead_assignments SET last_customer_followup_at = GREATEST(COALESCE(last_customer_followup_at, h.handed_at), h.handed_at) WHERE id = act.id;
    RETURN act.id;
  END IF;

  -- Nova distribuição: exceções antigas desta conversa deixam a fila do gestor.
  UPDATE public.lead_assignments SET resolved_at = now(), resolution = 'superseded_by_new_handoff'
   WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id AND status = 'exception' AND resolved_at IS NULL;

  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id AND organization_id = p_organization_id;
  -- Contexto (colunas imutáveis): o que vier explícito vence; senão, o único negócio aberto do contato. origin_source fica como veio.
  SELECT count(*) AS n, min(o.operation) AS operation, min(o.product_model) AS product_model, bool_or(o.operation_is_default) AS is_default INTO opp
    FROM public.opportunities o WHERE o.organization_id = p_organization_id AND o.contact_id = c.contact_id AND o.status = 'open';
  -- card com operação só no padrão não é dado real: não grava a operação dele (coluna imutável) na atribuição
  v_operation := COALESCE(ctx->>'operation', CASE WHEN opp.n = 1 AND NOT COALESCE(opp.is_default, false) THEN opp.operation END);
  v_product_model := COALESCE(ctx->>'product_model', CASE WHEN opp.n = 1 THEN opp.product_model END);

  lookback := COALESCE(NULLIF(s->>'owner_lookback_days', '')::integer, 30);
  -- Decide com a atribuição aceita ainda visível (último responsável válido); só depois ela é encerrada.
  SELECT * INTO d FROM public._lead_decide(p_organization_id, c.id, c.contact_id, st.last_rotation_order, lookback);
  IF act.id IS NOT NULL THEN
    UPDATE public.lead_assignments SET status = 'redistributed', redistribution_reason = 'new_handoff' WHERE id = act.id;
  END IF;

  IF d.exception_reason IS NOT NULL THEN
    -- Responsável explícito: o vendedor que já está com a conversa (se for vendedor cadastrado); a fila do gestor mostra quem é.
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, rep_id, reason, status, handoff_at, exception_reason,
                                         previous_assignment_id, origin_source, operation, product_model, strategy_version, responsible_rep_id)
    VALUES (p_organization_id, chain, p_handoff_event_id, c.contact_id, c.id, NULL, 'exception', 'exception', h.handed_at, d.exception_reason,
            act.id, ctx->>'origin_source', v_operation, v_product_model, 'round_robin_v1',
            (SELECT r.id FROM public.sales_reps r WHERE r.organization_id = p_organization_id AND r.user_id = c.assigned_to))
    RETURNING id INTO new_id;
  ELSE
    SELECT * INTO rep FROM public.sales_reps WHERE id = d.rep_id;
    IF d.reason = 'round_robin' THEN
      UPDATE public.lead_distribution_state SET last_rotation_order = rep.rotation_order, updated_at = now() WHERE organization_id = p_organization_id;
      UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = rep.id;
    END IF;
    opp_id := public._lead_apply_effects(p_organization_id, c.id, c.contact_id, rep.user_id, v_operation);
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at, sla_due_at, sla_action,
                                         previous_assignment_id, origin_source, operation, product_model, strategy_version)
    VALUES (p_organization_id, chain, p_handoff_event_id, c.contact_id, c.id, opp_id, rep.id, d.reason, 'pending', h.handed_at, p_sla_due_at,
            CASE WHEN d.reason = 'existing_owner' THEN 'alert' ELSE 'redistribute' END,
            act.id, ctx->>'origin_source', v_operation, v_product_model, 'round_robin_v1')
    RETURNING id INTO new_id;
  END IF;
  IF act.id IS NOT NULL THEN
    UPDATE public.lead_assignments SET next_assignment_id = new_id WHERE id = act.id;
  END IF;
  RETURN new_id;
END $$;

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
    -- Rodízio esgotado: a conversa e o card continuam com o último vendedor (a), agora registrado como responsável explícito da exceção.
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at,
                                         previous_assignment_id, exception_reason, origin_source, operation, product_model, strategy_version, responsible_rep_id)
    VALUES (a.organization_id, a.chain_id, a.handoff_event_id, a.contact_id, a.conversation_id, a.opportunity_id, NULL, 'exception', 'exception', a.handoff_at,
            a.id, 'all_reps_sla_breached', a.origin_source, a.operation, a.product_model, a.strategy_version, a.rep_id)
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

CREATE OR REPLACE FUNCTION public.record_human_message(p_organization_id uuid, p_conversation_id uuid, p_at timestamptz, p_author uuid, p_via text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; rep public.sales_reps; conv_user uuid; may_accept boolean := false;
BEGIN
  IF p_via IS NULL OR p_via NOT IN ('panel','phone_echo') THEN RAISE EXCEPTION 'Origem inválida'; END IF;
  -- Resposta do vendedor fecha a exceção aberta da conversa (criada antes desta resposta). Atrás de exception_auto_resolve_enabled.
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id AND o.settings->'exception_auto_resolve_enabled' = 'true'::jsonb) THEN
    UPDATE public.lead_assignments SET resolved_at = p_at, resolved_by = p_author, resolution = 'answered_by_seller'
     WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id AND status = 'exception' AND resolved_at IS NULL AND assigned_at <= p_at;
  END IF;
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
