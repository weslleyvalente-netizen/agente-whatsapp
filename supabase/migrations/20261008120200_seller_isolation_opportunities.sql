-- supabase/migrations/20261008120200_seller_isolation_opportunities.sql
-- Isolamento por vendedor (RLS), parte 3: negócios, tarefas, eventos e contatos. Só restringe com seller_isolation_enabled = 'true'.

-- opportunities: dono = owner_id.
DROP POLICY IF EXISTS "opportunities_select" ON public.opportunities;
DROP POLICY IF EXISTS "opportunities_insert" ON public.opportunities;
DROP POLICY IF EXISTS "opportunities_update" ON public.opportunities;
DROP POLICY IF EXISTS "opportunities_delete" ON public.opportunities;
CREATE POLICY "opportunities_select" ON public.opportunities FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND (owner_id IS NULL OR owner_id = (SELECT auth.uid()) OR (organization_id, owner_id) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)));
CREATE POLICY "opportunities_insert" ON public.opportunities FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND (owner_id IS NULL OR owner_id = (SELECT auth.uid()) OR (organization_id, owner_id) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)));
CREATE POLICY "opportunities_update" ON public.opportunities FOR UPDATE
  USING (organization_id IN (SELECT get_user_org_ids()) AND (owner_id IS NULL OR owner_id = (SELECT auth.uid()) OR (organization_id, owner_id) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)))
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND (owner_id IS NULL OR owner_id = (SELECT auth.uid()) OR (organization_id, owner_id) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)));
CREATE POLICY "opportunities_delete" ON public.opportunities FOR DELETE
  USING (organization_id IN (SELECT get_user_org_ids()) AND (owner_id IS NULL OR owner_id = (SELECT auth.uid()) OR (organization_id, owner_id) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)));

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
         ELSE (assignee_id IS NULL OR assignee_id = (SELECT auth.uid()) OR (organization_id, assignee_id) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)) END));
CREATE POLICY "tasks_insert" ON public.tasks FOR INSERT WITH CHECK (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE (assignee_id IS NULL OR assignee_id = (SELECT auth.uid()) OR (organization_id, assignee_id) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)) END));
CREATE POLICY "tasks_update" ON public.tasks FOR UPDATE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE (assignee_id IS NULL OR assignee_id = (SELECT auth.uid()) OR (organization_id, assignee_id) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)) END))
  WITH CHECK (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE (assignee_id IS NULL OR assignee_id = (SELECT auth.uid()) OR (organization_id, assignee_id) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)) END));
CREATE POLICY "tasks_delete" ON public.tasks FOR DELETE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    CASE WHEN opportunity_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = tasks.opportunity_id)
         WHEN conversation_id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = tasks.conversation_id)
         ELSE (assignee_id IS NULL OR assignee_id = (SELECT auth.uid()) OR (organization_id, assignee_id) NOT IN (SELECT h.organization_id, h.user_id FROM public.seller_hidden_owners() h)) END));

-- task_events: via a tarefa.
DO $$
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

-- wa_contacts: visível se o isolamento não se aplica, ou o contato não tem vínculo nenhum (conversa, negócio ou tarefa; função que ignora RLS),
-- ou alguma conversa, negócio ou tarefa dele é visível ao usuário (as subconsultas herdam o RLS dessas tabelas).
DROP POLICY IF EXISTS "wa_contacts_select" ON public.wa_contacts;
DROP POLICY IF EXISTS "wa_contacts_insert" ON public.wa_contacts;
DROP POLICY IF EXISTS "wa_contacts_update" ON public.wa_contacts;
DROP POLICY IF EXISTS "wa_contacts_delete" ON public.wa_contacts;
CREATE POLICY "wa_contacts_select" ON public.wa_contacts FOR SELECT USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    organization_id NOT IN (SELECT public.seller_isolation_org_ids())
    OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = wa_contacts.id)
    OR EXISTS (SELECT 1 FROM public.opportunities o WHERE o.contact_id = wa_contacts.id)
    OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.contact_id = wa_contacts.id)
    OR NOT public.contact_has_any_link(id)));
CREATE POLICY "wa_contacts_insert" ON public.wa_contacts FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "wa_contacts_update" ON public.wa_contacts FOR UPDATE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    organization_id NOT IN (SELECT public.seller_isolation_org_ids())
    OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = wa_contacts.id)
    OR EXISTS (SELECT 1 FROM public.opportunities o WHERE o.contact_id = wa_contacts.id)
    OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.contact_id = wa_contacts.id)
    OR NOT public.contact_has_any_link(id)));
CREATE POLICY "wa_contacts_delete" ON public.wa_contacts FOR DELETE USING (
  organization_id IN (SELECT get_user_org_ids()) AND (
    organization_id NOT IN (SELECT public.seller_isolation_org_ids())
    OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = wa_contacts.id)
    OR EXISTS (SELECT 1 FROM public.opportunities o WHERE o.contact_id = wa_contacts.id)
    OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.contact_id = wa_contacts.id)
    OR NOT public.contact_has_any_link(id)));
