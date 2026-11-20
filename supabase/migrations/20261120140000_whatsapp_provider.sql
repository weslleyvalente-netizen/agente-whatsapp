-- Provedor de WhatsApp por instância: 'evolution' (padrão, comportamento de sempre) ou 'uazapi'.
-- provider_token_encrypted: token da instância na UAZAPI, cifrado pela aplicação (AES-256-GCM, chave derivada do UAZAPI_ADMIN_TOKEN).
-- Só acrescenta colunas; o código novo funciona antes desta migração (ausente = 'evolution').
-- Reverter: ALTER TABLE public.evolution_instances DROP COLUMN provider_token_encrypted, DROP COLUMN provider;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.evolution_instances ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'evolution';
ALTER TABLE public.evolution_instances ADD COLUMN IF NOT EXISTS provider_token_encrypted text;
ALTER TABLE public.evolution_instances DROP CONSTRAINT IF EXISTS evolution_instances_provider_check;
ALTER TABLE public.evolution_instances ADD CONSTRAINT evolution_instances_provider_check CHECK (provider IN ('evolution', 'uazapi'));
