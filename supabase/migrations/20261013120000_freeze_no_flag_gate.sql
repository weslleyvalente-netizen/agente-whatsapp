-- Remove a trava que recusava o congelamento quando settings.sales_opportunity_freeze_enabled não estava ligado.
-- O botão Congelar agora é sempre exibido; o restante da função é idêntico ao original (20261001194818).
CREATE OR REPLACE FUNCTION public.set_opportunity_freeze(p_organization_id uuid,p_opportunity_id uuid,p_actor_id uuid,p_until date,p_reason text)
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
