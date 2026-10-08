-- supabase/migrations/20261007120100_lead_distribution_assign.sql
CREATE FUNCTION public._lead_owner_check(p_org uuid, p_user uuid)
RETURNS TABLE(rep_id uuid, state text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.sales_reps;
BEGIN
  IF p_user IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'not_rep'::text; RETURN; END IF;
  SELECT * INTO r FROM public.sales_reps WHERE organization_id = p_org AND user_id = p_user;
  IF r.id IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'not_rep'::text; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = p_org AND m.user_id = p_user) THEN
    RETURN QUERY SELECT r.id, 'invalid'::text; RETURN;
  END IF;
  IF r.availability = 'out' THEN RETURN QUERY SELECT r.id, 'out'::text; RETURN; END IF;
  RETURN QUERY SELECT r.id, 'valid'::text;
END $$;

-- Precedência: negócio aberto atual > conversa atual > último responsável válido (dentro da janela).
CREATE FUNCTION public.resolve_current_owner(p_org uuid, p_contact uuid, p_conversation uuid, p_lookback_days integer)
RETURNS TABLE(rep_id uuid, outcome text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o record; chk record; valid_ids uuid[] := '{}'; invalid_id uuid; out_id uuid; conv_user uuid; last_user uuid;
BEGIN
  -- 1. Negócios abertos do contato
  FOR o IN SELECT DISTINCT owner_id FROM public.opportunities WHERE organization_id = p_org AND contact_id = p_contact AND status = 'open' AND owner_id IS NOT NULL LOOP
    SELECT * INTO chk FROM public._lead_owner_check(p_org, o.owner_id);
    IF chk.state = 'valid' THEN valid_ids := array_append(valid_ids, chk.rep_id);
    ELSIF chk.state = 'invalid' THEN invalid_id := chk.rep_id;
    ELSIF chk.state = 'out' THEN out_id := chk.rep_id; END IF;
  END LOOP;
  IF array_length(valid_ids, 1) > 1 THEN RETURN QUERY SELECT NULL::uuid, 'conflict'::text; RETURN; END IF;
  IF array_length(valid_ids, 1) = 1 THEN RETURN QUERY SELECT valid_ids[1], 'found'::text; RETURN; END IF;
  IF invalid_id IS NOT NULL THEN RETURN QUERY SELECT invalid_id, 'invalid'::text; RETURN; END IF;
  IF out_id IS NOT NULL THEN RETURN QUERY SELECT NULL::uuid, 'none'::text; RETURN; END IF;

  -- 2. Conversa atual
  SELECT assigned_to INTO conv_user FROM public.conversations WHERE id = p_conversation AND organization_id = p_org;
  SELECT * INTO chk FROM public._lead_owner_check(p_org, conv_user);
  IF chk.state = 'valid' THEN RETURN QUERY SELECT chk.rep_id, 'found'::text; RETURN; END IF;
  IF chk.state = 'invalid' THEN RETURN QUERY SELECT chk.rep_id, 'invalid'::text; RETURN; END IF;
  IF chk.state = 'out' THEN RETURN QUERY SELECT NULL::uuid, 'none'::text; RETURN; END IF;

  -- 3. Último responsável válido: atribuição aceita dentro da janela (aceite ou atividade comercial recente)
  SELECT r.user_id INTO last_user
    FROM public.lead_assignments a
    JOIN public.sales_reps r ON r.id = a.rep_id
    LEFT JOIN public.opportunities op ON op.id = a.opportunity_id
   WHERE a.organization_id = p_org AND a.contact_id = p_contact AND a.status = 'accepted'
     AND GREATEST(a.accepted_at, op.last_commercial_activity_at) >= now() - make_interval(days => p_lookback_days)
   ORDER BY GREATEST(a.accepted_at, op.last_commercial_activity_at) DESC NULLS LAST LIMIT 1;
  SELECT * INTO chk FROM public._lead_owner_check(p_org, last_user);
  IF chk.state = 'valid' THEN RETURN QUERY SELECT chk.rep_id, 'found'::text; RETURN; END IF;
  RETURN QUERY SELECT NULL::uuid, 'none'::text;
END $$;

-- Aplica a atribuição às tabelas operacionais. Devolve o negócio ligado (se houver exatamente um aberto).
CREATE FUNCTION public._lead_apply_effects(p_org uuid, p_conversation uuid, p_contact uuid, p_user uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE opp_count integer; opp_id uuid;
BEGIN
  UPDATE public.conversations SET assigned_to = p_user, assigned_at = now() WHERE id = p_conversation AND organization_id = p_org;
  SELECT count(*), min(id::text)::uuid INTO opp_count, opp_id FROM public.opportunities WHERE organization_id = p_org AND contact_id = p_contact AND status = 'open';
  IF opp_count = 1 THEN
    UPDATE public.opportunities
       SET owner_assigned_at = CASE WHEN owner_id IS DISTINCT FROM p_user THEN now() ELSE owner_assigned_at END,
           owner_id = p_user
     WHERE id = opp_id;
  ELSE opp_id := NULL; END IF;
  UPDATE public.tasks SET assignee_type = 'human', assignee_id = p_user
   WHERE organization_id = p_org AND contact_id = p_contact AND status IN ('pending','in_progress','rescheduled');
  RETURN opp_id;
END $$;

-- Decisão compartilhada entre a distribuição real e o modo sombra (uma só lógica, sem cópia).
-- Devolve: rep_id (ou NULL), reason ('existing_owner' | 'round_robin' | 'exception') e exception_reason.
CREATE FUNCTION public._lead_decide(p_org uuid, p_conversation uuid, p_contact uuid, p_last_order integer, p_lookback integer)
RETURNS TABLE(rep_id uuid, reason text, exception_reason text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o record; r public.sales_reps;
BEGIN
  SELECT * INTO o FROM public.resolve_current_owner(p_org, p_contact, p_conversation, p_lookback);
  IF o.outcome = 'found' THEN RETURN QUERY SELECT o.rep_id, 'existing_owner'::text, NULL::text; RETURN; END IF;
  IF o.outcome = 'conflict' THEN RETURN QUERY SELECT NULL::uuid, 'exception'::text, 'manual_review'::text; RETURN; END IF;
  IF o.outcome = 'invalid' THEN RETURN QUERY SELECT NULL::uuid, 'exception'::text, 'invalid_existing_owner'::text; RETURN; END IF;
  -- Rodízio: primeiro disponível depois do ponteiro; se não houver, volta ao início.
  SELECT x.* INTO r FROM public.sales_reps x
   WHERE x.organization_id = p_org AND x.availability = 'available'
     AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = x.organization_id AND m.user_id = x.user_id)
   ORDER BY (x.rotation_order > p_last_order) DESC, x.rotation_order LIMIT 1;
  IF r.id IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'exception'::text, 'no_available_rep'::text; RETURN; END IF;
  RETURN QUERY SELECT r.id, 'round_robin'::text, NULL::text;
END $$;

CREATE FUNCTION public.distribute_lead(p_organization_id uuid, p_conversation_id uuid, p_handoff_event_id uuid, p_sla_due_at timestamptz, p_context jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s jsonb; h public.handoff_events; c public.conversations; st public.lead_distribution_state;
  existing uuid; chain uuid := gen_random_uuid(); d record; rep public.sales_reps;
  lookback integer; new_id uuid; opp_id uuid;
BEGIN
  SELECT settings INTO s FROM public.organizations WHERE id = p_organization_id;
  IF s IS NULL OR s->>'lead_distribution_enabled' IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
  SELECT * INTO h FROM public.handoff_events WHERE id = p_handoff_event_id AND organization_id = p_organization_id AND conversation_id = p_conversation_id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'Handoff inexistente para esta conversa'; END IF;
  IF s->>'lead_distribution_activated_at' IS NOT NULL AND h.handed_at < (s->>'lead_distribution_activated_at')::timestamptz THEN RETURN NULL; END IF;

  -- Trava por organização: serializa as atribuições e protege o ponteiro do rodízio.
  INSERT INTO public.lead_distribution_state (organization_id) VALUES (p_organization_id) ON CONFLICT DO NOTHING;
  SELECT * INTO st FROM public.lead_distribution_state WHERE organization_id = p_organization_id FOR UPDATE;

  SELECT id INTO existing FROM public.lead_assignments WHERE handoff_event_id = p_handoff_event_id AND previous_assignment_id IS NULL;
  IF existing IS NOT NULL THEN RETURN existing; END IF;
  SELECT id INTO existing FROM public.lead_assignments WHERE conversation_id = p_conversation_id AND status IN ('pending','accepted');
  IF existing IS NOT NULL THEN RETURN existing; END IF;

  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id AND organization_id = p_organization_id;
  lookback := COALESCE(NULLIF(s->>'owner_lookback_days', '')::integer, 30);
  SELECT * INTO d FROM public._lead_decide(p_organization_id, c.id, c.contact_id, st.last_rotation_order, lookback);

  IF d.exception_reason IS NOT NULL THEN
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, rep_id, reason, status, handoff_at, exception_reason,
                                         origin_source, operation, product_model, strategy_version)
    VALUES (p_organization_id, chain, p_handoff_event_id, c.contact_id, c.id, NULL, 'exception', 'exception', h.handed_at, d.exception_reason,
            p_context->>'origin_source', p_context->>'operation', p_context->>'product_model', 'round_robin_v1')
    RETURNING id INTO new_id;
    RETURN new_id;
  END IF;

  SELECT * INTO rep FROM public.sales_reps WHERE id = d.rep_id;
  IF d.reason = 'round_robin' THEN
    UPDATE public.lead_distribution_state SET last_rotation_order = rep.rotation_order, updated_at = now() WHERE organization_id = p_organization_id;
    UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = rep.id;
  END IF;

  opp_id := public._lead_apply_effects(p_organization_id, c.id, c.contact_id, rep.user_id);
  INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at, sla_due_at, sla_action,
                                       origin_source, operation, product_model, strategy_version)
  VALUES (p_organization_id, chain, p_handoff_event_id, c.contact_id, c.id, opp_id, rep.id, d.reason, 'pending', h.handed_at, p_sla_due_at,
          CASE WHEN d.reason = 'existing_owner' THEN 'alert' ELSE 'redistribute' END,
          p_context->>'origin_source', p_context->>'operation', p_context->>'product_model', 'round_robin_v1')
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION public._lead_owner_check(uuid, uuid), public.resolve_current_owner(uuid, uuid, uuid, integer), public._lead_decide(uuid, uuid, uuid, integer, integer),
  public._lead_apply_effects(uuid, uuid, uuid, uuid), public.distribute_lead(uuid, uuid, uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._lead_owner_check(uuid, uuid), public.resolve_current_owner(uuid, uuid, uuid, integer), public._lead_decide(uuid, uuid, uuid, integer, integer),
  public._lead_apply_effects(uuid, uuid, uuid, uuid), public.distribute_lead(uuid, uuid, uuid, timestamptz, jsonb) TO service_role;
