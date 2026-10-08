-- supabase/migrations/20261008120000_seller_isolation_functions.sql
-- Isolamento por vendedor (RLS), parte 1: índices e funções de apoio. Sem efeito sozinho: as políticas vêm nas próximas migrations
-- e só restringem quando organizations.settings.seller_isolation_enabled = 'true'.

CREATE INDEX IF NOT EXISTS idx_conversations_assigned_to ON public.conversations (assigned_to);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON public.conversations (contact_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_owner ON public.opportunities (owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON public.tasks (assignee_id);

-- Verdadeiro só quando: o interruptor da organização está ligado, o usuário não é gestor e a organização tem vendedores.
CREATE OR REPLACE FUNCTION public.seller_isolation_applies(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT o.settings->>'seller_isolation_enabled' = 'true' FROM public.organizations o WHERE o.id = p_org), false)
     AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = p_org AND m.user_id = auth.uid() AND m.role IN ('owner','admin'))
     AND EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = p_org)
$$;

-- Uma linha com dono p_owner é visível, salvo quando o dono é OUTRO vendedor e o isolamento se aplica ao usuário.
CREATE OR REPLACE FUNCTION public.seller_can_see(p_org uuid, p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_owner IS NULL
      OR p_owner = auth.uid()
      OR NOT public.seller_isolation_applies(p_org)
      OR NOT EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = p_org AND r.user_id = p_owner)
$$;

-- Existe alguma conversa do contato? Ignora RLS de propósito: uma subconsulta comum dentro de política só enxergaria as conversas
-- visíveis e faria um contato cujas conversas são todas de outro vendedor parecer "sem conversa" (vazamento).
CREATE OR REPLACE FUNCTION public.contact_has_any_conversation(p_contact uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.conversations WHERE contact_id = p_contact)
$$;

REVOKE ALL ON FUNCTION public.seller_isolation_applies(uuid), public.seller_can_see(uuid, uuid), public.contact_has_any_conversation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seller_isolation_applies(uuid), public.seller_can_see(uuid, uuid), public.contact_has_any_conversation(uuid) TO authenticated, service_role;
