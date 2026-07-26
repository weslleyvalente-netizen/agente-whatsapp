ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_playground_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_playground_messages ENABLE ROW LEVEL SECURITY;

-- Append-only: no UPDATE/DELETE policy exists for agent_versions at all,
-- so no client (present or future, admin or browser) can alter or erase
-- a published version through PostgREST/Supabase.
CREATE POLICY "agent_versions_select" ON agent_versions
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "agent_versions_insert" ON agent_versions
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'agent_configs', 'agent_playground_sessions', 'agent_playground_messages'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY "%1$s_select" ON %1$s FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_insert" ON %1$s FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_update" ON %1$s FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_delete" ON %1$s FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()))',
      tbl
    );
  END LOOP;
END $$;
