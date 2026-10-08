// packages/database/src/sql/rls-fixture.ts
// Esquema mínimo das tabelas que a tela lê direto, com as políticas "por organização" de hoje (00008, 00011, 00018, 00020, 00025, 00028).
export const RLS_FIXTURE_SQL = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), settings jsonb NOT NULL DEFAULT '{}');
CREATE TABLE public.organization_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), user_id uuid NOT NULL, role text NOT NULL DEFAULT 'agent');
CREATE TABLE public.sales_reps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), user_id uuid NOT NULL, display_name text NOT NULL DEFAULT 'x', rotation_order integer NOT NULL DEFAULT 1);
CREATE TABLE public.wa_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), name text);
CREATE TABLE public.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id) ON DELETE CASCADE, assigned_to uuid, status text NOT NULL DEFAULT 'open');
CREATE TABLE public.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE, role text NOT NULL DEFAULT 'contact', content text NOT NULL DEFAULT '');
CREATE TABLE public.conversation_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE, user_id uuid NOT NULL, content text NOT NULL DEFAULT '');
CREATE TABLE public.conversation_reads (conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE, user_id uuid NOT NULL, last_read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (conversation_id, user_id));
CREATE TABLE public.conversation_qualifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE);
CREATE TABLE public.conversation_qualification_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_qualification_id uuid NOT NULL REFERENCES public.conversation_qualifications(id) ON DELETE CASCADE, event_type text NOT NULL DEFAULT 'x');
CREATE TABLE public.handoff_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE, trigger_type text NOT NULL DEFAULT 'request_human');
CREATE TABLE public.opportunities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id) ON DELETE CASCADE, owner_id uuid, status text NOT NULL DEFAULT 'open');
CREATE TABLE public.opportunity_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), opportunity_id uuid NOT NULL REFERENCES public.opportunities(id) ON DELETE CASCADE, event_type text NOT NULL DEFAULT 'created');
CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id) ON DELETE CASCADE, conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL, opportunity_id uuid REFERENCES public.opportunities(id) ON DELETE SET NULL, assignee_id uuid, status text NOT NULL DEFAULT 'pending');
CREATE TABLE public.task_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE, event_type text NOT NULL DEFAULT 'created');
CREATE TABLE public.lead_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id), rep_id uuid REFERENCES public.sales_reps(id), status text NOT NULL DEFAULT 'accepted');
CREATE INDEX idx_messages_conversation ON public.messages(conversation_id);

CREATE FUNCTION public.get_user_org_ids() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE AS $$ SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid() $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','organization_members','sales_reps','wa_contacts','conversations','messages','conversation_notes','conversation_reads','conversation_qualifications','conversation_qualification_events','handoff_events','opportunities','opportunity_events','tasks','task_events','lead_assignments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  -- Políticas "por organização" de hoje (00008 loop, 00011, 00020, 00025, 00028).
  FOREACH t IN ARRAY ARRAY['wa_contacts','conversations','messages','conversation_notes','tasks','task_events'] LOOP
    EXECUTE format('CREATE POLICY "%1$s_select" ON public.%1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON public.%1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON public.%1$s FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_delete" ON public.%1$s FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['conversation_qualifications','opportunities'] LOOP
    EXECUTE format('CREATE POLICY "%1$s_select" ON public.%1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON public.%1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON public.%1$s FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_delete" ON public.%1$s FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['conversation_qualification_events','opportunity_events'] LOOP
    EXECUTE format('CREATE POLICY "%1$s_select" ON public.%1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON public.%1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))', t);
  END LOOP;
  EXECUTE 'CREATE POLICY "handoff_events_select" ON public.handoff_events FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "handoff_events_insert" ON public.handoff_events FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "handoff_events_update" ON public.handoff_events FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "lead_assignments_select" ON public.lead_assignments FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "organizations_select" ON public.organizations FOR SELECT USING (id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "org_members_select" ON public.organization_members FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))';
  EXECUTE 'CREATE POLICY "sales_reps_select" ON public.sales_reps FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))';
  -- conversation_reads (00018): só o próprio marcador; escrita só em conversa de organização do usuário.
  EXECUTE 'CREATE POLICY "conversation_reads_select" ON public.conversation_reads FOR SELECT USING (user_id = auth.uid())';
  EXECUTE 'CREATE POLICY "conversation_reads_insert" ON public.conversation_reads FOR INSERT WITH CHECK (user_id = auth.uid() AND conversation_id IN (SELECT id FROM public.conversations WHERE organization_id IN (SELECT get_user_org_ids())))';
  EXECUTE 'CREATE POLICY "conversation_reads_update" ON public.conversation_reads FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid() AND conversation_id IN (SELECT id FROM public.conversations WHERE organization_id IN (SELECT get_user_org_ids())))';
END $$;

GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth TO authenticated, anon, service_role;
`;
