CREATE TABLE agent_configs (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  agent_id uuid NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  base_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
  identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  personality jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  knowledge jsonb NOT NULL DEFAULT '{}'::jsonb,
  playbook jsonb NOT NULL DEFAULT '{}'::jsonb,
  tools_config jsonb NOT NULL DEFAULT '{"search_knowledge": true, "search_faq": true, "send_catalog_photo": true, "create_task": true}'::jsonb,
  model_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

CREATE TRIGGER trg_agent_configs_updated_at
  BEFORE UPDATE ON agent_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
