-- Todo encaminhamento para humano deixa um card no funil.
--
-- Caso real (27/10): cliente da carteira da Marina pediu carta de crédito; a IA chamou requestHuman. Nasceram a atribuição
-- (existing_owner, alerta) e duas tarefas humanas (run_quote e other), mas o contato NÃO tinha negócio nenhum e não apareceu em
-- coluna alguma do funil (o funil é montado a partir de opportunities; trg_human_task_opens_opportunity pula tipos sem mapeamento).
--
-- O que muda: quando a distribuição aplica uma atribuição (distribute_lead, redistribute_assignment, manual_assign, todos via
-- _lead_apply_effects) e o contato não tem NENHUM negócio (aberto, ganho ou perdido) na organização, nasce 1 negócio aberto na
-- etapa inicial 'interest_received', dono = vendedor que recebeu o lead, ligado à atribuição (lead_assignments.opportunity_id,
-- coluna imutável: por isso o negócio é criado ANTES da linha da atribuição) e às tarefas abertas do contato.
--
-- Regras (as mesmas dos outros criadores, human_task_opens_opportunity / sync_sales_pipeline):
--   * flag organizations.settings.sales_auto_pipeline_enabled = JSON true;
--   * KILL SWITCH organizations.settings.handoff_card_enabled: LIGADO por padrão; só um JSON false explícito desliga a criação (também de ensure_handoff_cards);
--   * contato sem histórico de negócio (_contact_has_deal_history): histórico fechado NUNCA reabre, EXCETO card de encaminhamento perdido que
--     nunca teve a operação confirmada (operation_is_default ainda true) e nenhuma ação humana além do 'lost': esse não conta como histórico,
--     para não bloquear para sempre a criação automática quando o cliente voltar;
--   * telefone fora de organization_ignored_contacts;
--   * nunca um segundo negócio aberto; idempotente (rodar de novo não cria nada).
--
-- Operação (NOT NULL, nunca chutada), nesta ordem:
--   1. dado do encaminhamento: p_operation vindo de distribute_lead (contexto do handoff) ou, nos outros caminhos, a última
--      lead_assignments.operation da conversa (só se for uma das 5 operações válidas);
--   2. (conversation_qualifications NÃO tem coluna de operação, só product_interest em texto livre: não é usada, para não chutar);
--   3. tipo das tarefas abertas do contato (a distribuição as promove a humanas logo em seguida), se todas que mapeiam apontam para UMA operação (_task_type_operation);
--   4. padrão 'vehicle_sale'. O CHECK de opportunities.operation não tem valor "a definir" e mudá-lo afetaria o app inteiro.
--      Quando é só o padrão: opportunities.operation_is_default = true e o evento 'created' diz
--      "Negócio criado no encaminhamento para humano (operação a confirmar)". A migração seguinte
--      (20261027120100_default_operation_sync.sql) deixa sync_sales_pipeline corrigir a operação nesse caso.
--
-- ORDEM DE LOCKS (nenhuma espera nova; sem deadlock com distribute_lead, sync_sales_pipeline e human_task_opens_opportunity):
--   distribute_lead / redistribute_assignment / manual_assign: lead_distribution_state (FOR UPDATE) -> linha(s) de lead_assignments
--   -> conversations (UPDATE em _lead_apply_effects) -> [novo] wa_contacts FOR NO KEY UPDATE SKIP LOCKED -> opportunities (INSERT/UPDATE)
--   -> tasks (SKIP LOCKED na ligação, UPDATE de assignee como antes).
--   sync_sales_pipeline faz contato (FOR UPDATE) -> negócio -> tarefas, e NUNCA toma o lock do lead_distribution_state nem espera por ele;
--   portanto não há ciclo. Todos os "não" são decididos só com leituras, ANTES de qualquer lock de contato. Se o contato está
--   ocupado (sync_sales_pipeline ou outro criador em andamento) NÃO esperamos: o negócio não é criado agora (a atribuição segue
--   sem negócio, como hoje; quem está com o contato travado decide se cria). Reconferimos "existe negócio?" depois do lock.
--
-- Idempotente (CREATE OR REPLACE / IF NOT EXISTS). NÃO altera dados existentes. NÃO aplicada automaticamente.
-- Reverter (nesta ordem):
--   DROP TRIGGER IF EXISTS trg_clear_operation_is_default ON public.opportunities;
--   DROP FUNCTION IF EXISTS public.clear_operation_is_default();
--   Restaurar distribute_lead  = 20261007120400_lead_distribution_fixes.sql
--   DROP FUNCTION IF EXISTS public._lead_apply_effects(uuid, uuid, uuid, uuid, text);
--   recriar _lead_apply_effects(uuid,uuid,uuid,uuid) = 20261007120100_lead_distribution_assign.sql (e os GRANTs de lá)
--   DROP FUNCTION IF EXISTS public._open_opportunity_for_handoff(uuid, uuid, uuid, uuid, text); DROP FUNCTION IF EXISTS public._contact_has_deal_history(uuid, uuid);
--   (opcional) ALTER TABLE public.opportunities DROP COLUMN IF EXISTS operation_is_default;
--   Negócios já criados: opportunity_events.new_value->>'source' = 'handoff_card'.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS operation_is_default boolean NOT NULL DEFAULT false;

