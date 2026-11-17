-- Alerta de "conexão muda" (Evolution 'open' sem receber mensagens de clientes). PROPOSTA: não aplicada em produção.
-- Só cria uma tabela de estado/evidência (um alerta aberto por instância). Não altera nenhuma tabela existente.
-- Idempotente. Rollback: DROP TABLE IF EXISTS public.silent_connection_alerts;
CREATE TABLE IF NOT EXISTS public.silent_connection_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  instance_name text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz NOT NULL DEFAULT now(),
  notify_count integer NOT NULL DEFAULT 1,
  resolved_at timestamptz,
  -- Só estados e horários (UTC) e números agregados; nunca conteúdo de mensagem, telefone ou chave.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- No máximo um alerta ABERTO por instância (evita duplicar alerta mesmo com dois processos da API).
CREATE UNIQUE INDEX IF NOT EXISTS silent_connection_alerts_one_open ON public.silent_connection_alerts (organization_id, instance_name) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS silent_connection_alerts_org_time ON public.silent_connection_alerts (organization_id, opened_at DESC);
ALTER TABLE public.silent_connection_alerts ENABLE ROW LEVEL SECURITY; -- sem políticas: só o service role (API) lê e grava
