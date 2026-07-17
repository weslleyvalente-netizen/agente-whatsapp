CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  system_prompt text NOT NULL,
  model text NOT NULL DEFAULT 'gpt-4o-mini',
  provider text NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai', 'anthropic', 'google')),
  temperature real NOT NULL DEFAULT 0.7 CHECK (temperature >= 0 AND temperature <= 2),
  max_tokens integer NOT NULL DEFAULT 1024 CHECK (max_tokens > 0 AND max_tokens <= 16384),
  tools_config jsonb NOT NULL DEFAULT '{"search_knowledge": true, "search_faq": true}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agents_org ON agents(organization_id);

CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
