-- Escalada em dois estágios para atribuições 'alert' (dono existente e atribuição manual) sem resposta.
--
-- Caso real (27/10): cliente da carteira da Marina pediu atendimento às 09:40, o SLA estourou às 10:40 e ninguém respondeu por
-- 2h+: com sla_action='alert' a atribuição só ganha sla_breached (flag_sla_alerts) e nunca muda de vendedor.
--
-- Atrás da chave organizations.settings.sla_alert_escalation_enabled = JSON true (e lead_distribution_enabled), DESLIGADA por padrão:
--   estágio 1 (1x o SLA): o worker de push avisa o DONO ("SLA estourado: responda <cliente>"); não é SQL (apps/worker + packages/database).
--   estágio 2 (2x o SLA): esta função. O worker calcula p_escalate_at (assigned_at + 2x o SLA em minutos úteis, mesmo calendário do
--   SLA) e p_new_sla_due_at (SLA novo, a partir de agora, para o novo vendedor) e a chama para cada candidata vencida.
--
-- escalate_alert_assignment(p_assignment_id, p_escalate_at, p_new_sla_due_at) -> uuid da nova atribuição, ou NULL se não agiu.
-- Só age se TUDO for verdade, relido sob lock (idempotente; rodar duas vezes não duplica):
--   * flags lead_distribution_enabled e sla_alert_escalation_enabled ligadas;
--   * atribuição ainda 'pending', sla_action='alert', reason IN ('existing_owner','manual'), sla_due_at <= agora e p_escalate_at <= agora;
--   * atribuída depois de lead_distribution_activated_at (se houver);
--   * a cadeia (chain_id) ainda NÃO foi escalada: no máximo UMA escalada por cadeia (a nova linha também é 'alert', mas a cadeia já
--     tem redistribution_reason='sla_escalation', então não vai e volta);
--   * cliente não respondido por humano: first_human_message_at nulo e nenhuma mensagem role='human_agent' na conversa desde o handoff;
--   * existe OUTRO vendedor elegível: availability='available' (como o rodízio e redistribute_assignment; 'paused' e 'out' não recebem
--     escalada automática), membro da organização, que ainda não passou por esta cadeia. Escolha: o próximo na ordem do rodízio depois do
--     vendedor atual (mesma ordenação de redistribute_assignment).
--   Sem outro vendedor: a atribuição FICA com o dono e recebe o rastro redistribution_reason='sla_escalation_no_rep' (coluna mutável;
--   NÃO cria linha 'exception', porque exception + pendente na mesma conversa quebraria manual_assign/distribute_lead). Tenta de novo
--   nas próximas varreduras (quando um vendedor ficar disponível a escalada acontece e o rastro é substituído).
-- Efeito da escalada: a antiga vira 'redistributed' (redistribution_reason='sla_escalation', sla_breached=true, next_assignment_id);
--   a nova é 'pending', reason='sla_redistribution', sla_action='alert' (SLA novo, nunca redistribui sozinha), mesma cadeia/handoff/
--   handoff_at, opportunity_id do negócio; _lead_apply_effects leva conversa, negócio aberto e tarefas ao novo dono (e cria o card
--   se o contato ainda não tinha, ver 20261027120000). O ponteiro do rodízio acompanha quem recebeu.
--   O push "Novo lead" ao novo dono sai do gatilho normal de atribuições pendentes novas (listNewAssignmentCandidates).
--
-- ORDEM DE LOCKS (igual a redistribute_assignment / manual_assign; sem espera nova):
--   lead_distribution_state (FOR UPDATE; criado se faltar) -> lead_assignments da atribuição (FOR UPDATE)
--   -> [dentro de _lead_apply_effects] conversations -> wa_contacts (NO KEY UPDATE SKIP LOCKED) -> opportunities -> tasks.
--   O estado da organização é sempre o primeiro; nunca se toma o lock do contato antes dele.
--
-- Idempotente (CREATE OR REPLACE). NÃO aplicada automaticamente.
-- Reverter: DROP FUNCTION IF EXISTS public.escalate_alert_assignment(uuid, timestamptz, timestamptz);
--   (as linhas já escaladas ficam no histórico: redistribution_reason = 'sla_escalation' / 'sla_escalation_no_rep').

