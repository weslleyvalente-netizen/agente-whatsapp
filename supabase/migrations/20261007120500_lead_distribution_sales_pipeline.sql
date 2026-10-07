-- supabase/migrations/20261007120500_lead_distribution_sales_pipeline.sql
-- C3: com a distribuição ligada, o encaminhamento qualificado (tarefa + dono do negócio) segue o vendedor distribuído,
-- não o responsável padrão. Com a flag desligada o resultado é idêntico ao de 20261002024809.

-- Responsável do encaminhamento: vendedor da atribuição ativa; NULL se a conversa está na fila de exceções; senão o padrão.
CREATE OR REPLACE FUNCTION public._lead_handoff_assignee(p_org uuid, p_conversation uuid, p_default uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE rep_user uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org AND settings->>'lead_distribution_enabled' = 'true') THEN RETURN p_default; END IF;
  SELECT r.user_id INTO rep_user FROM public.lead_assignments a JOIN public.sales_reps r ON r.id = a.rep_id
   WHERE a.organization_id = p_org AND a.conversation_id = p_conversation AND a.status IN ('pending','accepted') LIMIT 1;
  IF rep_user IS NOT NULL THEN RETURN rep_user; END IF;
  IF EXISTS (SELECT 1 FROM public.lead_assignments WHERE organization_id = p_org AND conversation_id = p_conversation AND status = 'exception' AND resolved_at IS NULL) THEN
    RETURN NULL;
  END IF;
  RETURN p_default;
