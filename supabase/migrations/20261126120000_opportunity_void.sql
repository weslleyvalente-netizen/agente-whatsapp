-- Negócio ANULADO (void): card que nunca foi uma oportunidade comercial válida (ex.: Cleber 18/11 e Rosival 21/11, criados por um
-- cadastro @lid duplicado para um atendimento de pós-venda). Decisão do dono 25/11: não marcar como perdido nem ganho.
--
-- Regras:
--   * só gestor (organization_members.role owner/admin) anula ou desfaz; motivo obrigatório (10+ caracteres);
--   * auditoria: eventos 'voided' / 'unvoided' com quem, quando, motivo e o estado anterior completo; nada é apagado;
--   * reversível: desfazer devolve exatamente o status, o motivo de perda e as datas anteriores;
--   * fora de todos os indicadores: status próprio ('void'), então não conta como aberto, ganho nem perdido, e as métricas que
--     usam o total de negócios (relatório de ligações, propostas, origem de anúncio) passam a excluí-lo;
--   * não é histórico comercial: _contact_has_deal_history e _open_opportunity_for_task ignoram negócio anulado;
--   * blindado: só as duas funções mudam o status de/para 'void' (gatilho), então nenhuma tela/rotina "ganha" ou "perde" um anulado.
--   * tarefas não mudam (as do vendedor continuam como estão); a anulação devolve quantas tarefas abertas apontam para o card.
--
-- Efeitos financeiros verificados antes (25/11, somente leitura): o banco não tem comissão, meta nem faturamento; os dois cards não
-- têm valor de venda nem de crédito; o "ganho" do Cleber não concluiu tarefas. O efeito é só nos indicadores (1 ganho a mais).
--
-- Reverter:
--   (antes, desfazer as anulações: SELECT public.unvoid_opportunity(id, <gestor>, 'reversão da migração') FROM public.opportunities WHERE status = 'void';)
--   DROP TRIGGER IF EXISTS trg_opportunity_void_guard ON public.opportunities; DROP FUNCTION IF EXISTS public._opportunity_void_guard();
--   DROP FUNCTION IF EXISTS public.void_opportunity(uuid, uuid, text), public.unvoid_opportunity(uuid, uuid, text);
--   restaurar as constraints de status/evento, _contact_has_deal_history e _open_opportunity_for_task (20261125120000);
--   ALTER TABLE public.opportunities DROP COLUMN IF EXISTS void_reason, DROP COLUMN IF EXISTS voided_at, DROP COLUMN IF EXISTS voided_by,
--     DROP COLUMN IF EXISTS void_previous;

ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS void_reason text, ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid, ADD COLUMN IF NOT EXISTS void_previous jsonb;

