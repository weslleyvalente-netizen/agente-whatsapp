-- Monitoramento do Evolution: uma linha por instância a cada observação periódica (a cada 5 min, só com
-- organizations.settings.evolution_monitor_enabled = true; sem a chave ligada a tabela fica vazia).
-- Guarda SOMENTE estados e horários (UTC): nunca conteúdo de mensagem, telefone, chave ou resposta bruta da Evolution.
-- LIMITAÇÃO: é observação periódica. A Evolution só expõe a ÚLTIMA desconexão (disconnection_at / código), não o histórico:
-- duas quedas entre observações aparecem como uma só (a mais recente). disconnect_since_previous marca quando esse
-- horário mudou desde a observação anterior, o que revela reconexões rápidas entre consultas.
-- Só a service role acessa (RLS ligada, sem policies). A API apaga linhas com mais de 30 dias.
-- Idempotente: pode ser reaplicada depois de uma aplicação parcial.

CREATE TABLE IF NOT EXISTS public.evolution_connection_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  instance_name text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  -- Estado devolvido pela Evolution (connectionState): open | connecting | close, ou null se a consulta falhou.
  evolution_state text,
  query_ok boolean NOT NULL,
  query_error_kind text,
  -- Última desconexão que a Evolution registra (instância, não histórico) e o código (ex.: 401 = sessão encerrada).
  disconnection_at timestamptz,
  disconnection_reason_code integer,
  disconnection_error_kind text,
  disconnect_since_previous boolean,
  -- Última mensagem de cliente gravada no CRM para a instância (messages.created_at; mensagens recuperadas mantêm o horário original).
  last_crm_message_at timestamptz,
  -- Última mensagem recebida que a Evolution armazenou (messageTimestamp); separada para localizar onde o recebimento parou.
  last_evolution_message_at timestamptz,
  evolution_message_error_kind text
);
CREATE INDEX IF NOT EXISTS evolution_connection_observations_org_instance_time
  ON public.evolution_connection_observations (organization_id, instance_name, observed_at DESC);
ALTER TABLE public.evolution_connection_observations ENABLE ROW LEVEL SECURITY;
-- A limpeza global (observed_at < agora - 30 dias) não filtra por organização.
CREATE INDEX IF NOT EXISTS evolution_connection_observations_observed_at
  ON public.evolution_connection_observations (observed_at);
