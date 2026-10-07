-- supabase/migrations/20261007120300_lead_distribution_shadow.sql
-- Modo sombra: decide como a distribuição real decidiria, registra, e não altera nada real.
CREATE FUNCTION public.distribute_lead_shadow(p_organization_id uuid, p_conversation_id uuid, p_handoff_event_id uuid, p_sla_due_at timestamptz, p_context jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s jsonb; h public.handoff_events; c public.conversations; st public.lead_distribution_state; existing uuid; d record;
        rep public.sales_reps; lookback integer; before integer; after integer; new_id uuid;
BEGIN
  SELECT settings INTO s FROM public.organizations WHERE id = p_organization_id;
  IF s IS NULL OR s->>'lead_distribution_shadow_enabled' IS DISTINCT FROM 'true' OR s->>'lead_distribution_enabled' = 'true' THEN RETURN NULL; END IF;
  SELECT * INTO h FROM public.handoff_events WHERE id = p_handoff_event_id AND organization_id = p_organization_id AND conversation_id = p_conversation_id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'Handoff inexistente para esta conversa'; END IF;

  INSERT INTO public.lead_distribution_state (organization_id) VALUES (p_organization_id) ON CONFLICT DO NOTHING;
  SELECT * INTO st FROM public.lead_distribution_state WHERE organization_id = p_organization_id FOR UPDATE;
  SELECT id INTO existing FROM public.lead_distribution_shadow_log WHERE handoff_event_id = p_handoff_event_id;
  IF existing IS NOT NULL THEN RETURN existing; END IF;

  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id AND organization_id = p_organization_id;
  lookback := COALESCE(NULLIF(s->>'owner_lookback_days', '')::integer, 30);
  before := st.shadow_last_rotation_order; after := before;
  SELECT * INTO d FROM public._lead_decide(p_organization_id, c.id, c.contact_id, before, lookback);
  IF d.rep_id IS NOT NULL THEN
    SELECT * INTO rep FROM public.sales_reps WHERE id = d.rep_id;
    IF d.reason = 'round_robin' THEN
      after := rep.rotation_order;
      UPDATE public.lead_distribution_state SET shadow_last_rotation_order = after, updated_at = now() WHERE organization_id = p_organization_id;
    END IF;
  END IF;

  INSERT INTO public.lead_distribution_shadow_log (organization_id, handoff_event_id, conversation_id, contact_id, would_rep_id, would_rep_name, reason, exception_reason,
                                                   pointer_before, pointer_after, sla_due_at, sla_action, handed_at, context)
  VALUES (p_organization_id, p_handoff_event_id, c.id, c.contact_id, d.rep_id, rep.display_name, d.reason, d.exception_reason, before, after, p_sla_due_at,
          CASE WHEN d.rep_id IS NULL THEN NULL WHEN d.reason = 'existing_owner' THEN 'alert' ELSE 'redistribute' END, h.handed_at, COALESCE(p_context, '{}'::jsonb))
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION public.distribute_lead_shadow(uuid, uuid, uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.distribute_lead_shadow(uuid, uuid, uuid, timestamptz, jsonb) TO service_role;
