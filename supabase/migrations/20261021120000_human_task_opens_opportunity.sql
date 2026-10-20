-- Tarefa humana aberta, sem negócio, para um cliente SEM nenhum histórico de negócio cria o negócio (card no funil).
-- Sem isso, tarefas do vendedor só aparecem em Tarefas/"Hoje" (o funil é montado a partir de opportunities).
--
-- Regras (todas checadas SEM lock antes de qualquer lock; qualquer "não" devolve cedo):
--   * flag organizations.settings.sales_auto_pipeline_enabled = JSON true (a mesma da criação automática);
--   * tarefa humana (assignee_type='human'), aberta (pending/in_progress/rescheduled) e SEM opportunity_id
--     (tarefa já ligada a um negócio, aberto ou fechado, nunca abre outro; tarefas de negócio fechado não são religadas);
--   * o contato NÃO tem nenhum negócio (aberto, ganho ou perdido): mesma regra de sync_sales_pipeline
--     (20261007120500, "IF EXISTS(SELECT 1 FROM opportunities WHERE ... contact_id) THEN RETURN NULL").
--     Contato só com negócios fechados fica fora: reabrir é decisão do vendedor;
--   * telefone fora de organization_ignored_contacts (a lista que o webhook descarta). ai_disabled NÃO bloqueia;
--   * operação: NUNCA chutada. Vem do tipo da tarefa quando mapeia sem ambiguidade (_task_type_operation:
--     consortium_followup, vehicle_followup, financing_followup, libera_cred_resumption); outros tipos => não cria
--     (a tarefa fica sem card, como hoje, e aparece em "A identificar"). Como contato com histórico nunca chega aqui,
--     "operação do último negócio" não se aplica. Um negócio com operação errada travaria o sync_sales_pipeline
--     (que não troca operação sem pedido explícito do cliente). Tarefas humanas abertas do contato com operações diferentes => ambíguo, não cria;
--   * etapa inicial: 'interest_received' (primeira etapa de todas as operações, a mesma de sync_sales_pipeline);
--   * dono: só vendedor cadastrado (sales_reps) da mesma org. Prefere o vendedor da conversa do contato (para negócio e
--     conversa não se separarem, como 20261015120000/20261020120000 garantem); sem conversa de vendedor, usa o assignee da
--     tarefa se for vendedor; senão sem dono. trg_owner_on_opportunity_open não sobrescreve dono já preenchido;
--   * vincula TODAS as tarefas abertas do contato sem opportunity_id ao negócio novo e registra task_events
--     'opportunity_auto_linked' (como sync_sales_pipeline); registra opportunity_events 'created' changed_by_type 'system'.
--
-- Onde o card cai (classifySalesQueue, packages/shared): NÃO em "Pronto para assumir" (isso exige handoff request_human pendente
-- sem resposta + exatamente 1 negócio aberto). Com a tarefa vinculada ele nunca é card vazio: cai por prazo das tarefas em
-- Compromissos de hoje (scheduled_callback vencido/hoje), Pendências com interesse (atrasada), Próximas ações (vence hoje)
-- ou Retornos futuros (prazo futuro); no modo por etapa fica em "Interesse recebido".
--
-- ORDEM DE LOCKS (evita deadlock com sync_sales_pipeline [contato -> negócio -> tarefas], set_opportunity_freeze
-- [negócio -> tarefas] e distribute_lead/_lead_apply_effects [lead_distribution_state -> conversa -> tarefas]):
--   1. todos os "não" são decididos só com leituras (sem lock). Em particular, tarefa de contato que já tem negócio (o caso
--      comum, e o do congelamento) nunca toca em lock de contato;
--   2. só quando vai criar: SELECT ... FOR NO KEY UPDATE SKIP LOCKED na linha do contato (conflita com o FOR UPDATE do
--      sync_sales_pipeline e com outras instâncias deste gatilho, mas não com locks KEY SHARE de FK). Se ocupada, NÃO espera:
--      não cria; a tarefa só ganha o negócio na próxima mudança de assignee_type/status ou ao rodar o backfill de novo;
--      as tarefas irmãs também são ligadas com FOR UPDATE SKIP LOCKED;
--   3. reconfere "existe negócio?" depois do lock (outro commit pode ter criado).
--   O gatilho nunca bloqueia esperando lock de contato.
--
-- Idempotente. NÃO altera dados existentes (backfill separado, usa _open_opportunity_for_task).
-- Reverter: DROP TRIGGER IF EXISTS trg_human_task_opens_opportunity ON public.tasks;
--   DROP FUNCTION IF EXISTS public.human_task_opens_opportunity(); DROP FUNCTION IF EXISTS public._open_opportunity_for_task(uuid, text);
--   DROP FUNCTION IF EXISTS public._task_type_operation(text);
--   Negócios já criados: opportunity_events.new_value->>'source' IN ('human_task_trigger','human_task_backfill').

