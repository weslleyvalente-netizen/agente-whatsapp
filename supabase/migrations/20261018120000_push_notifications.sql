-- Notificações push (PWA) para vendedores. Sem efeito enquanto organizations.settings.push_notifications_enabled não for true.
-- Idempotente: pode ser reaplicada depois de uma aplicação parcial.

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
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
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON public.push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_org_user ON public.push_subscriptions (organization_id, user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
-- O usuário só vê e gerencia as próprias assinaturas, em organizações das quais é membro; a service role (API/worker) ignora a RLS.
DROP POLICY IF EXISTS "push_subscriptions_own_select" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_own_select" ON public.push_subscriptions FOR SELECT USING (user_id = (select auth.uid()));
DROP POLICY IF EXISTS "push_subscriptions_own_insert" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_own_insert" ON public.push_subscriptions FOR INSERT
  WITH CHECK (user_id = (select auth.uid()) AND organization_id IN (SELECT public.get_user_org_ids()));
DROP POLICY IF EXISTS "push_subscriptions_own_update" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_own_update" ON public.push_subscriptions FOR UPDATE
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()) AND organization_id IN (SELECT public.get_user_org_ids()));
DROP POLICY IF EXISTS "push_subscriptions_own_delete" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_own_delete" ON public.push_subscriptions FOR DELETE USING (user_id = (select auth.uid()));

-- Quem sai da organização deixa de receber push dela.
CREATE OR REPLACE FUNCTION public.delete_push_subscriptions_on_member_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.push_subscriptions WHERE organization_id = OLD.organization_id AND user_id = OLD.user_id;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_push_subscriptions_member_removal ON public.organization_members;
CREATE TRIGGER trg_push_subscriptions_member_removal AFTER DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.delete_push_subscriptions_on_member_removal();

-- Idempotência dos gatilhos: uma chave por evento notificado. Só a service role acessa (RLS ligada, sem policies).
-- O worker apaga linhas com mais de 7 dias a cada hora.
CREATE TABLE IF NOT EXISTS public.push_notification_log (
  dedupe_key text PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_notification_log_created ON public.push_notification_log (created_at);
ALTER TABLE public.push_notification_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_notification_log FROM anon, authenticated;
