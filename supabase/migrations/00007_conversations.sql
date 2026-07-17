CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  evolution_instance_id uuid NOT NULL REFERENCES evolution_instances(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'resolved', 'closed')),
  is_human_takeover boolean NOT NULL DEFAULT false,
  human_takeover_at timestamptz,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  tags text[] NOT NULL DEFAULT '{}',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  evolution_message_id text,
  role text NOT NULL CHECK (role IN ('contact', 'agent', 'human_agent', 'system')),
  content text NOT NULL DEFAULT '',
  media_url text,
  media_type text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_notes (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_metrics (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_response_time_ms integer,
  resolution_time_ms integer,
  message_count integer NOT NULL DEFAULT 0,
  human_messages_count integer NOT NULL DEFAULT 0,
  satisfaction_rating integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_conversations_org_last_msg ON conversations(organization_id, last_message_at DESC);
CREATE INDEX idx_conversations_org_status ON conversations(organization_id, status);
CREATE INDEX idx_conversations_contact ON conversations(contact_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE UNIQUE INDEX idx_messages_evolution_id ON messages(evolution_message_id) WHERE evolution_message_id IS NOT NULL;
CREATE INDEX idx_conversation_notes_org ON conversation_notes(organization_id);
CREATE INDEX idx_conversation_metrics_org ON conversation_metrics(organization_id);

-- Triggers
CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_conversation_notes_updated_at
  BEFORE UPDATE ON conversation_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
