ALTER TABLE tasks
  ADD COLUMN followup_suggested_message text,
  ADD COLUMN followup_suggestion_generated_at timestamptz,
  ADD COLUMN followup_regeneration_count integer NOT NULL DEFAULT 0,
  -- Points to a `messages` row with evolution_message_id still NULL while a
  -- follow-up send is in flight/unconfirmed. NULL means no pending send.
  -- See task-followup.service.ts's confirmation flow.
  ADD COLUMN followup_pending_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE task_followup_sends (
  id                          uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  instance_id                 uuid NOT NULL REFERENCES evolution_instances(id) ON DELETE CASCADE,
  task_id                     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  conversation_id             uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id                  uuid REFERENCES messages(id) ON DELETE SET NULL,

  suggestion_status           text NOT NULL CHECK (suggestion_status IN ('original', 'edited')),
  regenerations_before_send   integer NOT NULL DEFAULT 0,

  sent_by_type                text NOT NULL CHECK (sent_by_type IN ('human', 'system')),
  sent_by_id                  uuid,

  sent_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_followup_sends_instance_sent_at
  ON task_followup_sends(instance_id, sent_at DESC);
CREATE INDEX idx_task_followup_sends_org_sent_at
  ON task_followup_sends(organization_id, sent_at DESC);

ALTER TABLE task_followup_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_followup_sends_select" ON task_followup_sends
  FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "task_followup_sends_insert" ON task_followup_sends
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
