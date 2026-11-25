-- Encaminhamento exclusivamente administrativo/pós-venda não abre card automático (decisão do dono 25/11), inclusive para contato sem
-- histórico. Nunca impede o encaminhamento, a atribuição de responsável (rodízio) nem a tarefa de atendimento (criada pela IA).
-- Na dúvida ('unclear' ou sem marca) o card continua sendo criado. Flag: handoff_admin_no_card_enabled (desligada por padrão).
-- A marca vem do requestHuman (classificação de packages/shared/src/handoff-operation.ts), gravada no próprio handoff_events.
-- Cobre os dois caminhos que criam o card de encaminhamento: distribute_lead (_lead_apply_effects) e a escalada de SLA
-- (20261027120200), porque ambos chamam _open_opportunity_for_handoff. Compatível com o #123 (que não redefine esta função).
--
-- Reverter: recriar _open_opportunity_for_handoff de 20261027120000; ALTER TABLE public.handoff_events DROP COLUMN IF EXISTS commercial_intent;

ALTER TABLE public.handoff_events ADD COLUMN IF NOT EXISTS commercial_intent text
  CHECK (commercial_intent IS NULL OR commercial_intent IN ('commercial', 'administrative', 'unclear'));

-- Corpo de 20261027120000; só entra a checagem do encaminhamento administrativo.
CREATE OR REPLACE FUNCTION public._open_opportunity_for_handoff(p_org uuid, p_conversation uuid, p_contact uuid, p_user uuid, p_operation text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_operation text; v_source text; v_default boolean := false; v_owner uuid; v_opp uuid; v_task_ops text[];
BEGIN
  -- 1. Só leituras, sem lock.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org AND settings->'sales_auto_pipeline_enabled' = 'true'::jsonb) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org AND settings->'handoff_card_enabled' = 'false'::jsonb) THEN RETURN NULL; END IF;
  -- Atendimento exclusivamente administrativo/pós-venda (último encaminhamento da conversa marcado pela IA): sem card. A atribuição,
  -- o responsável e a tarefa de atendimento seguem normalmente (feitos fora desta função). 'unclear' ou sem marca = cria como antes.
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org AND settings->'handoff_admin_no_card_enabled' = 'true'::jsonb)
     AND (SELECT h.commercial_intent FROM public.handoff_events h WHERE h.organization_id = p_org AND h.conversation_id = p_conversation
           ORDER BY h.handed_at DESC, h.id DESC LIMIT 1) = 'administrative' THEN
    RETURN NULL;
  END IF;
  IF public._contact_has_deal_history(p_org, p_contact) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.organization_ignored_contacts i JOIN public.wa_contacts w ON w.organization_id = i.organization_id AND w.phone = i.phone
              WHERE w.id = p_contact AND w.organization_id = p_org) THEN
    RETURN NULL;
  END IF;

  -- 2. Só agora, e sem esperar: trava o contato (mesmo lock de human_task_opens_opportunity; conflita com o FOR UPDATE do sync_sales_pipeline).
  PERFORM 1 FROM public.wa_contacts WHERE id = p_contact AND organization_id = p_org FOR NO KEY UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- 3. Reconfere depois do lock (outro commit pode ter criado).
  IF public._contact_has_deal_history(p_org, p_contact) THEN RETURN NULL; END IF;

  -- Operação.
  IF p_operation IN ('vehicle_sale', 'consortium', 'financing', 'libera_cred', 'contemplated_letter') THEN
    v_operation := p_operation; v_source := 'handoff_context';
  END IF;
  IF v_operation IS NULL THEN
    SELECT a.operation INTO v_operation FROM public.lead_assignments a
     WHERE a.organization_id = p_org AND a.conversation_id = p_conversation
       AND a.operation IN ('vehicle_sale', 'consortium', 'financing', 'libera_cred', 'contemplated_letter')
     ORDER BY a.assigned_at DESC, a.created_at DESC LIMIT 1;
    IF v_operation IS NOT NULL THEN v_source := 'assignment'; END IF;
  END IF;
  IF v_operation IS NULL THEN
    SELECT array_agg(DISTINCT public._task_type_operation(x.type)) INTO v_task_ops FROM public.tasks x
     WHERE x.organization_id = p_org AND x.contact_id = p_contact
       AND x.status IN ('pending', 'in_progress', 'rescheduled') AND public._task_type_operation(x.type) IS NOT NULL;
    IF array_length(v_task_ops, 1) = 1 THEN v_operation := v_task_ops[1]; v_source := 'task_type'; END IF;
  END IF;
  IF v_operation IS NULL THEN v_operation := 'vehicle_sale'; v_source := 'default'; v_default := true; END IF;

  -- Dono: o vendedor que recebeu o lead, se for vendedor cadastrado da organização.
  IF p_user IS NOT NULL AND EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = p_org AND r.user_id = p_user) THEN v_owner := p_user; END IF;

  INSERT INTO public.opportunities(organization_id, contact_id, operation, initial_operation, stage, status, owner_id, owner_assigned_at, last_progress_at, operation_is_default)
  VALUES (p_org, p_contact, v_operation, v_operation, 'interest_received', 'open', v_owner, CASE WHEN v_owner IS NOT NULL THEN now() END, now(), v_default)
  RETURNING id INTO v_opp;

  INSERT INTO public.opportunity_events(organization_id, opportunity_id, event_type, new_value, evidence, changed_by_type)
  VALUES (p_org, v_opp, 'created',
          jsonb_build_object('operation', v_operation, 'stage', 'interest_received', 'source', 'handoff_card', 'operation_source', v_source,
                             'operation_is_default', v_default, 'conversation_id', p_conversation),
          CASE WHEN v_default THEN 'Negócio criado no encaminhamento para humano (operação a confirmar)' ELSE 'Negócio criado no encaminhamento para humano' END,
          'system');

  -- Tarefas abertas do contato sem negócio passam a apontar para o card (como sync_sales_pipeline). SKIP LOCKED: nunca espera linha de tarefa.
  WITH linked AS (
    UPDATE public.tasks SET opportunity_id = v_opp
     WHERE id IN (SELECT x.id FROM public.tasks x
                   WHERE x.organization_id = p_org AND x.contact_id = p_contact AND x.opportunity_id IS NULL
                     AND x.status IN ('pending', 'in_progress', 'rescheduled')
                   FOR UPDATE SKIP LOCKED)
    RETURNING id)
  INSERT INTO public.task_events(task_id, organization_id, event_type, note, created_by_type)
  SELECT id, p_org, 'opportunity_auto_linked', 'Vinculada ao negócio ' || v_opp::text, 'ai' FROM linked;
  RETURN v_opp;
END $$;
REVOKE ALL ON FUNCTION public._open_opportunity_for_handoff(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._open_opportunity_for_handoff(uuid, uuid, uuid, uuid, text) TO service_role;
