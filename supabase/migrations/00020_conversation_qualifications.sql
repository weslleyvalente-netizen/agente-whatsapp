CREATE TABLE conversation_qualifications (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,

  attendance_type text,
  product_interest text,
  product_model text,
  usage_purpose text,
  city text,
  urgency text,

  sale_amount numeric,
  credit_amount numeric,
  down_payment_amount numeric,
  bid_amount numeric,
  target_installment_amount numeric,
  term_months integer,

  cpf_encrypted text,
  cpf_hash text,
  birth_date date,
  has_driver_license boolean,
  driver_license_category text,

  summary text,
  next_action text,
  commercial_notes text,

  human_locked_fields text[] NOT NULL DEFAULT '{}',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversation_qualifications_contact ON conversation_qualifications(contact_id);
CREATE INDEX idx_conversation_qualifications_org ON conversation_qualifications(organization_id);

CREATE TRIGGER trg_conversation_qualifications_updated_at
  BEFORE UPDATE ON conversation_qualifications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE conversation_qualification_events (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_qualification_id uuid NOT NULL REFERENCES conversation_qualifications(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  changed_fields jsonb,
  changed_by_type text NOT NULL,
  changed_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversation_qualification_events_qualification
  ON conversation_qualification_events(conversation_qualification_id);

ALTER TABLE conversation_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_qualification_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_qualifications_select" ON conversation_qualifications
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "conversation_qualifications_insert" ON conversation_qualifications
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "conversation_qualifications_update" ON conversation_qualifications
  FOR UPDATE USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "conversation_qualifications_delete" ON conversation_qualifications
  FOR DELETE USING (organization_id IN (SELECT get_user_org_ids()));

CREATE POLICY "conversation_qualification_events_select" ON conversation_qualification_events
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "conversation_qualification_events_insert" ON conversation_qualification_events
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
