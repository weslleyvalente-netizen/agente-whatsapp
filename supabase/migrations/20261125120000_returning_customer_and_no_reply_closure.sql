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
--     public.open_returning_customer_opportunity(uuid, jsonb), public.returning_customer_context(uuid, uuid), public._contact_identity_ids(uuid, uuid),
--     public.returning_customer_triggers(uuid, timestamptz, text[], integer), public.returning_customer_pending_decisions(uuid, integer),
--     public.returning_customer_mark_attempt(uuid, text), public.returning_customer_owner(uuid);
--   DROP INDEX IF EXISTS public.wa_contacts_metadata_lid, public.wa_contacts_metadata_merged_into;
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

-- Vínculos @lid e unificação: índices parciais (poucas linhas) para a busca no sentido inverso.
CREATE INDEX IF NOT EXISTS wa_contacts_metadata_lid ON public.wa_contacts (organization_id, (metadata->>'lid')) WHERE metadata ? 'lid';
CREATE INDEX IF NOT EXISTS wa_contacts_metadata_merged_into ON public.wa_contacts (organization_id, (metadata->>'merged_into')) WHERE metadata ? 'merged_into';

-- Grupo de identidade de um contato (fecho transitivo, revisão 25/11): ele mesmo, mesmo telefone (variações), @lid apontado por
-- metadata.lid, contato real de um @lid (metadata.lid = phone do @lid) e unificações (merged_into, nos dois sentidos), repetido até
-- não aparecer cadastro novo. Assim o grupo é o mesmo partindo de qualquer cadastro, inclusive em unificações indiretas.
-- @lid nunca resolvido fica sozinho. Limite de 6 saltos (grupos reais têm 2-4 cadastros).
CREATE OR REPLACE FUNCTION public._contact_identity_ids(p_org uuid, p_contact uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- Cada vínculo é uma busca indexada separada (chave de telefone, phone, metadata.lid, merged_into, id): sem varredura da tabela.
  WITH RECURSIVE g(id, phone, metadata, k, depth) AS (
    SELECT w.id, w.phone, w.metadata, public._br_phone_key(w.phone), 0 FROM public.wa_contacts w WHERE w.organization_id = p_org AND w.id = p_contact
    UNION
    SELECT n.id, n.phone, n.metadata, public._br_phone_key(n.phone), g.depth + 1
      FROM g CROSS JOIN LATERAL (
        SELECT w.id, w.phone, w.metadata FROM public.wa_contacts w
         WHERE g.k IS NOT NULL AND w.organization_id = p_org AND public._br_phone_key(w.phone) = g.k
        UNION
        SELECT w.id, w.phone, w.metadata FROM public.wa_contacts w
         WHERE g.metadata->>'lid' IS NOT NULL AND w.organization_id = p_org AND w.phone = g.metadata->>'lid'
        UNION
        SELECT w.id, w.phone, w.metadata FROM public.wa_contacts w
         WHERE g.phone LIKE '%@lid' AND w.organization_id = p_org AND w.metadata ? 'lid' AND w.metadata->>'lid' = g.phone
        UNION
        SELECT w.id, w.phone, w.metadata FROM public.wa_contacts w
         WHERE g.metadata->>'merged_into' ~ '^[0-9a-f-]{36}$' AND w.id = (g.metadata->>'merged_into')::uuid AND w.organization_id = p_org
        UNION
        SELECT w.id, w.phone, w.metadata FROM public.wa_contacts w
         WHERE w.organization_id = p_org AND w.metadata ? 'merged_into' AND w.metadata->>'merged_into' = g.id::text) n
     WHERE n.id <> g.id AND g.depth < 6)
  SELECT coalesce((SELECT array_agg(DISTINCT id) FROM g), ARRAY[p_contact])
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
  -- Conclusão em modo escrita (revisão 25/11): card ou tarefa de revisão que falhou volta no ciclo seguinte, até 5 tentativas.
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  owner_user_id uuid,
  owner_rule text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, trigger_kind, trigger_id)
);
CREATE INDEX IF NOT EXISTS returning_customer_decisions_contact ON public.returning_customer_decisions (organization_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS returning_customer_decisions_review ON public.returning_customer_decisions (organization_id, created_at DESC) WHERE outcome = 'needs_review' AND reviewed_at IS NULL;
ALTER TABLE public.returning_customer_decisions ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS returning_customer_decisions_pending ON public.returning_customer_decisions (organization_id, created_at)
  WHERE mode = 'write' AND (outcome = 'would_create' OR (outcome = 'needs_review' AND review_task_id IS NULL));

-- Gatilhos ainda sem decisão (revisão 25/11: a exclusão dos já decididos vem ANTES do limite; antes, 30 gatilhos decididos no início
-- da janela de 48 h escondiam os novos). Encaminhamentos para humano + tarefas comerciais da IA sem negócio, mais antigos primeiro.
CREATE OR REPLACE FUNCTION public.returning_customer_triggers(p_org uuid, p_since timestamptz, p_task_types text[], p_limit integer)
RETURNS TABLE (kind text, id uuid, contact_id uuid, conversation_id uuid, at timestamptz, summary text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM (
    SELECT 'handoff'::text, h.id, c.contact_id, h.conversation_id, h.handed_at, h.resumo
      FROM public.handoff_events h JOIN public.conversations c ON c.id = h.conversation_id
     WHERE h.organization_id = p_org AND h.trigger_type = 'request_human' AND h.handed_at >= p_since
       AND NOT EXISTS (SELECT 1 FROM public.returning_customer_decisions d WHERE d.organization_id = p_org AND d.trigger_kind = 'handoff' AND d.trigger_id = h.id)
    UNION ALL
    SELECT 'task'::text, t.id, t.contact_id, t.conversation_id, t.created_at, nullif(concat_ws(' — ', t.title, t.description), '')
      FROM public.tasks t
     WHERE t.organization_id = p_org AND t.created_by_type = 'ai' AND t.opportunity_id IS NULL AND t.type = ANY (p_task_types)
       AND t.status IN ('pending', 'in_progress', 'rescheduled') AND t.created_at >= p_since
       AND NOT EXISTS (SELECT 1 FROM public.returning_customer_decisions d WHERE d.organization_id = p_org AND d.trigger_kind = 'task' AND d.trigger_id = t.id)
  ) x(kind, id, contact_id, conversation_id, at, summary)
  ORDER BY x.at, x.id
  LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION public.returning_customer_triggers(uuid, timestamptz, text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.returning_customer_triggers(uuid, timestamptz, text[], integer) TO service_role;

-- Decisões em modo escrita ainda não concluídas (card não criado / revisão sem tarefa), até 5 tentativas e 7 dias.
CREATE OR REPLACE FUNCTION public.returning_customer_pending_decisions(p_org uuid, p_limit integer)
RETURNS SETOF public.returning_customer_decisions LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM public.returning_customer_decisions d
   WHERE d.organization_id = p_org AND d.mode = 'write' AND d.attempts < 5 AND d.created_at > now() - interval '7 days'
     AND (d.outcome = 'would_create' OR (d.outcome = 'needs_review' AND d.review_task_id IS NULL))
   ORDER BY d.created_at LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION public.returning_customer_pending_decisions(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.returning_customer_pending_decisions(uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.returning_customer_mark_attempt(p_decision uuid, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.returning_customer_decisions SET attempts = attempts + 1, last_error = left(p_error, 500) WHERE id = p_decision
$$;
REVOKE ALL ON FUNCTION public.returning_customer_mark_attempt(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.returning_customer_mark_attempt(uuid, text) TO service_role;

-- Responsável pela decisão (card ou revisão), gravado na própria decisão (idempotente: o rodízio só anda uma vez por decisão).
-- Ordem: vendedor do negócio anterior se ativo; vendedor que o rodízio entregou na atribuição ativa da conversa; vendedor da
-- conversa; rodízio (mesmo ponteiro e mesma trava da distribuição de leads); vendedor em pausa na ordem do rodízio.
-- Ninguém (todos 'out'): devolve user_id nulo e o chamador não cria nada (a decisão continua pendente).
CREATE OR REPLACE FUNCTION public.returning_customer_owner(p_decision uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.returning_customer_decisions; v_prev uuid; v_owner uuid; v_rule text; st public.lead_distribution_state; r public.sales_reps;
BEGIN
  SELECT * INTO d FROM public.returning_customer_decisions WHERE id = p_decision FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('user_id', NULL, 'rule', 'none'); END IF;
  IF d.owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.sales_reps x WHERE x.organization_id = d.organization_id AND x.user_id = d.owner_user_id AND x.availability <> 'out') THEN
    RETURN jsonb_build_object('user_id', d.owner_user_id, 'rule', d.owner_rule);
  END IF;
  SELECT owner_id INTO v_prev FROM public.opportunities WHERE id = d.previous_opportunity_id;
  IF EXISTS (SELECT 1 FROM public.sales_reps x WHERE x.organization_id = d.organization_id AND x.user_id = v_prev AND x.availability <> 'out') THEN
    v_owner := v_prev; v_rule := 'previous_owner';
  END IF;
  IF v_owner IS NULL AND d.conversation_id IS NOT NULL THEN
    SELECT x.user_id INTO v_owner FROM public.lead_assignments a JOIN public.sales_reps x ON x.id = a.rep_id
     WHERE a.organization_id = d.organization_id AND a.conversation_id = d.conversation_id AND a.status IN ('pending', 'accepted') AND x.availability <> 'out'
     ORDER BY a.assigned_at DESC LIMIT 1;
    IF v_owner IS NOT NULL THEN v_rule := 'rotation_assignment'; END IF;
  END IF;
  IF v_owner IS NULL AND d.conversation_id IS NOT NULL THEN
    SELECT c.assigned_to INTO v_owner FROM public.conversations c JOIN public.sales_reps x ON x.organization_id = c.organization_id AND x.user_id = c.assigned_to
     WHERE c.id = d.conversation_id AND x.availability <> 'out';
    IF v_owner IS NOT NULL THEN v_rule := 'conversation_owner'; END IF;
  END IF;
  IF v_owner IS NULL THEN
    INSERT INTO public.lead_distribution_state (organization_id) VALUES (d.organization_id) ON CONFLICT DO NOTHING;
    SELECT * INTO st FROM public.lead_distribution_state WHERE organization_id = d.organization_id FOR UPDATE;
    SELECT x.* INTO r FROM public.sales_reps x
     WHERE x.organization_id = d.organization_id AND x.availability = 'available'
       AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = x.organization_id AND m.user_id = x.user_id)
     ORDER BY (x.rotation_order > coalesce(st.last_rotation_order, 0)) DESC, x.rotation_order LIMIT 1;
    IF r.id IS NOT NULL THEN
      UPDATE public.lead_distribution_state SET last_rotation_order = r.rotation_order, updated_at = now() WHERE organization_id = d.organization_id;
      UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = r.id;
      v_owner := r.user_id; v_rule := 'round_robin';
    END IF;
  END IF;
  IF v_owner IS NULL THEN
    SELECT x.user_id INTO v_owner FROM public.sales_reps x
     WHERE x.organization_id = d.organization_id AND x.availability <> 'out'
       AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = x.organization_id AND m.user_id = x.user_id)
     ORDER BY x.rotation_order LIMIT 1;
    IF v_owner IS NOT NULL THEN v_rule := 'paused_rep_fallback'; END IF;
  END IF;
  IF v_owner IS NOT NULL THEN
    UPDATE public.returning_customer_decisions SET owner_user_id = v_owner, owner_rule = v_rule WHERE id = d.id;
  END IF;
  RETURN jsonb_build_object('user_id', v_owner, 'rule', coalesce(v_rule, 'none'));
END $$;
REVOKE ALL ON FUNCTION public.returning_customer_owner(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.returning_customer_owner(uuid) TO service_role;

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
        v_o jsonb; v_touch jsonb; v_basis text; v_closed_at timestamptz;
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

  -- Dono (revisão 25/11): sempre alguém. Ver returning_customer_owner (anterior ativo > atribuição > conversa > rodízio > pausa).
  v_o := public.returning_customer_owner(d.id);
  v_owner := (v_o->>'user_id')::uuid; v_rule := v_o->>'rule';
  IF v_owner IS NULL THEN
    UPDATE public.returning_customer_decisions SET attempts = attempts + 1, last_error = 'no_available_rep' WHERE id = d.id;
    RETURN NULL;
  END IF;

  -- Origem (revisão 25/11): a do cadastro é HISTÓRICA (primeiro contato). A da nova negociação só vem de um toque de anúncio dentro da
  -- janela de atribuição (14 dias antes da criação, 1 min de tolerância; mesma regra de attributeTouch/opportunity_ad_origins).
  SELECT coalesce(w.metadata->'lead_origin', 'null'::jsonb) INTO v_origin FROM public.wa_contacts w WHERE w.id = d.contact_id;
  v_touch := CASE WHEN p_origin IS NOT NULL AND jsonb_typeof(p_origin) = 'object' AND (p_origin->>'touched_at') IS NOT NULL
                       AND (p_origin->>'touched_at')::timestamptz BETWEEN now() - interval '14 days' AND now() + interval '1 minute'
                  THEN p_origin END;
  v_basis := CASE WHEN v_touch IS NULL THEN 'indeterminate'
                  WHEN v_touch->>'conversation_id' = d.conversation_id::text THEN 'conversation' ELSE 'estimated' END;

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
                             'owner_rule', v_rule, 'lead_origin_historico', v_origin, 'ad_touch', v_touch, 'origin_basis', v_basis),
          'Negócio criado: cliente voltou com intenção comercial. ' || left(d.reason, 800), 'ai');

  -- Tarefas comerciais abertas do grupo, sem negócio, CRIADAS DEPOIS do fechamento anterior, passam a apontar para o card
  -- (revisão 25/11: a de antes é da negociação antiga). Tarefas administrativas e de outra operação ficam como estão.
  v_closed_at := coalesce((SELECT max(e.created_at) FROM public.opportunity_events e WHERE e.opportunity_id = prev.id AND e.event_type IN ('won', 'lost')), prev.updated_at);
  WITH linked AS (
    UPDATE public.tasks SET opportunity_id = v_opp
     WHERE id IN (SELECT x.id FROM public.tasks x
                   WHERE x.organization_id = d.organization_id AND x.contact_id = ANY (ids) AND x.opportunity_id IS NULL
                     AND x.status IN ('pending', 'in_progress', 'rescheduled') AND x.created_at >= v_closed_at
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
-- Revisão 25/11:
--   * tudo pelo GRUPO de identidade: a última mensagem do cliente em QUALQUER conversa/cadastro do grupo é a âncora; negócios,
--     promessas do vendedor (seller_commitments), propostas e retornos marcados do grupo inteiro contam;
--   * só conta follow-up realmente enviado (evolution_message_id = confirmação do WhatsApp; sem send_failed_at);
--   * devolve o negócio correspondente (opportunity_id: o único negócio aberto do grupo, ou nulo se não há nenhum);
--     com 2+ negócios abertos no grupo a conversa fica de fora (qual encerrar é decisão humana).
DROP FUNCTION IF EXISTS public.no_reply_closure_candidates(uuid, timestamptz, integer, integer, uuid);
CREATE FUNCTION public.no_reply_closure_candidates(p_org uuid, p_now timestamptz, p_wait_hours integer, p_limit integer, p_conversation uuid DEFAULT NULL)
RETURNS TABLE (conversation_id uuid, contact_id uuid, instance_id uuid, phone text, followup_days integer, last_outbound_at timestamptz, anchor timestamptz, opportunity_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH conv AS (
    SELECT c.* FROM public.conversations c
     WHERE c.organization_id = p_org AND (p_conversation IS NULL OR c.id = p_conversation) AND c.evolution_instance_id IS NOT NULL
       AND c.last_message_at <= p_now - make_interval(hours => p_wait_hours) AND c.last_message_at > p_now - interval '60 days'),
  last_role AS (
    SELECT c.*, (SELECT m.role FROM public.messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS lr FROM conv c),
  -- Pré-filtro barato (só a própria conversa): a âncora do grupo nunca é anterior à da conversa, então os dias de envio do grupo
  -- são no máximo estes. Só quem passa aqui paga o cálculo do grupo de identidade.
  pre AS (
    SELECT c.* FROM last_role c
     WHERE c.lr IN ('agent', 'human_agent')
       AND (SELECT count(DISTINCT (m.created_at AT TIME ZONE 'America/Sao_Paulo')::date) FROM public.messages m
             WHERE m.conversation_id = c.id AND m.role IN ('agent', 'human_agent') AND m.evolution_message_id IS NOT NULL
               AND NOT (coalesce(m.metadata, '{}'::jsonb) ? 'send_failed_at')
               AND m.created_at >= coalesce((SELECT max(x.created_at) FROM public.messages x WHERE x.conversation_id = c.id AND x.role = 'contact'), c.created_at)) >= 4),
  g AS (
    SELECT c.id, c.contact_id, c.evolution_instance_id, c.created_at, public._contact_identity_ids(p_org, c.contact_id) AS ids FROM pre c),
  a AS (
    SELECT g.*, coalesce((SELECT max(m.created_at) FROM public.messages m JOIN public.conversations cc ON cc.id = m.conversation_id
                           WHERE cc.organization_id = p_org AND cc.contact_id = ANY (g.ids) AND m.role = 'contact'), g.created_at) AS anchor
      FROM g),
  s AS (
    SELECT a.*, w.phone,
      (SELECT count(DISTINCT (m.created_at AT TIME ZONE 'America/Sao_Paulo')::date) FROM public.messages m
        WHERE m.conversation_id = a.id AND m.role IN ('agent', 'human_agent') AND m.created_at >= a.anchor
          AND m.evolution_message_id IS NOT NULL AND NOT (coalesce(m.metadata, '{}'::jsonb) ? 'send_failed_at')) AS days,
      (SELECT max(m.created_at) FROM public.messages m WHERE m.conversation_id = a.id AND m.role IN ('agent', 'human_agent') AND m.created_at >= a.anchor) AS last_out,
      (SELECT count(*) FROM public.opportunities o WHERE o.organization_id = p_org AND o.contact_id = ANY (a.ids) AND o.status = 'open') AS open_n,
      (SELECT o.id FROM public.opportunities o WHERE o.organization_id = p_org AND o.contact_id = ANY (a.ids) AND o.status = 'open' LIMIT 1) AS opp_id
      FROM a JOIN public.wa_contacts w ON w.id = a.contact_id AND w.organization_id = p_org
     WHERE w.phone IS NOT NULL AND w.phone NOT LIKE '%@g.us%'
       AND NOT coalesce(w.ai_disabled, false)
       AND NOT EXISTS (SELECT 1 FROM public.organization_ignored_contacts i WHERE i.organization_id = p_org AND i.phone = w.phone))
  SELECT s.id, s.contact_id, s.evolution_instance_id, s.phone, s.days::integer, s.last_out, s.anchor, s.opp_id
    FROM s
   WHERE s.days >= 4 AND s.last_out <= p_now - make_interval(hours => p_wait_hours) AND s.open_n <= 1
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = s.id AND m.created_at >= s.anchor AND public._is_farewell_message(m.role, m.content, m.metadata))
     AND NOT EXISTS (SELECT 1 FROM public.opportunities o WHERE o.organization_id = p_org AND o.contact_id = ANY (s.ids) AND o.status = 'open'
                      AND (o.stage NOT IN ('interest_received', 'qualification') OR coalesce(o.sale_amount, 0) > 0 OR coalesce(o.credit_amount, 0) > 0
                           OR (o.frozen_until IS NOT NULL)))
     AND NOT EXISTS (SELECT 1 FROM public.proposal_followups f JOIN public.conversations cc ON cc.id = f.conversation_id
                      WHERE f.organization_id = p_org AND cc.contact_id = ANY (s.ids) AND f.sent_at >= s.anchor)
     AND NOT EXISTS (SELECT 1 FROM public.seller_commitments sc WHERE sc.organization_id = p_org AND sc.contact_id = ANY (s.ids) AND sc.resolved_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.organization_id = p_org AND t.contact_id = ANY (s.ids) AND t.status IN ('pending', 'in_progress', 'rescheduled')
                      AND t.due_date > (p_now AT TIME ZONE 'America/Sao_Paulo')::date)
   ORDER BY s.last_out
   LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION public.no_reply_closure_candidates(uuid, timestamptz, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.no_reply_closure_candidates(uuid, timestamptz, integer, integer, uuid) TO service_role;

-- Depois do envio CONFIRMADO da despedida (desta rotina ou da cadência de baixa intenção): marca perdido 'sem_resposta' SÓ o negócio
-- correspondente e cancela as tarefas automáticas de "cliente parou de responder". Idempotente (metadata.closure_applied_at).
-- Revisão 25/11 — reconfere tudo no momento da aplicação:
--   * negócio correspondente = o capturado no envio (metadata.no_reply_closure.opportunity_id); na cadência de baixa intenção, o
--     único negócio aberto do grupo; nunca um negócio criado depois da despedida nem outra negociação do mesmo cliente;
--   * cliente respondeu depois da despedida em QUALQUER conversa/cadastro do grupo => nada muda;
--   * promessa do vendedor aberta, retorno marcado (tarefa com data futura) ou proposta depois da última resposta => nada muda;
--   * vendedor mexeu no negócio depois do envio (evento humano) ou o negócio avançou/ganhou valor/congelou => o negócio fica aberto.
-- Devolve quantos negócios foram marcados (0 ou 1); o motivo de não aplicar fica em metadata.closure_skipped.
CREATE OR REPLACE FUNCTION public.apply_no_reply_closure(p_message uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m public.messages; c public.conversations; ids uuid[]; n integer := 0; v_days integer; v_last text; v_anchor timestamptz;
        v_target uuid; v_skip text; o public.opportunities;
BEGIN
  SELECT * INTO m FROM public.messages WHERE id = p_message FOR UPDATE;
  IF NOT FOUND OR m.evolution_message_id IS NULL OR coalesce(m.metadata, '{}'::jsonb) ? 'closure_applied_at' THEN RETURN 0; END IF;
  IF NOT (coalesce(m.metadata, '{}'::jsonb) ? 'no_reply_closure' OR m.metadata->'low_intent_followup'->>'stage' = '3') THEN RETURN 0; END IF;
  -- Só despedidas a partir do início configurado: ligar a flag nunca aplica em massa as despedidas antigas da cadência (desde 20/10).
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = m.organization_id AND settings->'no_reply_closure_enabled' = 'true'::jsonb
                  AND settings->>'no_reply_closure_started_at' IS NOT NULL AND m.created_at >= (settings->>'no_reply_closure_started_at')::timestamptz) THEN RETURN 0; END IF;
  SELECT * INTO c FROM public.conversations WHERE id = m.conversation_id;
  ids := public._contact_identity_ids(m.organization_id, c.contact_id);
  PERFORM 1 FROM public.wa_contacts WHERE organization_id = m.organization_id AND id = ANY (ids) ORDER BY id FOR NO KEY UPDATE;
  v_anchor := (SELECT max(x.created_at) FROM public.messages x JOIN public.conversations cc ON cc.id = x.conversation_id
                WHERE cc.organization_id = m.organization_id AND cc.contact_id = ANY (ids) AND x.role = 'contact' AND x.created_at < m.created_at);

  IF EXISTS (SELECT 1 FROM public.messages x JOIN public.conversations cc ON cc.id = x.conversation_id
              WHERE cc.organization_id = m.organization_id AND cc.contact_id = ANY (ids) AND x.role = 'contact' AND x.created_at > m.created_at) THEN
    v_skip := 'customer_replied';
  ELSIF EXISTS (SELECT 1 FROM public.seller_commitments sc WHERE sc.organization_id = m.organization_id AND sc.contact_id = ANY (ids) AND sc.resolved_at IS NULL) THEN
    v_skip := 'seller_commitment_open';
  ELSIF EXISTS (SELECT 1 FROM public.tasks t WHERE t.organization_id = m.organization_id AND t.contact_id = ANY (ids) AND t.status IN ('pending', 'in_progress', 'rescheduled')
                 AND t.due_date > (now() AT TIME ZONE 'America/Sao_Paulo')::date) THEN
    v_skip := 'return_scheduled';
  ELSIF EXISTS (SELECT 1 FROM public.proposal_followups f JOIN public.conversations cc ON cc.id = f.conversation_id
                 WHERE f.organization_id = m.organization_id AND cc.contact_id = ANY (ids) AND f.sent_at >= coalesce(v_anchor, c.created_at)) THEN
    v_skip := 'proposal_sent';
  END IF;

  IF v_skip IS NULL THEN
    IF m.metadata ? 'no_reply_closure' THEN
      v_target := nullif(m.metadata->'no_reply_closure'->>'opportunity_id', '')::uuid;
    ELSIF (SELECT count(*) FROM public.opportunities x WHERE x.organization_id = m.organization_id AND x.contact_id = ANY (ids) AND x.status = 'open') = 1 THEN
      SELECT x.id INTO v_target FROM public.opportunities x WHERE x.organization_id = m.organization_id AND x.contact_id = ANY (ids) AND x.status = 'open';
    END IF;

    IF v_target IS NOT NULL THEN
      SELECT * INTO o FROM public.opportunities x
       WHERE x.id = v_target AND x.organization_id = m.organization_id AND x.contact_id = ANY (ids) AND x.status = 'open' AND x.created_at < m.created_at
         AND x.stage IN ('interest_received', 'qualification') AND coalesce(x.sale_amount, 0) = 0 AND coalesce(x.credit_amount, 0) = 0 AND x.frozen_until IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.opportunity_events e WHERE e.opportunity_id = x.id AND e.changed_by_type = 'human' AND e.created_at > m.created_at)
       FOR UPDATE;
      IF o.id IS NULL THEN v_skip := 'opportunity_changed'; END IF;
    END IF;

    IF o.id IS NOT NULL THEN
      v_days := coalesce((m.metadata->'no_reply_closure'->>'followup_days')::integer,
                         (SELECT count(DISTINCT (x.created_at AT TIME ZONE 'America/Sao_Paulo')::date) FROM public.messages x
                           WHERE x.conversation_id = m.conversation_id AND x.role IN ('agent', 'human_agent') AND x.id <> m.id AND x.evolution_message_id IS NOT NULL
                             AND x.created_at >= coalesce(v_anchor, c.created_at))::integer);
      v_last := to_char((SELECT max(x.created_at) FROM public.messages x WHERE x.conversation_id = m.conversation_id AND x.role IN ('agent', 'human_agent') AND x.id <> m.id
                          AND x.created_at < m.created_at) AT TIME ZONE 'America/Sao_Paulo', 'DD/MM');
      UPDATE public.opportunities SET status = 'lost', lost_reason = 'sem_resposta', resume_date = NULL, last_progress_at = now() WHERE id = o.id;
      INSERT INTO public.opportunity_events(organization_id, opportunity_id, event_type, previous_value, new_value, evidence, changed_by_type)
      VALUES (m.organization_id, o.id, 'lost', jsonb_build_object('status', o.status),
              jsonb_build_object('status', 'lost', 'lost_reason', 'sem_resposta', 'resume_date', NULL, 'source', 'no_reply_closure', 'message_id', m.id),
              'Encerramento automático: ' || greatest(v_days - 1, 0) || ' follow-ups sem resposta (último em ' || coalesce(v_last, '-') || ')', 'ai');
      n := 1;
    END IF;

    IF v_skip IS NULL THEN
      WITH cancelled AS (
        UPDATE public.tasks SET status = 'cancelled'
         WHERE organization_id = m.organization_id AND conversation_id = m.conversation_id AND type = 'customer_unresponsive'
           AND created_by_type = 'ai' AND status IN ('pending', 'in_progress', 'rescheduled')
        RETURNING id)
      INSERT INTO public.task_events(task_id, organization_id, event_type, note, created_by_type)
      SELECT id, m.organization_id, 'cancelled', 'Encerramento automático enviado (mensagem ' || m.id::text || ')', 'ai' FROM cancelled;
    END IF;
  END IF;
  UPDATE public.messages SET metadata = coalesce(metadata, '{}'::jsonb)
         || jsonb_build_object('closure_applied_at', now(), 'closure_lost_count', n)
         || CASE WHEN v_skip IS NOT NULL THEN jsonb_build_object('closure_skipped', v_skip) ELSE '{}'::jsonb END
   WHERE id = m.id;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.apply_no_reply_closure(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_no_reply_closure(uuid) TO service_role;
