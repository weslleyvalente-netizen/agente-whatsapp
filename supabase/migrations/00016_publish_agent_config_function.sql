CREATE OR REPLACE FUNCTION publish_agent_config(
  p_agent_id uuid,
  p_changelog text,
  p_compiled_prompt text,
  p_config_snapshot jsonb,
  p_model_settings jsonb,
  p_tools_config jsonb,
  p_published_by uuid
) RETURNS agent_versions
LANGUAGE plpgsql
AS $$
DECLARE
  v_version integer;
  v_row agent_versions;
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM agent_versions WHERE agent_id = p_agent_id;

  UPDATE agents SET
    system_prompt = p_compiled_prompt,
    model = p_model_settings->>'model',
    provider = p_model_settings->>'provider',
    temperature = (p_model_settings->>'temperature')::real,
    max_tokens = (p_model_settings->>'max_tokens')::integer,
    tools_config = p_tools_config
  WHERE id = p_agent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent % not found', p_agent_id;
  END IF;

  INSERT INTO agent_versions (
    agent_id, organization_id, version, changelog, config_snapshot,
    compiled_system_prompt, model_settings, tools_config, published_by
  )
  SELECT p_agent_id, organization_id, v_version, p_changelog, p_config_snapshot,
         p_compiled_prompt, p_model_settings, p_tools_config, p_published_by
  FROM agents WHERE id = p_agent_id
  RETURNING * INTO v_row;

  UPDATE agent_configs SET base_version_id = v_row.id WHERE agent_id = p_agent_id;

  RETURN v_row;
END;
$$;
