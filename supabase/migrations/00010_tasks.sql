CREATE TABLE tasks (
  id                 uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
  assignee_type      text CHECK (assignee_type IN ('human', 'ai')),
  assignee_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  type               text NOT NULL,
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  ai_summary         text,
  reason             text,
  priority           text NOT NULL DEFAULT 'normal'
                       CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled', 'rescheduled')),
  due_date           date NOT NULL,
  due_time           time,
  created_by_type    text NOT NULL CHECK (created_by_type IN ('ai', 'human')),
  created_by_id      uuid REFERENCES auth.users(id),
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_assignee_consistency CHECK (
    (assignee_type IS NULL AND assignee_id IS NULL) OR
    (assignee_type = 'ai' AND assignee_id IS NULL) OR
    (assignee_type = 'human' AND assignee_id IS NOT NULL)
  )
);

CREATE TABLE task_events (
  id                 uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  task_id            uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type         text NOT NULL,
  note               text,
  created_by_type    text NOT NULL CHECK (created_by_type IN ('ai', 'human')),
  created_by_id      uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_org_status_due ON tasks(organization_id, status, due_date);
CREATE INDEX idx_tasks_contact ON tasks(contact_id);
CREATE INDEX idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX idx_task_events_task ON task_events(task_id);

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
