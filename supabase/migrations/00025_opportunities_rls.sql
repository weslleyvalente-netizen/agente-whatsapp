ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "opportunities_select" ON opportunities
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "opportunities_insert" ON opportunities
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "opportunities_update" ON opportunities
  FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "opportunities_delete" ON opportunities
  FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()));

CREATE POLICY "opportunity_events_select" ON opportunity_events
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "opportunity_events_insert" ON opportunity_events
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
