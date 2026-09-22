CREATE TABLE opportunities (
  id                          uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id                  uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,

  operation                   text NOT NULL CHECK (operation IN
                                 ('vehicle_sale', 'consortium', 'financing', 'libera_cred', 'contemplated_letter')),
  stage                       text NOT NULL,
  status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),

  product                     text,
  product_model               text,

  initial_operation           text NOT NULL,

  sale_amount                 numeric,
  credit_amount                numeric,
  down_payment_amount          numeric,
  bid_amount                    numeric,
  target_installment_amount     numeric,
  term_months                   integer,

  usage_purpose                text,
  urgency                       text,
  main_objection                text,
  commercial_notes              text,

  owner_id                      uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  next_action                   text,
  next_action_due_date          date,

  waiting_on                    text CHECK (waiting_on IN ('customer', 'team', 'bank_or_admin', 'scheduled_date')),
  waiting_on_until              date,

  last_interaction_at           timestamptz,
  last_progress_at              timestamptz,

  lost_reason                   text,
  resume_date                   date,

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_opportunities_org_status ON opportunities(organization_id, status);
CREATE INDEX idx_opportunities_contact ON opportunities(contact_id);
CREATE INDEX idx_opportunities_operation_stage ON opportunities(operation, stage);
CREATE INDEX idx_opportunities_owner ON opportunities(owner_id);
CREATE INDEX idx_opportunities_waiting_on ON opportunities(waiting_on) WHERE status = 'open';

CREATE TRIGGER trg_opportunities_updated_at
  BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE opportunity_events (
  id                 uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id     uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  event_type         text NOT NULL CHECK (event_type IN (
                        'created', 'stage_changed', 'operation_changed',
                        'won', 'lost', 'reopened', 'owner_changed',
                        'next_action_updated', 'waiting_on_changed'
                      )),
  previous_value     jsonb,
  new_value          jsonb,
  evidence           text NOT NULL,
  changed_by_type    text NOT NULL CHECK (changed_by_type IN ('ai', 'human', 'system')),
  changed_by_id      uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_opportunity_events_opportunity ON opportunity_events(opportunity_id, created_at);

ALTER TABLE tasks
  ADD COLUMN opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL;

CREATE INDEX idx_tasks_opportunity ON tasks(opportunity_id);

ALTER TABLE conversation_qualifications
  ADD COLUMN opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL;
