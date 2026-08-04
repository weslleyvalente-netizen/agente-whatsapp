CREATE TABLE conversation_reads (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX idx_conversation_reads_user ON conversation_reads(user_id);

ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;

-- Each attendant can only ever see their own read state.
CREATE POLICY "conversation_reads_select" ON conversation_reads
  FOR SELECT USING (user_id = auth.uid());

-- Insert (first time a user opens a conversation): must be marking their
-- own row, for a conversation in an org they belong to.
CREATE POLICY "conversation_reads_insert" ON conversation_reads
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND conversation_id IN (
      SELECT id FROM conversations WHERE organization_id IN (SELECT get_user_org_ids())
    )
  );

-- Update (re-opening, or a new message arriving while open): must be marking
-- their own row, for a conversation in an org they belong to. Explicit WITH CHECK
-- prevents rewriting conversation_id to an out-of-org value.
CREATE POLICY "conversation_reads_update" ON conversation_reads
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND conversation_id IN (
      SELECT id FROM conversations WHERE organization_id IN (SELECT get_user_org_ids())
    )
  );
