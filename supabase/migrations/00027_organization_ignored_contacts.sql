CREATE TABLE organization_ignored_contacts (
  id                 uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone              text NOT NULL,
  label              text,
  retention_mode     text NOT NULL DEFAULT 'no_store' CHECK (retention_mode IN ('no_store', 'minimal_record')),
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, phone)
);

CREATE INDEX idx_organization_ignored_contacts_org_phone ON organization_ignored_contacts(organization_id, phone);

ALTER TABLE organization_ignored_contacts ENABLE ROW LEVEL SECURITY;

-- Same restriction as organization_secrets: only owner/admin can see or
-- manage the ignored-contacts list, since it controls whether a number's
-- traffic is dropped at the webhook.
CREATE POLICY "ignored_contacts_select" ON organization_ignored_contacts
  FOR SELECT USING (organization_id IN (
    SELECT organization_id FROM organization_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ));

CREATE POLICY "ignored_contacts_all" ON organization_ignored_contacts
  FOR ALL USING (organization_id IN (
    SELECT organization_id FROM organization_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
  ));
