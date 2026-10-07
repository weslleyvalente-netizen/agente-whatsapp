-- supabase/migrations/20261007120200_lead_distribution_lifecycle.sql
CREATE FUNCTION public.redistribute_assignment(p_assignment_id uuid, p_new_sla_due_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; cur public.sales_reps; nxt public.sales_reps; new_id uuid; opp_id uuid; org uuid;
BEGIN
  SELECT organization_id INTO org FROM public.lead_assignments WHERE id = p_assignment_id;
  IF org IS NULL THEN RETURN NULL; END IF;
  -- Mesma ordem de travas de distribute_lead: estado da organização primeiro, depois a linha.
  PERFORM 1 FROM public.lead_distribution_state WHERE organization_id = org FOR UPDATE;
  SELECT * INTO a FROM public.lead_assignments WHERE id = p_assignment_id FOR UPDATE;
  -- Só lead novo do rodízio é redistribuído; dono existente e atribuição manual ('alert') nunca mudam de vendedor sozinhos.
  IF a.status <> 'pending' OR a.sla_action <> 'redistribute' OR a.sla_due_at IS NULL OR a.sla_due_at > now() THEN RETURN NULL; END IF;

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

CREATE FUNCTION public.accept_assignment(p_assignment_id uuid, p_actor uuid, p_actor_is_admin boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; rep public.sales_reps;
BEGIN
  SELECT * INTO a FROM public.lead_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF a.id IS NULL OR a.status <> 'pending' THEN RETURN false; END IF;
  SELECT * INTO rep FROM public.sales_reps WHERE id = a.rep_id;
  IF NOT p_actor_is_admin AND p_actor IS DISTINCT FROM rep.user_id THEN
    RAISE EXCEPTION 'Somente o vendedor atribuído (ou um admin) pode assumir o lead';
  END IF;
  UPDATE public.lead_assignments
     SET status = 'accepted', accepted_at = now(), accepted_via = CASE WHEN p_actor_is_admin AND p_actor IS DISTINCT FROM rep.user_id THEN 'admin' ELSE 'button' END
   WHERE id = a.id;
  RETURN true;
END $$;

-- Primeira mensagem humana: marca a primeira resposta (KPI) e, se vier do vendedor atribuído, assume o lead.
-- O chamador já filtrou a origem humana (isHumanOriginMessage); aqui só se aplica a regra de quem pode assumir.
CREATE FUNCTION public.record_human_message(p_organization_id uuid, p_conversation_id uuid, p_at timestamptz, p_author uuid, p_via text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; rep public.sales_reps; conv_user uuid; may_accept boolean := false;
BEGIN
  IF p_via NOT IN ('panel','phone_echo') THEN RAISE EXCEPTION 'Origem inválida'; END IF;
  SELECT * INTO a FROM public.lead_assignments
   WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id AND status IN ('pending','accepted') FOR UPDATE;
  IF a.id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO rep FROM public.sales_reps WHERE id = a.rep_id;
  IF a.first_human_message_at IS NULL THEN
    UPDATE public.lead_assignments SET first_human_message_at = p_at, first_human_message_by = p_author WHERE id = a.id;
  END IF;
  -- Atividade comercial relevante (mensagem humana) mantém a carteira dentro da janela de 30 dias.
  UPDATE public.opportunities SET last_commercial_activity_at = GREATEST(COALESCE(last_commercial_activity_at, p_at), p_at)
   WHERE organization_id = p_organization_id AND contact_id = a.contact_id AND status = 'open';
  IF a.status = 'pending' THEN
    IF p_via = 'panel' THEN may_accept := p_author IS NOT DISTINCT FROM rep.user_id;
    ELSE
      SELECT assigned_to INTO conv_user FROM public.conversations WHERE id = p_conversation_id;
      may_accept := p_author IS NULL AND conv_user IS NOT DISTINCT FROM rep.user_id;
    END IF;
    IF may_accept THEN
      UPDATE public.lead_assignments SET status = 'accepted', accepted_at = p_at, accepted_via = CASE WHEN p_via = 'panel' THEN 'first_message' ELSE 'phone_echo' END WHERE id = a.id;
    END IF;
  END IF;
  RETURN a.id;
END $$;

CREATE FUNCTION public.manual_assign(p_organization_id uuid, p_conversation_id uuid, p_rep_id uuid, p_actor uuid, p_sla_due_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prev public.lead_assignments; rep public.sales_reps; new_id uuid; opp_id uuid;
BEGIN
  PERFORM 1 FROM public.lead_distribution_state WHERE organization_id = p_organization_id FOR UPDATE;
  SELECT * INTO prev FROM public.lead_assignments
   WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id
     AND (status IN ('pending','accepted') OR (status = 'exception' AND resolved_at IS NULL))
   ORDER BY assigned_at DESC LIMIT 1 FOR UPDATE;
  IF prev.id IS NULL THEN RAISE EXCEPTION 'Conversa sem atribuição ou exceção para reatribuir'; END IF;
  SELECT * INTO rep FROM public.sales_reps WHERE id = p_rep_id AND organization_id = p_organization_id;
  IF rep.id IS NULL THEN RAISE EXCEPTION 'Vendedor inexistente'; END IF;
  IF rep.availability = 'out' THEN RAISE EXCEPTION 'Vendedor fora da distribuição'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = p_organization_id AND m.user_id = rep.user_id) THEN
    RAISE EXCEPTION 'Vendedor não é mais membro da organização';
  END IF;

  IF prev.status = 'exception' THEN
    UPDATE public.lead_assignments SET resolved_at = now(), resolved_by = p_actor, resolution = 'manual_assignment' WHERE id = prev.id;
  ELSE
    UPDATE public.lead_assignments SET status = 'redistributed', redistribution_reason = 'manual' WHERE id = prev.id;
  END IF;
  opp_id := public._lead_apply_effects(p_organization_id, p_conversation_id, prev.contact_id, rep.user_id);
  INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at, sla_due_at, sla_action,
                                       previous_assignment_id, origin_source, operation, product_model, strategy_version)
  VALUES (p_organization_id, prev.chain_id, prev.handoff_event_id, prev.contact_id, prev.conversation_id, opp_id, rep.id, 'manual', 'pending', prev.handoff_at, p_sla_due_at, 'alert',
          prev.id, prev.origin_source, prev.operation, prev.product_model, prev.strategy_version)
  RETURNING id INTO new_id;
  UPDATE public.lead_assignments SET next_assignment_id = new_id WHERE id = prev.id;
  RETURN new_id;
END $$;

-- Alerta de SLA para quem não é redistribuído (dono existente e atribuição manual): só marca; o vendedor continua o mesmo.
CREATE FUNCTION public.flag_sla_alerts() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE public.lead_assignments SET sla_breached = true
   WHERE status = 'pending' AND sla_action = 'alert' AND sla_due_at <= now() AND NOT sla_breached;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.redistribute_assignment(uuid, timestamptz), public.accept_assignment(uuid, uuid, boolean), public.flag_sla_alerts(),
  public.record_human_message(uuid, uuid, timestamptz, uuid, text), public.manual_assign(uuid, uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redistribute_assignment(uuid, timestamptz), public.accept_assignment(uuid, uuid, boolean), public.flag_sla_alerts(),
  public.record_human_message(uuid, uuid, timestamptz, uuid, text), public.manual_assign(uuid, uuid, uuid, uuid, timestamptz) TO service_role;