-- Quem define a operação (vendedor na tela, IA por pedido explícito) confirma: a marca cai sozinha.
CREATE OR REPLACE FUNCTION public.clear_operation_is_default()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.operation IS DISTINCT FROM OLD.operation THEN NEW.operation_is_default := false; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.clear_operation_is_default() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_clear_operation_is_default ON public.opportunities;
CREATE TRIGGER trg_clear_operation_is_default BEFORE UPDATE OF operation ON public.opportunities
  FOR EACH ROW EXECUTE FUNCTION public.clear_operation_is_default();

-- Histórico de negócio do contato. Um card do encaminhamento perdido, nunca confirmado (operation_is_default) e sem ação humana além de
-- marcar perdido, NÃO conta: o cliente que voltar volta a poder ganhar negócio automático.
CREATE OR REPLACE FUNCTION public._contact_has_deal_history(p_org uuid, p_contact uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.opportunities o
     WHERE o.organization_id = p_org AND o.contact_id = p_contact
       AND NOT (o.status = 'lost' AND o.operation_is_default
                AND NOT EXISTS (SELECT 1 FROM public.opportunity_events e WHERE e.opportunity_id = o.id AND e.changed_by_type = 'human' AND e.event_type <> 'lost'))
  )
$$;
REVOKE ALL ON FUNCTION public._contact_has_deal_history(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._contact_has_deal_history(uuid, uuid) TO service_role;

-- Cria o card do encaminhamento. Devolve o id do negócio criado ou NULL se pulou (qualquer "não", contato ocupado ou já existe).
CREATE OR REPLACE FUNCTION public._open_opportunity_for_handoff(p_org uuid, p_conversation uuid, p_contact uuid, p_user uuid, p_operation text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_operation text; v_source text; v_default boolean := false; v_owner uuid; v_opp uuid; v_task_ops text[];
BEGIN
  -- 1. Só leituras, sem lock.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org AND settings->'sales_auto_pipeline_enabled' = 'true'::jsonb) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org AND settings->'handoff_card_enabled' = 'false'::jsonb) THEN RETURN NULL; END IF;
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

