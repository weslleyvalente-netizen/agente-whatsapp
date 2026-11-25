-- Cliente que volta (card novo por intenção comercial) + encerramento automático sem resposta.
-- Spec: docs/superpowers/specs/2026-11-24-encerramento-sem-resposta-design.md
--
-- O que muda já no deploy (sem flag):
--   * identidade do contato: telefone (com/sem 55 e nono dígito) e vínculo @lid (metadata.lid / merged_into) formam um grupo;
--     _contact_has_deal_history e _open_opportunity_for_task passam a olhar o GRUPO. Efeito: um cadastro @lid duplicado de cliente
--     com histórico não ganha mais card automático (casos Cleber 18/11 e Rosival 21/11). Só BLOQUEIA mais; nunca cria.
-- O que fica atrás de flag (todas desligadas por padrão):
--   * returning_customer_card_enabled + returning_customer_card_mode ('shadow' | 'write'): decisões gravadas em
--     returning_customer_decisions; em 'write', open_returning_customer_opportunity cria o card.
--   * no_reply_closure_enabled: candidatos e aplicação do encerramento (perdido 'sem_resposta' só depois do envio confirmado).
--
-- Reverter:
--   DROP FUNCTION IF EXISTS public.apply_no_reply_closure(uuid), public.no_reply_closure_candidates(uuid, timestamptz, integer, integer, uuid),
--     public.open_returning_customer_opportunity(uuid, jsonb), public.returning_customer_context(uuid, uuid), public._contact_identity_ids(uuid, uuid);
--   DROP TABLE IF EXISTS public.returning_customer_decisions;
--   recriar _contact_has_deal_history (20261027120000) e _open_opportunity_for_task (20261021120000);
--   DROP INDEX IF EXISTS public.wa_contacts_br_phone_key; DROP FUNCTION IF EXISTS public._br_phone_key(text);
--   ALTER TABLE public.opportunities DROP COLUMN IF EXISTS previous_opportunity_id;

ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS previous_opportunity_id uuid REFERENCES public.opportunities(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Identidade
-- ---------------------------------------------------------------------------------------------------------------------------

-- Chave de telefone brasileiro: só dígitos, sem 55, sem o nono dígito de celular. NULL para @lid, grupos e números curtos.
CREATE OR REPLACE FUNCTION public._br_phone_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL OR p LIKE '%@lid%' OR p LIKE '%@g.us%' THEN NULL ELSE (
    SELECT CASE WHEN length(d2) < 10 THEN NULL
                WHEN length(d2) = 11 AND substr(d2, 3, 1) = '9' THEN substr(d2, 1, 2) || substr(d2, 4)
                ELSE d2 END
      FROM (SELECT CASE WHEN length(d) >= 12 AND left(d, 2) = '55' THEN substr(d, 3) ELSE d END AS d2
              FROM (SELECT regexp_replace(split_part(split_part(p, '@', 1), '#', 1), '\D', '', 'g') AS d) a) b) END
$$;
CREATE INDEX IF NOT EXISTS wa_contacts_br_phone_key ON public.wa_contacts (organization_id, public._br_phone_key(phone));

-- Grupo de identidade de um contato: ele mesmo, mesmo telefone (variações), @lid apontado por metadata.lid, contato real de um
-- @lid (metadata.lid = phone do @lid) e unificações (merged_into, nos dois sentidos). @lid nunca resolvido fica sozinho.
CREATE OR REPLACE FUNCTION public._contact_identity_ids(p_org uuid, p_contact uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH c AS (SELECT id, phone, metadata, public._br_phone_key(phone) AS k FROM public.wa_contacts WHERE organization_id = p_org AND id = p_contact)
  SELECT coalesce(array_agg(DISTINCT w.id), ARRAY[p_contact])
    FROM c, public.wa_contacts w
   WHERE w.organization_id = p_org AND (
         w.id = c.id
      OR (c.k IS NOT NULL AND public._br_phone_key(w.phone) = c.k)
      OR (c.metadata->>'lid' IS NOT NULL AND w.phone = c.metadata->>'lid')
      OR (c.phone LIKE '%@lid' AND w.metadata->>'lid' = c.phone)
      OR w.id::text = c.metadata->>'merged_into'
      OR w.metadata->>'merged_into' = c.id::text)
$$;
REVOKE ALL ON FUNCTION public._contact_identity_ids(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._contact_identity_ids(uuid, uuid) TO service_role;

-- Histórico de negócio agora pelo grupo de identidade (corpo de 20261027120000, só a condição de contato muda).
CREATE OR REPLACE FUNCTION public._contact_has_deal_history(p_org uuid, p_contact uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.opportunities o
     WHERE o.organization_id = p_org AND o.contact_id = ANY (public._contact_identity_ids(p_org, p_contact))
       AND NOT (o.status = 'lost' AND o.operation_is_default
                AND NOT EXISTS (SELECT 1 FROM public.opportunity_events e WHERE e.opportunity_id = o.id AND e.changed_by_type = 'human' AND e.event_type <> 'lost'))
  )
$$;
REVOKE ALL ON FUNCTION public._contact_has_deal_history(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._contact_has_deal_history(uuid, uuid) TO service_role;

-- Tarefa humana abre negócio: corpo de 20261021120000; as duas checagens "contato sem negócio" passam a olhar o grupo.
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
  IF EXISTS (SELECT 1 FROM public.opportunities WHERE organization_id = t.organization_id AND contact_id = ANY (public._contact_identity_ids(t.organization_id, t.contact_id))) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_ignored_contacts i JOIN public.wa_contacts w ON w.organization_id = i.organization_id AND w.phone = i.phone
              WHERE w.id = t.contact_id AND w.organization_id = t.organization_id) THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM public.wa_contacts WHERE id = t.contact_id AND organization_id = t.organization_id FOR NO KEY UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.opportunities WHERE organization_id = t.organization_id AND contact_id = ANY (public._contact_identity_ids(t.organization_id, t.contact_id))) THEN
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

-- ---------------------------------------------------------------------------------------------------------------------------
-- Cliente que volta
-- ---------------------------------------------------------------------------------------------------------------------------

-- Uma linha por gatilho (encaminhamento ou tarefa): idempotência e fila de revisão humana (intent = 'unclear').
CREATE TABLE IF NOT EXISTS public.returning_customer_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.wa_contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('handoff', 'task')),
  trigger_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow', 'write')),
  intent text NOT NULL CHECK (intent IN ('commercial', 'administrative', 'unclear')),
  identity_status text NOT NULL CHECK (identity_status IN ('resolved', 'unresolved_lid')),
  operation text CHECK (operation IS NULL OR operation IN ('vehicle_sale', 'consortium', 'financing', 'libera_cred', 'contemplated_letter')),
  stage text,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_opportunity_id uuid REFERENCES public.opportunities(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('would_create', 'created', 'needs_review', 'skipped_not_commercial', 'skipped_open_compatible', 'skipped_no_history')),
  opportunity_id uuid REFERENCES public.opportunities(id) ON DELETE SET NULL,
  review_task_id uuid,
  reviewed_at timestamptz,
  reviewed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, trigger_kind, trigger_id)
);
CREATE INDEX IF NOT EXISTS returning_customer_decisions_contact ON public.returning_customer_decisions (organization_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS returning_customer_decisions_review ON public.returning_customer_decisions (organization_id, created_at DESC) WHERE outcome = 'needs_review' AND reviewed_at IS NULL;
ALTER TABLE public.returning_customer_decisions ENABLE ROW LEVEL SECURITY;

-- Contexto para a decisão (somente leitura): grupo de identidade, negócios abertos do grupo e o último fechado.
CREATE OR REPLACE FUNCTION public.returning_customer_context(p_org uuid, p_contact uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ids AS (SELECT public._contact_identity_ids(p_org, p_contact) AS a),
  closed AS (
    SELECT o.*, coalesce((SELECT max(e.created_at) FROM public.opportunity_events e WHERE e.opportunity_id = o.id AND e.event_type IN ('won', 'lost')), o.updated_at) AS closed_at
      FROM public.opportunities o, ids WHERE o.organization_id = p_org AND o.contact_id = ANY (ids.a) AND o.status IN ('won', 'lost'))
  SELECT jsonb_build_object(
    'identity_ids', (SELECT to_jsonb(a) FROM ids),
    'identity_status', CASE WHEN EXISTS (SELECT 1 FROM public.wa_contacts w WHERE w.id = p_contact AND w.phone LIKE '%@lid')
                              AND (SELECT cardinality(a) FROM ids) = 1 THEN 'unresolved_lid' ELSE 'resolved' END,
    'open', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'operation', o.operation, 'operation_is_default', coalesce(o.operation_is_default, false)))
                        FROM public.opportunities o, ids WHERE o.organization_id = p_org AND o.contact_id = ANY (ids.a) AND o.status = 'open'), '[]'::jsonb),
    'previous', (SELECT jsonb_build_object('id', c.id, 'status', c.status, 'lost_reason', c.lost_reason, 'operation', c.operation, 'stage', c.stage,
                                           'owner_id', c.owner_id, 'closed_at', c.closed_at,
                                           'owner_active', EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = p_org AND r.user_id = c.owner_id AND r.availability <> 'out'))
                   FROM closed c ORDER BY c.closed_at DESC, c.id LIMIT 1))
