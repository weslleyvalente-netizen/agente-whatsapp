-- Allow the ElevenLabs TTS provider in the organization_secrets vault,
-- alongside the existing LLM providers (openai, anthropic, google).
ALTER TABLE organization_secrets
  DROP CONSTRAINT organization_secrets_provider_check;

ALTER TABLE organization_secrets
  ADD CONSTRAINT organization_secrets_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'google', 'elevenlabs'));
