CREATE TABLE evolution_instances (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  instance_name text NOT NULL,
  instance_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'connecting')),
  phone_number text,
  webhook_url text,
  active_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_evolution_instances_org ON evolution_instances(organization_id);
CREATE INDEX idx_evolution_instances_instance_id ON evolution_instances(instance_id);

CREATE TRIGGER trg_evolution_instances_updated_at
  BEFORE UPDATE ON evolution_instances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
