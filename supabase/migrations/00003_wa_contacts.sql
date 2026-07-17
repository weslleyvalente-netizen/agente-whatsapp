CREATE TABLE wa_contacts (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone text NOT NULL,
  name text,
  photo_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, phone)
);

CREATE INDEX idx_wa_contacts_org_phone ON wa_contacts(organization_id, phone);

CREATE TRIGGER trg_wa_contacts_updated_at
  BEFORE UPDATE ON wa_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