-- Status e tipo de evento: troca a CHECK existente (o nome varia entre ambientes) por uma que inclui o anulado.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.opportunities'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ~ 'status' AND pg_get_constraintdef(oid) ~ 'won' LOOP
    EXECUTE format('ALTER TABLE public.opportunities DROP CONSTRAINT %I', r.conname);
  END LOOP;
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.opportunity_events'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ~ 'event_type' AND pg_get_constraintdef(oid) ~ 'stage_changed' LOOP
    EXECUTE format('ALTER TABLE public.opportunity_events DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_status_check CHECK (status IN ('open', 'won', 'lost', 'void'));
ALTER TABLE public.opportunity_events ADD CONSTRAINT opportunity_events_event_type_check CHECK (event_type IN (
  'created', 'stage_changed', 'operation_changed', 'won', 'lost', 'reopened', 'owner_changed', 'next_action_updated', 'waiting_on_changed',
  'voided', 'unvoided'));

-- Só as funções abaixo entram ou saem de 'void' (marcador de transação local).
CREATE OR REPLACE FUNCTION public._opportunity_void_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (OLD.status = 'void' OR NEW.status = 'void') AND OLD.status IS DISTINCT FROM NEW.status
     AND coalesce(current_setting('app.opportunity_void_op', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Negócio anulado só muda pela anulação (gestor)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'void' AND NEW.status = 'void' AND coalesce(current_setting('app.opportunity_void_op', true), '') <> 'on'
     AND (NEW.stage, NEW.operation, NEW.owner_id) IS DISTINCT FROM (OLD.stage, OLD.operation, OLD.owner_id) THEN
    RAISE EXCEPTION 'Negócio anulado não pode ser alterado; desfaça a anulação primeiro' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_opportunity_void_guard ON public.opportunities;
CREATE TRIGGER trg_opportunity_void_guard BEFORE UPDATE OF status, stage, operation, owner_id ON public.opportunities
  FOR EACH ROW EXECUTE FUNCTION public._opportunity_void_guard();

CREATE OR REPLACE FUNCTION public._is_org_manager(p_org uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = p_org AND m.user_id = p_user AND m.role IN ('owner', 'admin'))
$$;
REVOKE ALL ON FUNCTION public._is_org_manager(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Anula. p_actor = gestor que pediu (a API confere a sessão; a função confere de novo o papel). Devolve o evento com o estado anterior
-- e quantas tarefas abertas apontam para o card (elas não mudam).
CREATE OR REPLACE FUNCTION public.void_opportunity(p_opportunity uuid, p_actor uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o public.opportunities; v_prev jsonb; v_tasks integer;
BEGIN
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN RAISE EXCEPTION 'Motivo obrigatório (mínimo 10 caracteres)' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO o FROM public.opportunities WHERE id = p_opportunity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Negócio não encontrado' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public._is_org_manager(o.organization_id, p_actor) THEN RAISE EXCEPTION 'Somente gestores' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF o.status = 'void' THEN RETURN jsonb_build_object('opportunity_id', o.id, 'already_void', true); END IF;
  v_prev := jsonb_build_object('status', o.status, 'lost_reason', o.lost_reason, 'resume_date', o.resume_date, 'stage', o.stage, 'owner_id', o.owner_id);
  SELECT count(*) INTO v_tasks FROM public.tasks t WHERE t.opportunity_id = o.id AND t.status IN ('pending', 'in_progress', 'rescheduled');
  PERFORM set_config('app.opportunity_void_op', 'on', true);
  UPDATE public.opportunities SET status = 'void', void_reason = btrim(p_reason), voided_at = now(), voided_by = p_actor, void_previous = v_prev WHERE id = o.id;
  PERFORM set_config('app.opportunity_void_op', 'off', true);
  INSERT INTO public.opportunity_events(organization_id, opportunity_id, event_type, previous_value, new_value, evidence, changed_by_type, changed_by_id)
  VALUES (o.organization_id, o.id, 'voided', v_prev, jsonb_build_object('status', 'void', 'void_reason', btrim(p_reason), 'open_tasks', v_tasks),
          'Negócio anulado pelo gestor: ' || btrim(p_reason), 'human', p_actor);
  RETURN jsonb_build_object('opportunity_id', o.id, 'previous', v_prev, 'open_tasks', v_tasks);
END $$;
REVOKE ALL ON FUNCTION public.void_opportunity(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_opportunity(uuid, uuid, text) TO service_role;

-- Desfaz: devolve exatamente o estado anterior (status, motivo de perda, data de retomada).
CREATE OR REPLACE FUNCTION public.unvoid_opportunity(p_opportunity uuid, p_actor uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o public.opportunities; v_status text;
BEGIN
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN RAISE EXCEPTION 'Motivo obrigatório (mínimo 10 caracteres)' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO o FROM public.opportunities WHERE id = p_opportunity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Negócio não encontrado' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public._is_org_manager(o.organization_id, p_actor) THEN RAISE EXCEPTION 'Somente gestores' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF o.status <> 'void' THEN RETURN jsonb_build_object('opportunity_id', o.id, 'not_void', true); END IF;
  v_status := coalesce(o.void_previous->>'status', 'open');
  PERFORM set_config('app.opportunity_void_op', 'on', true);
  UPDATE public.opportunities SET status = v_status, lost_reason = o.void_previous->>'lost_reason', resume_date = (o.void_previous->>'resume_date')::date,
         void_reason = NULL, voided_at = NULL, voided_by = NULL, void_previous = NULL WHERE id = o.id;
  PERFORM set_config('app.opportunity_void_op', 'off', true);
  INSERT INTO public.opportunity_events(organization_id, opportunity_id, event_type, previous_value, new_value, evidence, changed_by_type, changed_by_id)
  VALUES (o.organization_id, o.id, 'unvoided', jsonb_build_object('status', 'void', 'void_reason', o.void_reason, 'voided_at', o.voided_at, 'voided_by', o.voided_by),
          o.void_previous, 'Anulação desfeita pelo gestor: ' || btrim(p_reason), 'human', p_actor);
  RETURN jsonb_build_object('opportunity_id', o.id, 'restored', o.void_previous);
END $$;
REVOKE ALL ON FUNCTION public.unvoid_opportunity(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unvoid_opportunity(uuid, uuid, text) TO service_role;

-- Desfazer a anulação de um negócio que era GANHO não pode concluir de novo as tarefas do contato (o ganho original já fez isso).
CREATE OR REPLACE FUNCTION public.won_closes_open_tasks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'won' AND OLD.status IS DISTINCT FROM 'won' AND OLD.status IS DISTINCT FROM 'void' THEN
    PERFORM public._complete_tasks_of_won_opportunity(NEW.id, clock_timestamp());
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.won_closes_open_tasks() FROM PUBLIC, anon, authenticated;

-- Origem de anúncio por negócio (relatórios): anulado fica de fora.
CREATE OR REPLACE VIEW public.opportunity_ad_origins WITH (security_invoker = true) AS
SELECT o.id AS opportunity_id, o.organization_id, o.contact_id,
       t.id AS touch_id, COALESCE(t.basis, 'indeterminate') AS basis,
       t.touched_at, t.platform, t.source_type, t.ad_id, t.ad_title, t.ad_body, t.ad_url, t.campaign_id, t.campaign_name
FROM public.opportunities o
LEFT JOIN LATERAL (
  SELECT x.*, CASE WHEN x.linked THEN 'conversation' ELSE 'estimated' END AS basis
  FROM (
    SELECT t.*, (t.conversation_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM public.lead_assignments la
             WHERE la.organization_id = o.organization_id AND la.opportunity_id = o.id AND la.conversation_id = t.conversation_id
           )) AS linked
    FROM public.lead_ad_touches t
    WHERE t.organization_id = o.organization_id AND t.contact_id = o.contact_id
      AND t.touched_at <= o.created_at + interval '1 minute'
  ) x
  WHERE x.linked OR x.touched_at >= o.created_at - interval '14 days'
  ORDER BY x.linked DESC, x.touched_at DESC
  LIMIT 1
) t ON true
WHERE o.status <> 'void';

-- Histórico comercial: negócio anulado nunca conta (não bloqueia card novo nem vira "cliente que volta").
CREATE OR REPLACE FUNCTION public._contact_has_deal_history(p_org uuid, p_contact uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.opportunities o
     WHERE o.organization_id = p_org AND o.contact_id = ANY (public._contact_identity_ids(p_org, p_contact)) AND o.status <> 'void'
       AND NOT (o.status = 'lost' AND o.operation_is_default
                AND NOT EXISTS (SELECT 1 FROM public.opportunity_events e WHERE e.opportunity_id = o.id AND e.changed_by_type = 'human' AND e.event_type <> 'lost'))
  )
$$;
REVOKE ALL ON FUNCTION public._contact_has_deal_history(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._contact_has_deal_history(uuid, uuid) TO service_role;

-- Tarefa humana abre negócio (corpo de 20261125120000): negócio anulado não conta como "contato com negócio".
CREATE OR REPLACE FUNCTION public._open_opportunity_for_task(p_task_id uuid, p_source text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.tasks; v_operation text; v_owner uuid; v_opp uuid;
BEGIN
  SELECT * INTO t FROM public.tasks WHERE id = p_task_id;
  IF NOT FOUND OR t.assignee_type IS DISTINCT FROM 'human' OR t.status NOT IN ('pending', 'in_progress', 'rescheduled') OR t.opportunity_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  v_operation := public._task_type_operation(t.type);
  IF v_operation IS NULL THEN RETURN NULL; END IF;
  IF (SELECT count(DISTINCT public._task_type_operation(x.type)) FROM public.tasks x
       WHERE x.organization_id = t.organization_id AND x.contact_id = t.contact_id AND x.assignee_type = 'human'
         AND x.status IN ('pending', 'in_progress', 'rescheduled') AND public._task_type_operation(x.type) IS NOT NULL) > 1 THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = t.organization_id AND settings->'sales_auto_pipeline_enabled' = 'true'::jsonb) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.opportunities WHERE organization_id = t.organization_id AND contact_id = ANY (public._contact_identity_ids(t.organization_id, t.contact_id)) AND status <> 'void') THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_ignored_contacts i JOIN public.wa_contacts w ON w.organization_id = i.organization_id AND w.phone = i.phone
              WHERE w.id = t.contact_id AND w.organization_id = t.organization_id) THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM public.wa_contacts WHERE id = t.contact_id AND organization_id = t.organization_id FOR NO KEY UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.opportunities WHERE organization_id = t.organization_id AND contact_id = ANY (public._contact_identity_ids(t.organization_id, t.contact_id)) AND status <> 'void') THEN
    RETURN NULL;
  END IF;

  SELECT c.assigned_to INTO v_owner
    FROM public.conversations c
   WHERE c.organization_id = t.organization_id AND c.contact_id = t.contact_id AND c.assigned_to IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = c.organization_id AND r.user_id = c.assigned_to)
   ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
   LIMIT 1;
  IF v_owner IS NULL AND t.assignee_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = t.organization_id AND r.user_id = t.assignee_id) THEN
    v_owner := t.assignee_id;
  END IF;

  INSERT INTO public.opportunities(organization_id, contact_id, operation, initial_operation, stage, status, owner_id, owner_assigned_at, last_progress_at)
  VALUES (t.organization_id, t.contact_id, v_operation, v_operation, 'interest_received', 'open', v_owner, CASE WHEN v_owner IS NOT NULL THEN now() END, now())
  RETURNING id INTO v_opp;

  INSERT INTO public.opportunity_events(organization_id, opportunity_id, event_type, new_value, evidence, changed_by_type)
  VALUES (t.organization_id, v_opp, 'created',
          jsonb_build_object('operation', v_operation, 'stage', 'interest_received', 'task_id', t.id, 'source', p_source),
          'Negócio criado porque o vendedor recebeu uma tarefa sem negócio', 'system');

  WITH linked AS (
    UPDATE public.tasks SET opportunity_id = v_opp
     WHERE id IN (SELECT x.id FROM public.tasks x
                   WHERE x.organization_id = t.organization_id AND x.contact_id = t.contact_id AND x.opportunity_id IS NULL
                     AND x.status IN ('pending', 'in_progress', 'rescheduled')
                   FOR UPDATE SKIP LOCKED)
    RETURNING id)
  INSERT INTO public.task_events(task_id, organization_id, event_type, note, created_by_type)
  SELECT id, t.organization_id, 'opportunity_auto_linked', 'Vinculada ao negócio ' || v_opp::text, 'ai' FROM linked;
  RETURN v_opp;
END $$;
REVOKE ALL ON FUNCTION public._open_opportunity_for_task(uuid, text) FROM PUBLIC, anon, authenticated;