CREATE OR REPLACE FUNCTION public.escalate_alert_assignment(p_assignment_id uuid, p_escalate_at timestamptz, p_new_sla_due_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.lead_assignments; cur public.sales_reps; nxt public.sales_reps; new_id uuid; opp_id uuid; org uuid; s jsonb;
BEGIN
  SELECT organization_id INTO org FROM public.lead_assignments WHERE id = p_assignment_id;
  IF org IS NULL THEN RETURN NULL; END IF;
  -- Filtros baratos, sem lock.
  SELECT settings INTO s FROM public.organizations WHERE id = org;
  IF s IS NULL OR s->'lead_distribution_enabled' IS DISTINCT FROM 'true'::jsonb OR s->'sla_alert_escalation_enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL; END IF;
  IF p_escalate_at IS NULL OR p_escalate_at > now() THEN RETURN NULL; END IF;

  -- Mesma ordem de travas de distribute_lead/redistribute_assignment: estado da organização primeiro, depois a linha.
  INSERT INTO public.lead_distribution_state (organization_id) VALUES (org) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.lead_distribution_state WHERE organization_id = org FOR UPDATE;
  SELECT * INTO a FROM public.lead_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF a.status <> 'pending' OR a.sla_action <> 'alert' OR a.reason NOT IN ('existing_owner', 'manual') OR a.rep_id IS NULL
     OR a.sla_due_at IS NULL OR a.sla_due_at > now() THEN RETURN NULL; END IF;
  -- Linha anterior à (re)ativação da distribuição: não mexe (nada de movimentação em massa ao religar).
  IF s->>'lead_distribution_activated_at' IS NOT NULL AND (s->>'lead_distribution_activated_at')::timestamptz > a.assigned_at THEN RETURN NULL; END IF;
  -- No máximo uma escalada por cadeia.
  IF EXISTS (SELECT 1 FROM public.lead_assignments x WHERE x.chain_id = a.chain_id AND x.redistribution_reason = 'sla_escalation') THEN RETURN NULL; END IF;
  -- Cliente já atendido por humano: nada a escalar.
  IF a.first_human_message_at IS NOT NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = a.conversation_id AND m.organization_id = a.organization_id
                AND m.role = 'human_agent' AND m.created_at >= a.handoff_at) THEN RETURN NULL; END IF;

  SELECT * INTO cur FROM public.sales_reps WHERE id = a.rep_id;
  SELECT r.* INTO nxt FROM public.sales_reps r
   WHERE r.organization_id = a.organization_id AND r.availability = 'available' AND r.id <> a.rep_id
     AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = r.organization_id AND m.user_id = r.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.lead_assignments x WHERE x.chain_id = a.chain_id AND x.rep_id = r.id)
   ORDER BY (r.rotation_order > cur.rotation_order) DESC, r.rotation_order LIMIT 1;

  IF nxt.id IS NULL THEN
    -- Ninguém para receber: o lead fica com o dono; deixa o rastro (e tenta de novo na próxima varredura).
    UPDATE public.lead_assignments SET redistribution_reason = 'sla_escalation_no_rep', sla_breached = true
     WHERE id = a.id AND redistribution_reason IS DISTINCT FROM 'sla_escalation_no_rep';
    RETURN NULL;
  END IF;

  UPDATE public.lead_assignments SET status = 'redistributed', sla_breached = true, redistribution_reason = 'sla_escalation' WHERE id = a.id;
  opp_id := public._lead_apply_effects(a.organization_id, a.conversation_id, a.contact_id, nxt.user_id, a.operation);
  INSERT INTO public.lead_assignments (organization_id, chain_id, handoff_event_id, contact_id, conversation_id, opportunity_id, rep_id, reason, status, handoff_at, sla_due_at, sla_action,
                                       previous_assignment_id, origin_source, operation, product_model, strategy_version)
  VALUES (a.organization_id, a.chain_id, a.handoff_event_id, a.contact_id, a.conversation_id, opp_id, nxt.id, 'sla_redistribution', 'pending', a.handoff_at, p_new_sla_due_at, 'alert',
          a.id, a.origin_source, a.operation, a.product_model, a.strategy_version)
  RETURNING id INTO new_id;
  UPDATE public.lead_assignments SET next_assignment_id = new_id WHERE id = a.id;
  -- O ponteiro acompanha quem recebeu: o próximo lead novo do rodízio vai ao vendedor seguinte.
  UPDATE public.lead_distribution_state SET last_rotation_order = nxt.rotation_order, updated_at = now() WHERE organization_id = a.organization_id;
  UPDATE public.sales_reps SET last_assigned_at = now() WHERE id = nxt.id;
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION public.escalate_alert_assignment(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.escalate_alert_assignment(uuid, timestamptz, timestamptz) TO service_role;
