-- Monitor de saúde do provedor (UAZAPI): novos tipos de condição na tabela de alertas já existente (silent_connection_alerts).
--   provider_disconnected  UAZAPI informa a instância fora de 'connected';
--   provider_ahead         a UAZAPI tem mensagem de cliente mais nova que a última do CRM (webhook não entregou);
--   webhook_stalled        o CRM enviou mensagens e nenhum evento do webhook voltou desde então;
--   queue_backlog          fila de processamento de mensagens parada (instance_name = '*').
-- Só amplia a CHECK; nenhuma linha muda. O monitor fica desligado até settings.provider_health_monitor_mode = 'shadow' | 'on'.
--
-- Reverter (antes, resolver/remover alertas com os tipos novos):
--   ALTER TABLE public.silent_connection_alerts DROP CONSTRAINT silent_connection_alerts_kind_check;
--   ALTER TABLE public.silent_connection_alerts ADD CONSTRAINT silent_connection_alerts_kind_check
--     CHECK (kind IN ('silent_connection','monitor_blind','push_not_ready'));

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.silent_connection_alerts'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ~ 'kind' AND pg_get_constraintdef(oid) ~ 'silent_connection' LOOP
    EXECUTE format('ALTER TABLE public.silent_connection_alerts DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.silent_connection_alerts ADD CONSTRAINT silent_connection_alerts_kind_check CHECK (kind IN (
  'silent_connection', 'monitor_blind', 'push_not_ready',
  'provider_disconnected', 'provider_ahead', 'webhook_stalled', 'queue_backlog'));