-- Aplica a atribuição às tabelas operacionais. Devolve o negócio ligado (se houver exatamente um aberto).
-- Novo: antes de contar os negócios, cria o card do encaminhamento quando o contato não tem nenhum. p_operation é a dica do handoff.
-- Assinatura nova (5 argumentos, o último opcional): os chamadores antigos de 4 argumentos continuam funcionando.
DROP FUNCTION IF EXISTS public._lead_apply_effects(uuid, uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public._lead_apply_effects(p_org uuid, p_conversation uuid, p_contact uuid, p_user uuid, p_operation text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE opp_count integer; opp_id uuid;
BEGIN
  UPDATE public.conversations SET assigned_to = p_user, assigned_at = now() WHERE id = p_conversation AND organization_id = p_org;
  PERFORM public._open_opportunity_for_handoff(p_org, p_conversation, p_contact, p_user, p_operation);
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

-- distribute_lead v3: igual à v2 (20261007120400); só passa a operação do handoff para _lead_apply_effects.
CREATE OR REPLACE FUNCTION public.distribute_lead(p_organization_id uuid, p_conversation_id uuid, p_handoff_event_id uuid, p_sla_due_at timestamptz, p_context jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s jsonb; h public.handoff_events; c public.conversations; st public.lead_distribution_state; act public.lead_assignments;
  existing uuid; chain uuid := gen_random_uuid(); d record; rep public.sales_reps; opp record;
  lookback integer; new_id uuid; opp_id uuid; ctx jsonb := COALESCE(p_context, '{}'::jsonb); v_operation text; v_product_model text;
BEGIN
  SELECT settings INTO s FROM public.organizations WHERE id = p_organization_id;
  IF s IS NULL OR s->>'lead_distribution_enabled' IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
  SELECT * INTO h FROM public.handoff_events WHERE id = p_handoff_event_id AND organization_id = p_organization_id AND conversation_id = p_conversation_id;
  IF h.id IS NULL THEN RAISE EXCEPTION 'Handoff inexistente para esta conversa'; END IF;
  IF s->>'lead_distribution_activated_at' IS NOT NULL AND h.handed_at < (s->>'lead_distribution_activated_at')::timestamptz THEN RETURN NULL; END IF;

  -- Trava por organização: serializa as atribuições e protege o ponteiro do rodízio.
  INSERT INTO public.lead_distribution_state (organization_id) VALUES (p_organization_id) ON CONFLICT DO NOTHING;
  SELECT * INTO st FROM public.lead_distribution_state WHERE organization_id = p_organization_id FOR UPDATE;

  -- Idempotência primeiro: qualquer linha deste handoff (raiz de cadeia, continuação de um lead aceito ou distribution_error).
  SELECT id INTO existing FROM public.lead_assignments WHERE handoff_event_id = p_handoff_event_id ORDER BY assigned_at, created_at, id LIMIT 1;
  IF existing IS NOT NULL THEN RETURN existing; END IF;

  SELECT * INTO act FROM public.lead_assignments WHERE conversation_id = p_conversation_id AND status IN ('pending','accepted') FOR UPDATE;
  -- Pendente de outro handoff: o prazo em curso continua valendo; nada muda.
  IF act.status = 'pending' THEN RETURN act.id; END IF;

  -- Nova distribuição: exceções antigas desta conversa deixam a fila do gestor.
  UPDATE public.lead_assignments SET resolved_at = now(), resolution = 'superseded_by_new_handoff'
   WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id AND status = 'exception' AND resolved_at IS NULL;

  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id AND organization_id = p_organization_id;
  -- Contexto (colunas imutáveis): o que vier explícito vence; senão, o único negócio aberto do contato. origin_source fica como veio.
  SELECT count(*) AS n, min(o.operation) AS operation, min(o.product_model) AS product_model, bool_or(o.operation_is_default) AS is_default INTO opp
    FROM public.opportunities o WHERE o.organization_id = p_organization_id AND o.contact_id = c.contact_id AND o.status = 'open';
  -- card com operação só no padrão não é dado real: não grava a operação dele (coluna imutável) na atribuição
  v_operation := COALESCE(ctx->>'operation', CASE WHEN opp.n = 1 AND NOT COALESCE(opp.is_default, false) THEN opp.operation END);
  v_product_model := COALESCE(ctx->>'product_model', CASE WHEN opp.n = 1 THEN opp.product_model END);

  lookback := COALESCE(NULLIF(s->>'owner_lookback_days', '')::integer, 30);
  -- Decide com a atribuição aceita ainda visível (último responsável válido); só depois ela é encerrada.
  SELECT * INTO d FROM public._lead_decide(p_organization_id, c.id, c.contact_id, st.last_rotation_order, lookback);
  IF act.id IS NOT NULL THEN
    UPDATE public.lead_assignments SET status = 'redistributed', redistribution_reason = 'new_handoff' WHERE id = act.id;
  END IF;

  IF d.exception_reason IS NOT NULL THEN
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, rep_id, reason, status, handoff_at, exception_reason,
                                         previous_assignment_id, origin_source, operation, product_model, strategy_version)
    VALUES (p_organization_id, chain, p_handoff_event_id, c.contact_id, c.id, NULL, 'exception', 'exception', h.handed_at, d.exception_reason,
            act.id, ctx->>'origin_source', v_operation, v_product_model, 'round_robin_v1')
    RETURNING id INTO new_id;
  ELSE
    SELECT * INTO rep FROM public.sales_reps WHERE id = d.rep_id;
    IF d.reason = 'round_robin' THEN
      UPDATE public.lead_distribution_state SET last_rotation_order = rep.rotation_order, updated_at = now() WHERE organization_id = p_organization_id;
      UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = rep.id;
    END IF;
    opp_id := public._lead_apply_effects(p_organization_id, c.id, c.contact_id, rep.user_id, v_operation);
    INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at, sla_due_at, sla_action,
                                         previous_assignment_id, origin_source, operation, product_model, strategy_version)
    VALUES (p_organization_id, chain, p_handoff_event_id, c.contact_id, c.id, opp_id, rep.id, d.reason, 'pending', h.handed_at, p_sla_due_at,
            CASE WHEN d.reason = 'existing_owner' THEN 'alert' ELSE 'redistribute' END,
            act.id, ctx->>'origin_source', v_operation, v_product_model, 'round_robin_v1')
    RETURNING id INTO new_id;
  END IF;
  IF act.id IS NOT NULL THEN
    UPDATE public.lead_assignments SET next_assignment_id = new_id WHERE id = act.id;
  END IF;
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION public._open_opportunity_for_handoff(uuid, uuid, uuid, uuid, text), public._lead_apply_effects(uuid, uuid, uuid, uuid, text),
  public.distribute_lead(uuid, uuid, uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._open_opportunity_for_handoff(uuid, uuid, uuid, uuid, text), public._lead_apply_effects(uuid, uuid, uuid, uuid, text),
  public.distribute_lead(uuid, uuid, uuid, timestamptz, jsonb) TO service_role;