END $$;
REVOKE ALL ON FUNCTION public._lead_handoff_assignee(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._lead_handoff_assignee(uuid, uuid, uuid) TO service_role;

-- Corpo copiado de 20261002024809_sales_marina_queue.sql; só o bloco de resolução do responsável mudou.
CREATE OR REPLACE FUNCTION public.sync_sales_pipeline(p_organization_id uuid,p_conversation_id uuid,p_customer_message_id uuid,p_response_message_id uuid,p_operation text,p_stage text,p_explicit_operation boolean,p_fields jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.conversations; m public.messages; o public.opportunities; candidates integer; stages text[]; old_value jsonb; h public.handoff_events; t public.tasks; assignee uuid; due_at timestamp; start_hour int; end_hour int; handoff_note text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=p_organization_id AND settings->>'sales_auto_pipeline_enabled'='true') THEN RETURN NULL; END IF;
 SELECT * INTO STRICT c FROM public.conversations WHERE id=p_conversation_id AND organization_id=p_organization_id;
 SELECT * INTO STRICT m FROM public.messages WHERE id=p_customer_message_id AND conversation_id=c.id AND organization_id=p_organization_id AND role='contact';
 PERFORM 1 FROM public.wa_contacts WHERE id=c.contact_id AND organization_id=p_organization_id FOR UPDATE;
 -- Do not process stale qualifying messages after a newer customer reply.
 IF EXISTS(SELECT 1 FROM public.messages WHERE conversation_id=c.id AND role='contact' AND created_at>m.created_at) THEN RETURN NULL; END IF;
 IF p_response_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.messages WHERE id=p_response_message_id AND organization_id=p_organization_id AND conversation_id=c.id AND role='agent' AND evolution_message_id IS NOT NULL) THEN RAISE EXCEPTION 'Proposta ainda não confirmada'; END IF;
 stages:=CASE p_operation
 WHEN 'vehicle_sale' THEN ARRAY['interest_received','qualification','proposal_sent','negotiation','formalization']
 WHEN 'consortium' THEN ARRAY['interest_received','qualification','simulation_sent','decision_negotiation','membership']
 WHEN 'financing' THEN ARRAY['interest_received','qualification','documentation','awaiting_simulation','bank_analysis','conditions_approved_negotiation','formalization']
 WHEN 'libera_cred' THEN ARRAY['interest_received','qualification','plan_term_presented','decision_objections','membership']
 WHEN 'contemplated_letter' THEN ARRAY['interest_received','qualification','compatible_letter_search','proposal_sent','analysis_transfer'] ELSE NULL END;
 IF stages IS NULL OR NOT (p_stage=ANY(stages)) THEN RAISE EXCEPTION 'Etapa inválida'; END IF;
 IF p_stage IN ('proposal_sent','simulation_sent','plan_term_presented') AND p_response_message_id IS NULL THEN RAISE EXCEPTION 'Falta evidência da apresentação'; END IF;
 IF p_operation='financing' AND p_stage NOT IN ('interest_received','qualification','documentation','awaiting_simulation') THEN RAISE EXCEPTION 'Resultado bancário exige registro humano'; END IF;
 IF p_stage='awaiting_simulation' AND NOT EXISTS(SELECT 1 FROM public.conversation_qualifications q JOIN public.handoff_events he ON he.conversation_id=q.conversation_id AND he.organization_id=q.organization_id WHERE q.conversation_id=c.id AND q.organization_id=p_organization_id AND q.cpf_encrypted IS NOT NULL AND q.birth_date IS NOT NULL AND q.has_driver_license IS NOT NULL AND q.down_payment_amount>=0 AND q.product_model IS NOT NULL AND he.trigger_type='request_human' AND he.first_human_reply_at IS NULL) THEN RAISE EXCEPTION 'Simulação exige cadastro e encaminhamento reais'; END IF;
 SELECT count(*) INTO candidates FROM public.opportunities WHERE organization_id=p_organization_id AND contact_id=c.contact_id AND status='open';
 IF candidates>1 THEN RETURN NULL; END IF;
 SELECT * INTO o FROM public.opportunities WHERE organization_id=p_organization_id AND contact_id=c.contact_id AND status='open' FOR UPDATE;
 IF o.id IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.opportunities WHERE organization_id=p_organization_id AND contact_id=c.contact_id) THEN RETURN NULL; END IF;
  INSERT INTO public.opportunities(organization_id,contact_id,operation,initial_operation,stage,product_model,sale_amount,credit_amount,down_payment_amount,bid_amount,target_installment_amount,term_months,usage_purpose,urgency,commercial_notes,last_interaction_at,last_progress_at,next_action)
  VALUES(p_organization_id,c.contact_id,p_operation,p_operation,p_stage,p_fields->>'product_model',(p_fields->>'sale_amount')::numeric,(p_fields->>'credit_amount')::numeric,(p_fields->>'down_payment_amount')::numeric,(p_fields->>'bid_amount')::numeric,(p_fields->>'target_installment_amount')::numeric,(p_fields->>'term_months')::integer,p_fields->>'usage_purpose',p_fields->>'urgency',p_fields->>'commercial_notes',m.created_at,now(),p_fields->>'next_action') RETURNING * INTO o;
  INSERT INTO public.opportunity_events(organization_id,opportunity_id,event_type,new_value,evidence,changed_by_type)
  VALUES(p_organization_id,o.id,'created',jsonb_build_object('operation',p_operation,'stage',p_stage,'message_id',m.id),'Interesse identificado: '||left(m.content,2000),'ai');
 ELSE
  IF o.frozen_until IS NOT NULL THEN RETURN o.id; END IF;
  IF o.operation='financing' AND o.stage IN ('bank_analysis','conditions_approved_negotiation','financing_rejected','formalization') THEN RETURN o.id; END IF;
  old_value:=jsonb_build_object('operation',o.operation,'stage',o.stage);
  IF o.operation<>p_operation THEN
   IF NOT p_explicit_operation THEN RETURN o.id; END IF;
   UPDATE public.opportunities SET operation=p_operation,stage=stages[1],last_progress_at=now(),sale_amount=NULL,credit_amount=NULL,down_payment_amount=NULL,bid_amount=NULL,target_installment_amount=NULL,term_months=NULL WHERE id=o.id;
   INSERT INTO public.opportunity_events(organization_id,opportunity_id,event_type,previous_value,new_value,evidence,changed_by_type)
   VALUES(p_organization_id,o.id,'operation_changed',old_value,jsonb_build_object('operation',p_operation,'stage',stages[1]),'Interesse explícito: '||left(m.content,2000),'ai');
   o.stage:=stages[1];
  END IF;
  IF o.stage NOT IN ('financing_rejected','bank_analysis','conditions_approved_negotiation','formalization') AND array_position(stages,p_stage)>array_position(stages,o.stage) THEN
   UPDATE public.opportunities SET stage=p_stage,last_progress_at=now() WHERE id=o.id;
   INSERT INTO public.opportunity_events(organization_id,opportunity_id,event_type,previous_value,new_value,evidence,changed_by_type)
   VALUES(p_organization_id,o.id,'stage_changed',jsonb_build_object('stage',o.stage),jsonb_build_object('stage',p_stage,'message_id',m.id,'response_message_id',p_response_message_id),'Evolução com evidência: '||left(m.content,2000),'ai');
  END IF;
  -- Fill missing values only. Human-entered values/results are never replaced.
  UPDATE public.opportunities SET product_model=coalesce(product_model,p_fields->>'product_model'),sale_amount=coalesce(sale_amount,(p_fields->>'sale_amount')::numeric),down_payment_amount=coalesce(down_payment_amount,(p_fields->>'down_payment_amount')::numeric),target_installment_amount=coalesce(target_installment_amount,(p_fields->>'target_installment_amount')::numeric) WHERE id=o.id;
  UPDATE public.opportunities SET last_interaction_at=greatest(last_interaction_at,m.created_at) WHERE id=o.id;
 END IF;
 UPDATE public.conversation_qualifications SET opportunity_id=o.id WHERE conversation_id=c.id AND organization_id=p_organization_id;
 -- Exactly one open business, including historical ambiguity checks above.
 WITH linked AS (UPDATE public.tasks SET opportunity_id=o.id WHERE organization_id=p_organization_id AND contact_id=c.contact_id AND opportunity_id IS NULL AND status IN('pending','in_progress','rescheduled') RETURNING id)
 INSERT INTO public.task_events(task_id,organization_id,event_type,note,created_by_type)
 SELECT id,p_organization_id,'opportunity_auto_linked','Vinculada ao negócio '||o.id::text,'ai' FROM linked;
 -- New behavior opt-in: no historical sweep, no message delivery, no task deletion.
 IF EXISTS(SELECT 1 FROM public.organizations WHERE id=p_organization_id AND settings->>'sales_qualified_handoff_task_enabled'='true') THEN
  SELECT * INTO h FROM public.handoff_events WHERE organization_id=p_organization_id AND conversation_id=c.id AND trigger_type='request_human' AND first_human_reply_at IS NULL ORDER BY handed_at DESC,id LIMIT 1;
  IF h.id IS NOT NULL AND (p_stage='awaiting_simulation' OR h.motivo IN ('proposta_pronta','negociacao_valor','cliente_pediu')) AND o.stage NOT IN ('financing_rejected','bank_analysis','conditions_approved_negotiation','formalization') THEN
   handoff_note:='Encaminhamento qualificado '||h.id::text;
   IF NOT EXISTS(SELECT 1 FROM public.task_events WHERE organization_id=p_organization_id AND event_type='qualified_handoff' AND note=handoff_note) THEN
    SELECT u.id INTO assignee FROM public.organizations org JOIN public.organization_members om ON om.organization_id=org.id JOIN auth.users u ON u.id=om.user_id WHERE org.id=p_organization_id AND u.id::text=org.settings->>'default_handoff_assignee_id' LIMIT 1;
    IF assignee IS NULL AND (SELECT count(*) FROM public.organization_members WHERE organization_id=p_organization_id)=1 THEN SELECT user_id INTO assignee FROM public.organization_members WHERE organization_id=p_organization_id; END IF;
    -- Distribuição de leads (flag lead_distribution_enabled): vendedor da atribuição ativa; NULL com exceção em aberto; senão o padrão acima.
    assignee:=public._lead_handoff_assignee(p_organization_id,c.id,assignee);
    IF assignee IS NOT NULL THEN
     SELECT coalesce((tools_config->'followup_automatico'->>'janela_inicio_hora')::int,8),coalesce((tools_config->'followup_automatico'->>'janela_fim_hora')::int,18) INTO start_hour,end_hour FROM public.agents WHERE id=c.agent_id AND organization_id=p_organization_id;
     start_hour:=coalesce(start_hour,8);end_hour:=coalesce(end_hour,18);
     due_at:=now() AT TIME ZONE 'America/Sao_Paulo';
     IF extract(hour FROM due_at)<start_hour THEN due_at:=date_trunc('day',due_at)+make_interval(hours=>start_hour); ELSIF extract(hour FROM due_at)>=end_hour THEN due_at:=date_trunc('day',due_at)+interval '1 day'+make_interval(hours=>start_hour); END IF;
     SELECT * INTO t FROM public.tasks WHERE organization_id=p_organization_id AND opportunity_id=o.id AND status IN ('pending','in_progress','rescheduled') ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,created_at,id LIMIT 1 FOR UPDATE;
     IF t.id IS NULL THEN
      INSERT INTO public.tasks(organization_id,contact_id,conversation_id,opportunity_id,assignee_type,assignee_id,type,title,description,priority,due_date,due_time,created_by_type)
      VALUES(p_organization_id,c.contact_id,c.id,o.id,'human',assignee,CASE WHEN p_stage='awaiting_simulation' THEN 'run_quote' ELSE 'return_customer' END,'Atender cliente qualificado',coalesce(h.resumo,'Cliente solicitou atendimento humano'),'high',due_at::date,due_at::time,'ai') RETURNING * INTO t;
      INSERT INTO public.task_events(task_id,organization_id,event_type,note,created_by_type) VALUES(t.id,p_organization_id,'created','Tarefa criada no próximo horário de atendimento','ai');
     ELSE
      -- Do not overwrite promised dates, CPF pendencies or higher-priority task types.
      UPDATE public.tasks SET assignee_type='human',assignee_id=assignee,
       consolidated_pendencies=CASE WHEN jsonb_array_length(consolidated_pendencies)=0 THEN jsonb_build_array(jsonb_build_object('type',type,'description',description,'reason',reason,'priority',priority,'due_date',due_date,'due_time',due_time,'added_at',created_at,'added_by_type',created_by_type,'added_by_id',created_by_id)) ELSE consolidated_pendencies END WHERE id=t.id;
     END IF;
     UPDATE public.tasks SET consolidated_pendencies=consolidated_pendencies||jsonb_build_array(jsonb_build_object('type',CASE WHEN p_stage='awaiting_simulation' THEN 'run_quote' ELSE 'return_customer' END,'description',coalesce(h.resumo,'Atender cliente qualificado'),'reason',handoff_note,'priority','high','due_date',due_at::date,'due_time',due_at::time,'added_at',now(),'added_by_type','ai','added_by_id',NULL)) WHERE id=t.id;
     -- Expose every pendency in the existing task UI, keeping the strongest type.
     UPDATE public.tasks SET
       type=CASE WHEN priority IN ('low','normal') THEN CASE WHEN p_stage='awaiting_simulation' THEN 'run_quote' ELSE 'return_customer' END ELSE type END,
       priority=CASE WHEN priority IN ('low','normal') THEN 'high' ELSE priority END,
       description=(SELECT string_agg(item->>'description',E'\n\n' ORDER BY n) FROM jsonb_array_elements(consolidated_pendencies) WITH ORDINALITY AS p(item,n))
     WHERE id=t.id;
     INSERT INTO public.task_events(task_id,organization_id,event_type,note,created_by_type)
     SELECT t.id,p_organization_id,'consolidated','Encaminhamento consolidado: '||t.type||' → '||updated.type,'ai' FROM public.tasks updated WHERE updated.id=t.id;
     INSERT INTO public.task_events(task_id,organization_id,event_type,note,created_by_type) VALUES(t.id,p_organization_id,'qualified_handoff',handoff_note,'ai');
     UPDATE public.opportunities SET owner_id=coalesce(owner_id,assignee),waiting_on='team',next_action=CASE WHEN p_stage='awaiting_simulation' THEN 'Rodar simulação de financiamento' ELSE 'Atender cliente encaminhado pela IA' END,next_action_due_date=coalesce(next_action_due_date,due_at::date) WHERE id=o.id;
    END IF;
   END IF;
  END IF;
 END IF;
 RETURN o.id;
END $$;
REVOKE ALL ON FUNCTION public.sync_sales_pipeline(uuid,uuid,uuid,uuid,text,text,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_sales_pipeline(uuid,uuid,uuid,uuid,text,text,boolean,jsonb) TO service_role;
