-- supabase/migrations/20261007120400_lead_distribution_fixes.sql
-- Correções da revisão final da distribuição de leads. Só CREATE OR REPLACE / CREATE de funções; nenhum dado é tocado.
--  * distribute_lead v2: idempotência por qualquer linha do handoff; novo handoff sobre lead aceito abre nova atribuição;
--    exceções antigas da conversa são resolvidas; operation/product_model vêm do único negócio aberto quando faltam no contexto.
--  * redistribute_assignment v2: linha pendente anterior à (re)ativação sai da fila sem ser redistribuída.
--  * record_distribution_error: registra a exceção distribution_error quando a distribuição falha.

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

  -- Nova distribuição: exceções antigas desta conversa deixam a fila do gestor.
  UPDATE public.lead_assignments SET resolved_at = now(), resolution = 'superseded_by_new_handoff'
   WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id AND status = 'exception' AND resolved_at IS NULL;

  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id AND organization_id = p_organization_id;
  -- Contexto (colunas imutáveis): o que vier explícito vence; senão, o único negócio aberto do contato. origin_source fica como veio.
  SELECT count(*) AS n, min(o.operation) AS operation, min(o.product_model) AS product_model INTO opp
    FROM public.opportunities o WHERE o.organization_id = p_organization_id AND o.contact_id = c.contact_id AND o.status = 'open';
  v_operation := COALESCE(ctx->>'operation', CASE WHEN opp.n = 1 THEN opp.operation END);
  v_product_model := COALESCE(ctx->>'product_model', CASE WHEN opp.n = 1 THEN opp.product_model END);

  lookback := COALESCE(NULLIF(s->>'owner_lookback_days', '')::integer, 30);
  -- Decide com a atribuição aceita ainda visível (último responsável válido); só depois ela é encerrada.
  SELECT * INTO d FROM public._lead_decide(p_organization_id, c.id, c.contact_id, st.last_rotation_order, lookback);
  IF act.id IS NOT NULL THEN
    UPDATE public.lead_assignments SET status = 'redistributed', redistribution_reason = 'new_handoff' WHERE id = act.id;
  END IF;

  IF d.exception_reason IS NOT NULL THEN
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, rep_id, reason, status, handoff_at, exception_reason,
                                         previous_assignment_id, origin_source, operation, product_model, strategy_version)
    VALUES (p_organization_id, chain, p_handoff_event_id, c.contact_id, c.id, NULL, 'exception', 'exception', h.handed_at, d.exception_reason,
            act.id, ctx->>'origin_source', v_operation, v_product_model, 'round_robin_v1')
    RETURNING id INTO new_id;
  ELSE
    SELECT * INTO rep FROM public.sales_reps WHERE id = d.rep_id;
    IF d.reason = 'round_robin' THEN
      UPDATE public.lead_distribution_state SET last_rotation_order = rep.rotation_order, updated_at = now() WHERE organization_id = p_organization_id;
      UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = rep.id;
    END IF;
    opp_id := public._lead_apply_effects(p_organization_id, c.id, c.contact_id, rep.user_id);
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
  -- Mesma ordem de travas de distribute_lead: estado da organização primeiro, depois a linha.
  PERFORM 1 FROM public.lead_distribution_state WHERE organization_id = org FOR UPDATE;
  SELECT * INTO a FROM public.lead_assignments WHERE id = p_assignment_id FOR UPDATE;
  -- Só lead novo do rodízio é redistribuído; dono existente e atribuição manual ('alert') nunca mudam de vendedor sozinhos.
  IF a.status <> 'pending' OR a.sla_action <> 'redistribute' OR a.sla_due_at IS NULL OR a.sla_due_at > now() THEN RETURN NULL; END IF;

  -- Linha criada antes da (re)ativação da flag: ficou parada enquanto a distribuição estava desligada.
  -- Sai da fila sem mover o lead (nada de redistribuição em massa ao religar).
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
    -- O ponteiro acompanha quem recebeu: o próximo lead novo vai ao outro vendedor.
    UPDATE public.lead_distribution_state SET last_rotation_order = nxt.rotation_order, updated_at = now() WHERE organization_id = a.organization_id;
    UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = nxt.id;
  END IF;
  UPDATE public.lead_assignments SET next_assignment_id = new_id WHERE id = a.id;
  RETURN new_id;
END $$;

-- Falha inesperada na distribuição: a transação de distribute_lead foi revertida; registra a exceção para o gestor.
-- Idempotente por handoff. Não grava nada se a conversa ainda tem atribuição ativa (o lead continua com alguém e
-- manual_assign não conseguiria abrir outra linha ativa ao lado dela); nesse caso o erro só vai para o log.
CREATE OR REPLACE FUNCTION public.record_distribution_error(p_organization_id uuid, p_conversation_id uuid, p_handoff_event_id uuid, p_message text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s jsonb; h public.handoff_events; c public.conversations; existing uuid; new_id uuid; opp record;
BEGIN
  SELECT settings INTO s FROM public.organizations WHERE id = p_organization_id;
  IF s IS NULL OR s->>'lead_distribution_enabled' IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
  SELECT * INTO h FROM public.handoff_events WHERE id = p_handoff_event_id AND organization_id = p_organization_id AND conversation_id = p_conversation_id;
  IF h.id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.lead_distribution_state (organization_id) VALUES (p_organization_id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.lead_distribution_state WHERE organization_id = p_organization_id FOR UPDATE;

  SELECT id INTO existing FROM public.lead_assignments WHERE handoff_event_id = p_handoff_event_id ORDER BY assigned_at, created_at, id LIMIT 1;
  IF existing IS NOT NULL THEN RETURN existing; END IF;
  RAISE LOG 'lead distribution error (organization %, conversation %, handoff %): %', p_organization_id, p_conversation_id, p_handoff_event_id, left(COALESCE(p_message, ''), 1000);
  IF EXISTS (SELECT 1 FROM public.lead_assignments WHERE conversation_id = p_conversation_id AND status IN ('pending','accepted')) THEN RETURN NULL; END IF;

  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id AND organization_id = p_organization_id;
  SELECT count(*) AS n, min(o.operation) AS operation, min(o.product_model) AS product_model INTO opp
    FROM public.opportunities o WHERE o.organization_id = p_organization_id AND o.contact_id = c.contact_id AND o.status = 'open';
  INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, rep_id, reason, status, handoff_at, exception_reason,
                                       operation, product_model, strategy_version)
  VALUES (p_organization_id, gen_random_uuid(), p_handoff_event_id, c.contact_id, c.id, NULL, 'exception', 'exception', h.handed_at, 'distribution_error',
          CASE WHEN opp.n = 1 THEN opp.operation END, CASE WHEN opp.n = 1 THEN opp.product_model END, 'round_robin_v1')
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION public.distribute_lead(uuid, uuid, uuid, timestamptz, jsonb), public.redistribute_assignment(uuid, timestamptz),
  public.record_distribution_error(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.distribute_lead(uuid, uuid, uuid, timestamptz, jsonb), public.redistribute_assignment(uuid, timestamptz),
  public.record_distribution_error(uuid, uuid, uuid, text) TO service_role;
