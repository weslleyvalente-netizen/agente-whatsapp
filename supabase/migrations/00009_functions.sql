-- Vector similarity search for knowledge chunks
CREATE OR REPLACE FUNCTION search_knowledge_chunks(
  query_embedding vector(1536),
  match_count int DEFAULT 5,
  filter_organization_id uuid DEFAULT NULL,
  filter_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks kc
  JOIN knowledge_documents kd ON kd.id = kc.document_id
  WHERE
    (filter_organization_id IS NULL OR kc.organization_id = filter_organization_id)
    AND (filter_agent_id IS NULL OR kd.agent_id = filter_agent_id)
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Function to handle new user accepting invitation
CREATE OR REPLACE FUNCTION accept_invitation(invitation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  inv record;
BEGIN
  SELECT * INTO inv FROM organization_invitations
  WHERE id = invitation_id AND status = 'pending' AND expires_at > now();

  IF inv IS NULL THEN
    RAISE EXCEPTION 'Invalid or expired invitation';
  END IF;

  INSERT INTO organization_members (organization_id, user_id, role)
  VALUES (inv.organization_id, auth.uid(), inv.role);

  UPDATE organization_invitations SET status = 'accepted' WHERE id = invitation_id;
END;
$$;
