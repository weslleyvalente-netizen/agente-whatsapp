CREATE TABLE agent_versions (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version integer NOT NULL,
  changelog text NOT NULL DEFAULT '',
  config_snapshot jsonb NOT NULL,
  compiled_system_prompt text NOT NULL,
  model_settings jsonb NOT NULL,
  tools_config jsonb NOT NULL,
  published_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);

CREATE INDEX idx_agent_versions_agent ON agent_versions(agent_id, version DESC);
