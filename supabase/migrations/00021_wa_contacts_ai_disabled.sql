ALTER TABLE wa_contacts
  ADD COLUMN ai_disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_disabled_at timestamptz,
  ADD COLUMN ai_disabled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
