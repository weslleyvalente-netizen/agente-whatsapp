-- Notificações push (PWA) para vendedores. Sem efeito enquanto organizations.settings.push_notifications_enabled não for true.

CREATE TABLE public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
-- O usuário só vê e gerencia as próprias assinaturas; a service role (API/worker) ignora a RLS.
CREATE POLICY "push_subscriptions_own_select" ON public.push_subscriptions FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "push_subscriptions_own_insert" ON public.push_subscriptions FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "push_subscriptions_own_update" ON public.push_subscriptions FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "push_subscriptions_own_delete" ON public.push_subscriptions FOR DELETE USING (user_id = auth.uid());

-- Idempotência dos gatilhos: uma chave por evento notificado. Só a service role acessa (RLS ligada, sem policies).
CREATE TABLE public.push_notification_log (
  dedupe_key text PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_notification_log_created ON public.push_notification_log (created_at);
ALTER TABLE public.push_notification_log ENABLE ROW LEVEL SECURITY;
