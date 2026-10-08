-- supabase/migrations/20261008120100_seller_isolation_conversations.sql
-- Isolamento por vendedor (RLS), parte 2: conversas e dependentes. Só restringe com seller_isolation_enabled = 'true'.

-- conversations: dono = assigned_to.
DROP POLICY IF EXISTS "conversations_select" ON public.conversations;
DROP POLICY IF EXISTS "conversations_insert" ON public.conversations;
DROP POLICY IF EXISTS "conversations_update" ON public.conversations;
DROP POLICY IF EXISTS "conversations_delete" ON public.conversations;
CREATE POLICY "conversations_select" ON public.conversations FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND (assigned_to IS NULL OR assigned_to = (SELECT auth.uid()) OR (organization_id, assigned_to) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)));
CREATE POLICY "conversations_insert" ON public.conversations FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND (assigned_to IS NULL OR assigned_to = (SELECT auth.uid()) OR (organization_id, assigned_to) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)));
CREATE POLICY "conversations_update" ON public.conversations FOR UPDATE
  USING (organization_id IN (SELECT get_user_org_ids()) AND (assigned_to IS NULL OR assigned_to = (SELECT auth.uid()) OR (organization_id, assigned_to) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)))
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND (assigned_to IS NULL OR assigned_to = (SELECT auth.uid()) OR (organization_id, assigned_to) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)));
CREATE POLICY "conversations_delete" ON public.conversations FOR DELETE
  USING (organization_id IN (SELECT get_user_org_ids()) AND (assigned_to IS NULL OR assigned_to = (SELECT auth.uid()) OR (organization_id, assigned_to) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)));

-- Dependentes diretos da conversa: a subconsulta em conversations herda o RLS acima (só enxerga conversas visíveis).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages','conversation_notes','conversation_qualifications'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_select" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_insert" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_update" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_delete" ON public.%1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_select" ON public.%1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = %1$s.conversation_id))', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON public.%1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = %1$s.conversation_id))', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON public.%1$s FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = %1$s.conversation_id)) WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = %1$s.conversation_id))', t);
    EXECUTE format('CREATE POLICY "%1$s_delete" ON public.%1$s FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = %1$s.conversation_id))', t);
  END LOOP;
END $$;

-- handoff_events (hoje: select, insert, update; sem delete).
DROP POLICY IF EXISTS "handoff_events_select" ON public.handoff_events;
DROP POLICY IF EXISTS "handoff_events_insert" ON public.handoff_events;
DROP POLICY IF EXISTS "handoff_events_update" ON public.handoff_events;
CREATE POLICY "handoff_events_select" ON public.handoff_events FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = handoff_events.conversation_id));
CREATE POLICY "handoff_events_insert" ON public.handoff_events FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = handoff_events.conversation_id));
CREATE POLICY "handoff_events_update" ON public.handoff_events FOR UPDATE
  USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = handoff_events.conversation_id));

-- conversation_qualification_events: via a qualificação (que herda a conversa). Hoje: select, insert.
DROP POLICY IF EXISTS "conversation_qualification_events_select" ON public.conversation_qualification_events;
DROP POLICY IF EXISTS "conversation_qualification_events_insert" ON public.conversation_qualification_events;
CREATE POLICY "conversation_qualification_events_select" ON public.conversation_qualification_events FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversation_qualifications q WHERE q.id = conversation_qualification_events.conversation_qualification_id));
CREATE POLICY "conversation_qualification_events_insert" ON public.conversation_qualification_events FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.conversation_qualifications q WHERE q.id = conversation_qualification_events.conversation_qualification_id));

-- conversation_reads: sem alteração (política atual já exige user_id = auth.uid() e subconsulta em conversations, que sofre RLS).
