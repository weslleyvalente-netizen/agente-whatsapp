-- Additive; never backfills or changes production flags.
ALTER TABLE public.opportunities
 ADD COLUMN frozen_until date,
 ADD COLUMN frozen_at timestamptz,
 ADD COLUMN freeze_reason text,
 ADD COLUMN freeze_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
 ADD COLUMN freeze_previous_pendency jsonb,
 ADD COLUMN freeze_previous_waiting jsonb,
 ADD CONSTRAINT opportunities_freeze_pair CHECK ((frozen_until IS NULL) = (freeze_reason IS NULL));

-- Rebuild presentation from the remaining pending items without dropping them.
CREATE FUNCTION public.refresh_freeze_task(p_task_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE t public.tasks; primary_item jsonb; description_text text;
BEGIN
 SELECT * INTO STRICT t FROM public.tasks WHERE id=p_task_id FOR UPDATE;
 IF jsonb_array_length(t.consolidated_pendencies)=0 THEN
  UPDATE public.tasks SET status='cancelled' WHERE id=t.id;
  RETURN;
 END IF;
 SELECT value INTO primary_item FROM jsonb_array_elements(t.consolidated_pendencies)
 ORDER BY CASE value->>'priority' WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
 value->>'due_date', value->>'added_at' LIMIT 1;
 SELECT string_agg(value->>'description', E'\n' ORDER BY value->>'added_at') INTO description_text
 FROM jsonb_array_elements(t.consolidated_pendencies);
 UPDATE public.tasks SET type=primary_item->>'type',title=CASE WHEN primary_item->>'type'='scheduled_callback' THEN 'Retorno combinado' ELSE t.title END,
 priority=primary_item->>'priority', reason=primary_item->>'reason', due_time=(primary_item->>'due_time')::time, description=description_text,
 due_date=(SELECT min((value->>'due_date')::date) FROM jsonb_array_elements(t.consolidated_pendencies))
 WHERE id=t.id;
END $$;
REVOKE ALL ON FUNCTION public.refresh_freeze_task(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.set_opportunity_freeze(p_organization_id uuid,p_opportunity_id uuid,p_actor_id uuid,p_until date,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o public.opportunities; t public.tasks; pendency jsonb; items jsonb; convo uuid; previous jsonb;
 today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id=p_organization_id AND user_id=p_actor_id) THEN
  RAISE EXCEPTION 'Access denied';
 END IF;
 SELECT * INTO STRICT o FROM public.opportunities WHERE id=p_opportunity_id AND organization_id=p_organization_id FOR UPDATE;
 IF o.status <> 'open' THEN RAISE EXCEPTION 'Somente negócios abertos podem ser congelados'; END IF;
 IF nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Informe o motivo'; END IF;
 IF p_until IS NOT NULL AND p_until <= today THEN RAISE EXCEPTION 'Informe uma data futura'; END IF;
 IF p_until IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=p_organization_id AND settings->>'sales_opportunity_freeze_enabled'='true') THEN RAISE EXCEPTION 'Congelamento desligado'; END IF;
 IF p_until IS NOT DISTINCT FROM o.frozen_until AND (p_until IS NULL OR trim(p_reason)=o.freeze_reason AND EXISTS(SELECT 1 FROM public.tasks WHERE id=o.freeze_task_id AND status IN('pending','in_progress','rescheduled'))) THEN RETURN to_jsonb(o); END IF;
 previous := jsonb_build_object('frozen_until',o.frozen_until,'freeze_reason',o.freeze_reason);
 IF o.freeze_task_id IS NOT NULL THEN
  SELECT * INTO t FROM public.tasks WHERE id=o.freeze_task_id AND organization_id=p_organization_id AND opportunity_id=o.id AND status IN ('pending','in_progress','rescheduled') FOR UPDATE;
 END IF;
 IF p_until IS NULL THEN
  IF t.id IS NOT NULL THEN
   SELECT coalesce(jsonb_agg(value),'[]'::jsonb) INTO items FROM jsonb_array_elements(t.consolidated_pendencies)
   WHERE value->>'freeze_opportunity_id' IS DISTINCT FROM o.id::text;
   IF o.freeze_previous_pendency IS NOT NULL THEN items:=items || jsonb_build_array(o.freeze_previous_pendency); END IF;
   UPDATE public.tasks SET consolidated_pendencies=items WHERE id=t.id;
   PERFORM public.refresh_freeze_task(t.id);
   INSERT INTO public.task_events(task_id,organization_id,event_type,note,created_by_type,created_by_id)
   VALUES(t.id,p_organization_id,'consolidated_pendency_resolved','Descongelado: '||trim(p_reason),'human',p_actor_id);
  END IF;
  UPDATE public.opportunities SET frozen_until=NULL,freeze_reason=NULL,freeze_task_id=NULL,freeze_previous_pendency=NULL,freeze_previous_waiting=NULL,
   waiting_on=o.freeze_previous_waiting->>'waiting_on',waiting_on_until=(o.freeze_previous_waiting->>'waiting_on_until')::date
  WHERE id=o.id RETURNING * INTO o;
 ELSE
  -- Lock the existing task, retaining every old pendency. Task consolidation
  -- and freezing serialize on this task row; freeze never deletes an old item.
  IF t.id IS NULL THEN
   SELECT * INTO t FROM public.tasks WHERE organization_id=p_organization_id AND opportunity_id=o.id
   AND status IN ('pending','in_progress','rescheduled') ORDER BY created_at,id LIMIT 1 FOR UPDATE;
  END IF;
  SELECT id INTO convo FROM public.conversations WHERE organization_id=p_organization_id AND contact_id=o.contact_id
  ORDER BY (status <> 'closed') DESC,last_message_at DESC NULLS LAST,id LIMIT 1;
  IF t.id IS NULL THEN
   INSERT INTO public.tasks(organization_id,contact_id,conversation_id,opportunity_id,type,title,description,priority,status,due_date,created_by_type,created_by_id,assignee_type,assignee_id)
   VALUES(p_organization_id,o.contact_id,convo,o.id,'scheduled_callback','Retorno combinado',trim(p_reason),'normal','pending',p_until,'human',p_actor_id,'human',coalesce(o.owner_id,p_actor_id)) RETURNING * INTO t;
  ELSIF jsonb_array_length(t.consolidated_pendencies)=0 THEN
   t.consolidated_pendencies:=jsonb_build_array(jsonb_build_object('type',t.type,'description',t.description,'reason',t.reason,'priority',t.priority,'due_date',t.due_date,'due_time',t.due_time,'added_at',t.created_at,'added_by_type',t.created_by_type,'added_by_id',t.created_by_id));
  END IF;
  IF o.frozen_until IS NULL THEN
   SELECT value INTO o.freeze_previous_pendency FROM jsonb_array_elements(t.consolidated_pendencies) WHERE value->>'type'='scheduled_callback' LIMIT 1;
   o.freeze_previous_waiting:=jsonb_build_object('waiting_on',o.waiting_on,'waiting_on_until',o.waiting_on_until);
  END IF;
  pendency:=jsonb_build_object('type','scheduled_callback','description','Retomar atendimento: '||trim(p_reason),'reason',trim(p_reason),'priority','normal','due_date',p_until,'due_time',NULL,'added_at',now(),'added_by_type','human','added_by_id',p_actor_id,'freeze_opportunity_id',o.id);
  SELECT coalesce(jsonb_agg(value),'[]'::jsonb) INTO items FROM jsonb_array_elements(t.consolidated_pendencies) WHERE value->>'type'<>'scheduled_callback';
  UPDATE public.tasks SET consolidated_pendencies=items||jsonb_build_array(pendency),conversation_id=coalesce(conversation_id,convo) WHERE id=t.id;
  PERFORM public.refresh_freeze_task(t.id);
  INSERT INTO public.task_events(task_id,organization_id,event_type,note,created_by_type,created_by_id)
  VALUES(t.id,p_organization_id,'rescheduled','Congelamento até '||p_until::text||': '||trim(p_reason),'human',p_actor_id);
  UPDATE public.opportunities SET frozen_until=p_until,frozen_at=now(),freeze_reason=trim(p_reason),freeze_task_id=t.id,
   freeze_previous_pendency=o.freeze_previous_pendency,freeze_previous_waiting=o.freeze_previous_waiting,
   waiting_on='scheduled_date',waiting_on_until=p_until
  WHERE id=o.id RETURNING * INTO o;
 END IF;
 INSERT INTO public.opportunity_events(organization_id,opportunity_id,event_type,previous_value,new_value,evidence,changed_by_type,changed_by_id)
 VALUES(p_organization_id,o.id,'waiting_on_changed',previous,jsonb_build_object('frozen_until',o.frozen_until,'freeze_reason',o.freeze_reason),trim(p_reason),'human',p_actor_id);
 RETURN to_jsonb(o);
END $$;
REVOKE ALL ON FUNCTION public.set_opportunity_freeze(uuid,uuid,uuid,date,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_opportunity_freeze(uuid,uuid,uuid,date,text) TO service_role;
-- Down (after exporting freeze dates/reasons): drop both functions, then
-- drop constraint opportunities_freeze_pair and the six added columns.
-- Tasks and events are retained.

-- Serialize automatic creation per contact; preserve closed businesses and
-- manual progress. Input evidence must reference actual scoped messages.
CREATE FUNCTION public.sync_sales_pipeline(p_organization_id uuid,p_conversation_id uuid,p_customer_message_id uuid,p_response_message_id uuid,p_operation text,p_stage text,p_explicit_operation boolean,p_fields jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.conversations; m public.messages; o public.opportunities; candidates integer; stages text[]; old_value jsonb;
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
 WHEN 'financing' THEN ARRAY['interest_received','qualification','documentation','bank_analysis','conditions_approved_negotiation','formalization']
 WHEN 'libera_cred' THEN ARRAY['interest_received','qualification','plan_term_presented','decision_objections','membership']
 WHEN 'contemplated_letter' THEN ARRAY['interest_received','qualification','compatible_letter_search','proposal_sent','analysis_transfer'] ELSE NULL END;
 IF stages IS NULL OR NOT (p_stage=ANY(stages)) THEN RAISE EXCEPTION 'Etapa inválida'; END IF;
 IF p_stage IN ('proposal_sent','simulation_sent','plan_term_presented') AND p_response_message_id IS NULL THEN RAISE EXCEPTION 'Falta evidência da apresentação'; END IF;
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
  old_value:=jsonb_build_object('operation',o.operation,'stage',o.stage);
  IF o.operation<>p_operation THEN
   IF NOT p_explicit_operation THEN RETURN o.id; END IF;
   UPDATE public.opportunities SET operation=p_operation,stage=stages[1],last_progress_at=now(),sale_amount=NULL,credit_amount=NULL,down_payment_amount=NULL,bid_amount=NULL,target_installment_amount=NULL,term_months=NULL WHERE id=o.id;
   INSERT INTO public.opportunity_events(organization_id,opportunity_id,event_type,previous_value,new_value,evidence,changed_by_type)
   VALUES(p_organization_id,o.id,'operation_changed',old_value,jsonb_build_object('operation',p_operation,'stage',stages[1]),'Interesse explícito: '||left(m.content,2000),'ai');
   o.stage:=stages[1];
  END IF;
  IF array_position(stages,p_stage)>array_position(stages,o.stage) THEN
   UPDATE public.opportunities SET stage=p_stage,last_progress_at=now() WHERE id=o.id;
   INSERT INTO public.opportunity_events(organization_id,opportunity_id,event_type,previous_value,new_value,evidence,changed_by_type)
   VALUES(p_organization_id,o.id,'stage_changed',jsonb_build_object('stage',o.stage),jsonb_build_object('stage',p_stage,'message_id',m.id,'response_message_id',p_response_message_id),'Evolução com evidência: '||left(m.content,2000),'ai');
  END IF;
  UPDATE public.opportunities SET last_interaction_at=greatest(last_interaction_at,m.created_at) WHERE id=o.id;
 END IF;
 UPDATE public.conversation_qualifications SET opportunity_id=o.id WHERE conversation_id=c.id AND organization_id=p_organization_id;
 -- Exactly one open business, including historical ambiguity checks above.
 WITH linked AS (UPDATE public.tasks SET opportunity_id=o.id WHERE organization_id=p_organization_id AND contact_id=c.contact_id AND opportunity_id IS NULL AND status IN('pending','in_progress','rescheduled') RETURNING id)
 INSERT INTO public.task_events(task_id,organization_id,event_type,note,created_by_type)
 SELECT id,p_organization_id,'opportunity_auto_linked','Vinculada ao negócio '||o.id::text,'ai' FROM linked;
 RETURN o.id;
END $$;
REVOKE ALL ON FUNCTION public.sync_sales_pipeline(uuid,uuid,uuid,uuid,text,text,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_sales_pipeline(uuid,uuid,uuid,uuid,text,text,boolean,jsonb) TO service_role;
