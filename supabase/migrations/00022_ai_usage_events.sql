-- Tracks token usage for LLM calls that don't produce a row in `messages`
-- (Playground and Trainer conversations, per-image description calls, and
-- config-import suggestions), so the cost dashboard can account for all
-- Anthropic spend, not just real customer conversations.
CREATE TABLE ai_usage_events (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('playground', 'trainer', 'image_description', 'import_suggestion')),
  model text NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_usage_events_org_date ON ai_usage_events(organization_id, created_at);

ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_usage_events_select" ON ai_usage_events FOR SELECT USING (organization_id IN (SELECT get_user_org_ids()));
CREATE POLICY "ai_usage_events_insert" ON ai_usage_events FOR INSERT WITH CHECK (organization_id IN (SELECT get_user_org_ids()));
