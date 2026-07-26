CREATE TABLE agent_playground_sessions (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_playground_messages (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  session_id uuid NOT NULL REFERENCES agent_playground_sessions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_playground_sessions_agent ON agent_playground_sessions(agent_id, created_at DESC);
CREATE INDEX idx_playground_messages_session ON agent_playground_messages(session_id, created_at);