$$;
REVOKE ALL ON FUNCTION public.returning_customer_context(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.returning_customer_context(uuid, uuid) TO service_role;

-- Cria o card a partir de uma decisão 'would_create' em modo 'write'. Idempotente (2ª chamada devolve o mesmo id), trava o grupo de
-- identidade inteiro (ordem fixa: sem deadlock entre eventos simultâneos) e reconfere "negócio aberto compatível" depois da trava.
-- Compatível = mesma operação ou card com operação ainda a confirmar. Operação diferente (outro produto) pode coexistir.
CREATE OR REPLACE FUNCTION public.open_returning_customer_opportunity(p_decision uuid, p_origin jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.returning_customer_decisions; ids uuid[]; prev public.opportunities; v_owner uuid; v_rule text; v_opp uuid; v_origin jsonb;
BEGIN
  SELECT * INTO d FROM public.returning_customer_decisions WHERE id = p_decision FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF d.outcome = 'created' THEN RETURN d.opportunity_id; END IF;
  IF d.outcome <> 'would_create' OR d.mode <> 'write' OR d.intent <> 'commercial' OR d.operation IS NULL OR d.stage IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = d.organization_id
                  AND settings->'returning_customer_card_enabled' = 'true'::jsonb AND settings->>'returning_customer_card_mode' = 'write') THEN
    RETURN NULL;
  END IF;

  ids := public._contact_identity_ids(d.organization_id, d.contact_id);
  PERFORM 1 FROM public.wa_contacts WHERE organization_id = d.organization_id AND id = ANY (ids) ORDER BY id FOR NO KEY UPDATE;
  ids := public._contact_identity_ids(d.organization_id, d.contact_id);

  IF EXISTS (SELECT 1 FROM public.opportunities o WHERE o.organization_id = d.organization_id AND o.contact_id = ANY (ids) AND o.status = 'open'
              AND (o.operation = d.operation OR coalesce(o.operation_is_default, false))) THEN
    UPDATE public.returning_customer_decisions SET outcome = 'skipped_open_compatible' WHERE id = d.id;
    RETURN NULL;
  END IF;

  SELECT * INTO prev FROM public.opportunities WHERE id = d.previous_opportunity_id AND organization_id = d.organization_id;
  IF prev.id IS NULL OR prev.status NOT IN ('won', 'lost') THEN
    UPDATE public.returning_customer_decisions SET outcome = 'skipped_no_history' WHERE id = d.id;
    RETURN NULL;
  END IF;

  -- Dono: vendedor do negócio anterior se ativo; senão o vendedor que o rodízio já entregou (atribuição ativa da conversa);
  -- senão o vendedor da conversa; senão vazio (o gatilho trg_owner_on_opportunity_open ainda tenta pela conversa).
  IF EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = d.organization_id AND r.user_id = prev.owner_id AND r.availability <> 'out') THEN
    v_owner := prev.owner_id; v_rule := 'previous_owner';
  END IF;
  IF v_owner IS NULL AND d.conversation_id IS NOT NULL THEN
    SELECT r.user_id INTO v_owner FROM public.lead_assignments a JOIN public.sales_reps r ON r.id = a.rep_id
     WHERE a.organization_id = d.organization_id AND a.conversation_id = d.conversation_id AND a.status IN ('pending', 'accepted') AND r.availability <> 'out'
     ORDER BY a.assigned_at DESC LIMIT 1;
    IF v_owner IS NOT NULL THEN v_rule := 'rotation_assignment'; END IF;
  END IF;
  IF v_owner IS NULL AND d.conversation_id IS NOT NULL THEN
    SELECT c.assigned_to INTO v_owner FROM public.conversations c JOIN public.sales_reps r ON r.organization_id = c.organization_id AND r.user_id = c.assigned_to
     WHERE c.id = d.conversation_id AND r.availability <> 'out';
    IF v_owner IS NOT NULL THEN v_rule := 'conversation_owner'; END IF;
  END IF;

  SELECT coalesce(w.metadata->'lead_origin', 'null'::jsonb) INTO v_origin FROM public.wa_contacts w WHERE w.id = d.contact_id;

  INSERT INTO public.opportunities(organization_id, contact_id, operation, initial_operation, stage, status, owner_id, owner_assigned_at,
                                   last_progress_at, last_interaction_at, previous_opportunity_id, operation_is_default)
  VALUES (d.organization_id, d.contact_id, d.operation, d.operation, d.stage, 'open', v_owner, CASE WHEN v_owner IS NOT NULL THEN now() END,
          now(), (SELECT max(m.created_at) FROM public.messages m WHERE m.conversation_id = d.conversation_id AND m.role = 'contact'), prev.id, false)
  RETURNING id INTO v_opp;

  INSERT INTO public.opportunity_events(organization_id, opportunity_id, event_type, new_value, evidence, changed_by_type)
  VALUES (d.organization_id, v_opp, 'created',
          jsonb_build_object('operation', d.operation, 'stage', d.stage, 'source', 'returning_customer', 'decision_id', d.id,
                             'trigger_kind', d.trigger_kind, 'trigger_id', d.trigger_id, 'conversation_id', d.conversation_id,
                             'intent', d.intent, 'previous_opportunity_id', prev.id, 'previous_status', prev.status, 'previous_lost_reason', prev.lost_reason,
                             'owner_rule', coalesce(v_rule, 'none'), 'lead_origin', v_origin, 'ad_touch', p_origin),
          'Negócio criado: cliente voltou com intenção comercial. ' || left(d.reason, 800), 'ai');

  -- Tarefas comerciais abertas do grupo, sem negócio, passam a apontar para o card. Tarefas administrativas ficam como estão.
  WITH linked AS (
    UPDATE public.tasks SET opportunity_id = v_opp
     WHERE id IN (SELECT x.id FROM public.tasks x
                   WHERE x.organization_id = d.organization_id AND x.contact_id = ANY (ids) AND x.opportunity_id IS NULL
                     AND x.status IN ('pending', 'in_progress', 'rescheduled')
                     AND (public._task_type_operation(x.type) = d.operation OR x.type IN ('return_customer', 'proposal_followup', 'run_quote', 'customer_unresponsive'))
                   FOR UPDATE SKIP LOCKED)
    RETURNING id)
  INSERT INTO public.task_events(task_id, organization_id, event_type, note, created_by_type)
  SELECT id, d.organization_id, 'opportunity_auto_linked', 'Vinculada ao negócio ' || v_opp::text || ' (cliente voltou)', 'ai' FROM linked;

  UPDATE public.returning_customer_decisions SET outcome = 'created', opportunity_id = v_opp WHERE id = d.id;
  RETURN v_opp;