-- Aplicação nunca fica pendurada esperando lock de DDL: falha em 5s (rode de novo).
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public._task_type_operation(p_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type
    WHEN 'consortium_followup' THEN 'consortium'
    WHEN 'vehicle_followup' THEN 'vehicle_sale'
    WHEN 'financing_followup' THEN 'financing'
    WHEN 'libera_cred_resumption' THEN 'libera_cred'
    ELSE NULL END
$$;

-- Núcleo compartilhado pelo gatilho e pelo backfill. Devolve o id do negócio criado ou NULL se pulou.
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
  -- Ambíguo: tarefas humanas abertas do contato apontam para operações diferentes (a operação sairia da ordem das linhas).
  IF (SELECT count(DISTINCT public._task_type_operation(x.type)) FROM public.tasks x
       WHERE x.organization_id = t.organization_id AND x.contact_id = t.contact_id AND x.assignee_type = 'human'
         AND x.status IN ('pending', 'in_progress', 'rescheduled') AND public._task_type_operation(x.type) IS NOT NULL) > 1 THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = t.organization_id AND settings->'sales_auto_pipeline_enabled' = 'true'::jsonb) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.opportunities WHERE organization_id = t.organization_id AND contact_id = t.contact_id) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_ignored_contacts i JOIN public.wa_contacts w ON w.organization_id = i.organization_id AND w.phone = i.phone
              WHERE w.id = t.contact_id AND w.organization_id = t.organization_id) THEN
    RETURN NULL;
  END IF;

  -- Só agora, e sem esperar: trava o contato.
  PERFORM 1 FROM public.wa_contacts WHERE id = t.contact_id AND organization_id = t.organization_id FOR NO KEY UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.opportunities WHERE organization_id = t.organization_id AND contact_id = t.contact_id) THEN
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

  -- (atenção, L3: createTask/updateTask devolvem a linha de antes deste UPDATE; opportunity_id/updated_at ficam velhos para o chamador)
  -- UPDATE de opportunity_id não reaciona o gatilho (ele só escuta assignee_type e status).
  -- Irmãs: SKIP LOCKED para nunca esperar linha de tarefa (evita deadlock com reatribuição/distribuição); a própria tarefa
  -- já está travada por esta transação, então sempre entra. Irmã pulada cai no casamento por contato da tela.
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

CREATE OR REPLACE FUNCTION public.human_task_opens_opportunity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Filtro barato e sem lock antes de chamar o núcleo.
  IF NEW.assignee_type IS DISTINCT FROM 'human' OR NEW.opportunity_id IS NOT NULL OR NEW.status NOT IN ('pending', 'in_progress', 'rescheduled') THEN
    RETURN NEW;
  END IF;
  PERFORM public._open_opportunity_for_task(NEW.id, 'human_task_trigger');
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public._task_type_operation(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._open_opportunity_for_task(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.human_task_opens_opportunity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_human_task_opens_opportunity ON public.tasks;
CREATE TRIGGER trg_human_task_opens_opportunity
  AFTER INSERT OR UPDATE OF assignee_type, status ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.human_task_opens_opportunity();
