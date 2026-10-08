-- supabase/migrations/20261008120200_seller_isolation_opportunities.sql
-- Isolamento por vendedor (RLS), parte 3: negócios, tarefas, eventos e contatos. Só restringe com seller_isolation_enabled = 'true'.

-- opportunities: dono = owner_id.
DROP POLICY IF EXISTS "opportunities_select" ON public.opportunities;
DROP POLICY IF EXISTS "opportunities_insert" ON public.opportunities;
DROP POLICY IF EXISTS "opportunities_update" ON public.opportunities;
DROP POLICY IF EXISTS "opportunities_delete" ON public.opportunities;
CREATE POLICY "opportunities_select" ON public.opportunities FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, owner_id));
CREATE POLICY "opportunities_insert" ON public.opportunities FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, owner_id));
CREATE POLICY "opportunities_update" ON public.opportunities FOR UPDATE
  USING (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, owner_id))
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, owner_id));
CREATE POLICY "opportunities_delete" ON public.opportunities FOR DELETE
  USING (organization_id IN (SELECT get_user_org_ids()) AND public.seller_can_see(organization_id, owner_id));

-- opportunity_events (hoje: select, insert): via o negócio.
DROP POLICY IF EXISTS "opportunity_events_select" ON public.opportunity_events;
DROP POLICY IF EXISTS "opportunity_events_insert" ON public.opportunity_events;
CREATE POLICY "opportunity_events_select" ON public.opportunity_events FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = opportunity_events.opportunity_id));
CREATE POLICY "opportunity_events_insert" ON public.opportunity_events FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = opportunity_events.opportunity_id));

-- tasks: o vínculo mais forte decide (negócio > conversa > responsável).
DROP POLICY IF EXISTS "tasks_select" ON public.tasks;
DROP POLICY IF EXISTS "tasks_insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks_update" ON public.tasks;
DROP POLICY IF EXISTS "tasks_delete" ON public.tasks;
CREATE POLICY "tasks_select" ON public.tasks FOR SELECT USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE public.seller_can_see(organization_id, assignee_id) END));
CREATE POLICY "tasks_insert" ON public.tasks FOR INSERT WITH CHECK (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE public.seller_can_see(organization_id, assignee_id) END));
CREATE POLICY "tasks_update" ON public.tasks FOR UPDATE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE public.seller_can_see(organization_id, assignee_id) END))
  WITH CHECK (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE public.seller_can_see(organization_id, assignee_id) END));
CREATE POLICY "tasks_delete" ON public.tasks FOR DELETE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE public.seller_can_see(organization_id, assignee_id) END));

-- task_events: via a tarefa.
DO $$
DECLARE cmd text;
BEGIN
  DROP POLICY IF EXISTS "task_events_select" ON public.task_events;
  DROP POLICY IF EXISTS "task_events_insert" ON public.task_events;
  DROP POLICY IF EXISTS "task_events_update" ON public.task_events;
  DROP POLICY IF EXISTS "task_events_delete" ON public.task_events;
  CREATE POLICY "task_events_select" ON public.task_events FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.tasks k WHERE k.id = task_events.task_id));
  CREATE POLICY "task_events_insert" ON public.task_events FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.tasks k WHERE k.id = task_events.task_id));
  CREATE POLICY "task_events_update" ON public.task_events FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.tasks k WHERE k.id = task_events.task_id));
  CREATE POLICY "task_events_delete" ON public.task_events FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.tasks k WHERE k.id = task_events.task_id));
END $$;

-- wa_contacts: visível se o isolamento não se aplica, ou o contato não tem conversa nenhuma (função que ignora RLS), ou alguma conversa dele é visível.
DROP POLICY IF EXISTS "wa_contacts_select" ON public.wa_contacts;
DROP POLICY IF EXISTS "wa_contacts_insert" ON public.wa_contacts;
DROP POLICY IF EXISTS "wa_contacts_update" ON public.wa_contacts;
DROP POLICY IF EXISTS "wa_contacts_delete" ON public.wa_contacts;
CREATE POLICY "wa_contacts_select" ON public.wa_contacts FOR SELECT USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    NOT public.seller_isolation_applies(organization_id)
    OR NOT public.contact_has_any_conversation(id)
    OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = wa_contacts.id)));
CREATE POLICY "wa_contacts_insert" ON public.wa_contacts FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "wa_contacts_update" ON public.wa_contacts FOR UPDATE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    NOT public.seller_isolation_applies(organization_id)
    OR NOT public.contact_has_any_conversation(id)
    OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = wa_contacts.id)));
CREATE POLICY "wa_contacts_delete" ON public.wa_contacts FOR DELETE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    NOT public.seller_isolation_applies(organization_id)
    OR NOT public.contact_has_any_conversation(id)
    OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = wa_contacts.id)));