END $$;
REVOKE ALL ON FUNCTION public.open_returning_customer_opportunity(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_returning_customer_opportunity(uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Encerramento automático sem resposta
-- ---------------------------------------------------------------------------------------------------------------------------

-- Despedida já enviada depois da última mensagem do cliente (qualquer rotina, ou a mandada à mão com "encerr").
CREATE OR REPLACE FUNCTION public._is_farewell_message(p_role text, p_content text, p_metadata jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_role IN ('agent', 'human_agent') AND (
    coalesce(p_metadata, '{}'::jsonb) ? 'no_reply_closure'
    OR coalesce(p_metadata, '{}'::jsonb) ? 'scheduled_ad_closure'
    OR p_metadata->'low_intent_followup'->>'stage' = '3'
    OR coalesce(p_content, '') ~* '(vou|vamos) encerrar')
$$;

-- Conversas elegíveis (somente leitura). p_conversation restringe a uma conversa (reconferência sob trava).
CREATE OR REPLACE FUNCTION public.no_reply_closure_candidates(p_org uuid, p_now timestamptz, p_wait_hours integer, p_limit integer, p_conversation uuid DEFAULT NULL)
RETURNS TABLE (conversation_id uuid, contact_id uuid, instance_id uuid, phone text, followup_days integer, last_outbound_at timestamptz, anchor timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH conv AS (
    SELECT c.* FROM public.conversations c
     WHERE c.organization_id = p_org AND (p_conversation IS NULL OR c.id = p_conversation)
       AND c.last_message_at <= p_now - make_interval(hours => p_wait_hours) AND c.last_message_at > p_now - interval '60 days'),
  a AS (
    SELECT c.id, c.contact_id, c.evolution_instance_id,
           coalesce((SELECT max(m.created_at) FROM public.messages m WHERE m.conversation_id = c.id AND m.role = 'contact'), c.created_at) AS anchor
      FROM conv c),
  s AS (
    SELECT a.*, w.phone,
      (SELECT count(DISTINCT (m.created_at AT TIME ZONE 'America/Sao_Paulo')::date) FROM public.messages m
        WHERE m.conversation_id = a.id AND m.role IN ('agent', 'human_agent') AND m.created_at >= a.anchor AND NOT (coalesce(m.metadata, '{}'::jsonb) ? 'send_failed_at')) AS days,
      (SELECT max(m.created_at) FROM public.messages m WHERE m.conversation_id = a.id AND m.role IN ('agent', 'human_agent') AND m.created_at >= a.anchor) AS last_out,
      (SELECT m.role FROM public.messages m WHERE m.conversation_id = a.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_role
      FROM a JOIN public.wa_contacts w ON w.id = a.contact_id AND w.organization_id = p_org
     WHERE a.evolution_instance_id IS NOT NULL AND w.phone IS NOT NULL AND w.phone NOT LIKE '%@g.us%'
       AND NOT coalesce(w.ai_disabled, false)
       AND NOT EXISTS (SELECT 1 FROM public.organization_ignored_contacts i WHERE i.organization_id = p_org AND i.phone = w.phone))
  SELECT s.id, s.contact_id, s.evolution_instance_id, s.phone, s.days::integer, s.last_out, s.anchor
    FROM s
   WHERE s.last_role IN ('agent', 'human_agent') AND s.days >= 4 AND s.last_out <= p_now - make_interval(hours => p_wait_hours)
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = s.id AND m.created_at >= s.anchor AND public._is_farewell_message(m.role, m.content, m.metadata))
     AND NOT EXISTS (SELECT 1 FROM public.opportunities o WHERE o.organization_id = p_org AND o.contact_id = s.contact_id AND o.status = 'open'
                      AND (o.stage NOT IN ('interest_received', 'qualification') OR coalesce(o.sale_amount, 0) > 0 OR coalesce(o.credit_amount, 0) > 0
                           OR (o.frozen_until IS NOT NULL)))
     AND NOT EXISTS (SELECT 1 FROM public.proposal_followups f WHERE f.organization_id = p_org AND f.conversation_id = s.id AND f.sent_at >= s.anchor)
     AND NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.organization_id = p_org AND t.conversation_id = s.id AND t.status IN ('pending', 'in_progress', 'rescheduled')
                      AND t.due_date > (p_now AT TIME ZONE 'America/Sao_Paulo')::date)
   ORDER BY s.last_out
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION public.no_reply_closure_candidates(uuid, timestamptz, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.no_reply_closure_candidates(uuid, timestamptz, integer, integer, uuid) TO service_role;

-- Depois do envio CONFIRMADO da despedida (desta rotina ou da cadência de baixa intenção): marca perdido 'sem_resposta' os negócios
-- abertos do contato que passam no filtro e cancela as tarefas automáticas de "cliente parou de responder". Idempotente
-- (metadata.closure_applied_at). Cliente que respondeu depois da despedida: nada muda. Devolve quantos negócios foram marcados.
CREATE OR REPLACE FUNCTION public.apply_no_reply_closure(p_message uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m public.messages; c public.conversations; n integer := 0; v_days integer; v_last text; o record;
BEGIN
  SELECT * INTO m FROM public.messages WHERE id = p_message FOR UPDATE;
  IF NOT FOUND OR m.evolution_message_id IS NULL OR coalesce(m.metadata, '{}'::jsonb) ? 'closure_applied_at' THEN RETURN 0; END IF;
  IF NOT (coalesce(m.metadata, '{}'::jsonb) ? 'no_reply_closure' OR m.metadata->'low_intent_followup'->>'stage' = '3') THEN RETURN 0; END IF;
  -- Só despedidas a partir do início configurado: ligar a flag nunca aplica em massa as despedidas antigas da cadência (desde 20/10).
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = m.organization_id AND settings->'no_reply_closure_enabled' = 'true'::jsonb
                  AND settings->>'no_reply_closure_started_at' IS NOT NULL AND m.created_at >= (settings->>'no_reply_closure_started_at')::timestamptz) THEN RETURN 0; END IF;
  SELECT * INTO c FROM public.conversations WHERE id = m.conversation_id;

  IF NOT EXISTS (SELECT 1 FROM public.messages x WHERE x.conversation_id = m.conversation_id AND x.role = 'contact' AND x.created_at > m.created_at) THEN
    PERFORM 1 FROM public.wa_contacts WHERE id = c.contact_id FOR NO KEY UPDATE;
    v_days := coalesce((m.metadata->'no_reply_closure'->>'followup_days')::integer,
                       (SELECT count(DISTINCT (x.created_at AT TIME ZONE 'America/Sao_Paulo')::date) FROM public.messages x
                         WHERE x.conversation_id = m.conversation_id AND x.role IN ('agent', 'human_agent') AND x.id <> m.id
                           AND x.created_at >= coalesce((SELECT max(y.created_at) FROM public.messages y WHERE y.conversation_id = m.conversation_id AND y.role = 'contact'), c.created_at))::integer);
    v_last := to_char((SELECT max(x.created_at) FROM public.messages x WHERE x.conversation_id = m.conversation_id AND x.role IN ('agent', 'human_agent') AND x.id <> m.id)
                      AT TIME ZONE 'America/Sao_Paulo', 'DD/MM');
    FOR o IN SELECT * FROM public.opportunities WHERE organization_id = m.organization_id AND contact_id = c.contact_id AND status = 'open'
               AND stage IN ('interest_received', 'qualification') AND coalesce(sale_amount, 0) = 0 AND coalesce(credit_amount, 0) = 0 AND frozen_until IS NULL
             FOR UPDATE LOOP
      UPDATE public.opportunities SET status = 'lost', lost_reason = 'sem_resposta', resume_date = NULL, last_progress_at = now() WHERE id = o.id;
      INSERT INTO public.opportunity_events(organization_id, opportunity_id, event_type, previous_value, new_value, evidence, changed_by_type)
      VALUES (m.organization_id, o.id, 'lost', jsonb_build_object('status', o.status),
              jsonb_build_object('status', 'lost', 'lost_reason', 'sem_resposta', 'resume_date', NULL, 'source', 'no_reply_closure', 'message_id', m.id),
              'Encerramento automático: ' || greatest(v_days - 1, 0) || ' follow-ups sem resposta (último em ' || coalesce(v_last, '-') || ')', 'ai');
      n := n + 1;
    END LOOP;
    WITH cancelled AS (
      UPDATE public.tasks SET status = 'cancelled'
       WHERE organization_id = m.organization_id AND conversation_id = m.conversation_id AND type = 'customer_unresponsive'
         AND created_by_type = 'ai' AND status IN ('pending', 'in_progress', 'rescheduled')
      RETURNING id)
    INSERT INTO public.task_events(task_id, organization_id, event_type, note, created_by_type)
    SELECT id, m.organization_id, 'cancelled', 'Encerramento automático enviado (mensagem ' || m.id::text || ')', 'ai' FROM cancelled;
  END IF;
  UPDATE public.messages SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('closure_applied_at', now(), 'closure_lost_count', n) WHERE id = m.id;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.apply_no_reply_closure(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_no_reply_closure(uuid) TO service_role;
