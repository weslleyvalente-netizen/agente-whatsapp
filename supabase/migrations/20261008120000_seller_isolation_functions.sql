-- supabase/migrations/20261008120000_seller_isolation_functions.sql
-- Isolamento por vendedor (RLS), parte 1: índices e funções de apoio. Sem efeito sozinho: as políticas vêm nas próximas migrations
-- e só restringem quando organizations.settings.seller_isolation_enabled = 'true'.

CREATE INDEX IF NOT EXISTS idx_conversations_assigned_to ON public.conversations (assigned_to);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON public.conversations (contact_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_owner ON public.opportunities (owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON public.tasks (assignee_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_contact ON public.opportunities (contact_id);
CREATE INDEX IF NOT EXISTS idx_tasks_contact ON public.tasks (contact_id);

-- Organizações do usuário logado onde o isolamento se aplica: interruptor ligado, usuário NÃO é gestor e a organização tem vendedores.
-- Nunca devolve organização de que o usuário não é membro (sem vazamento entre organizações); anon (auth.uid() nulo) recebe vazio.
-- Conjunto constante dentro da consulta: as políticas o usam como subconsulta (InitPlan), não por linha.
CREATE OR REPLACE FUNCTION public.seller_isolation_org_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id
    FROM public.organizations o
    JOIN public.organization_members me ON me.organization_id = o.id AND me.user_id = auth.uid()
   WHERE o.settings->>'seller_isolation_enabled' = 'true'
     AND me.role NOT IN ('owner','admin')
     AND EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = o.id)
$$;

-- Pares (organização, usuário) de vendedores cujas linhas ficam INVISÍVEIS ao usuário logado: vendedores das organizações onde
-- o isolamento se aplica a ele. Também constante dentro da consulta.
CREATE OR REPLACE FUNCTION public.seller_hidden_owners()
RETURNS TABLE (organization_id uuid, user_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.organization_id, r.user_id
    FROM public.sales_reps r
   WHERE r.organization_id IN (SELECT public.seller_isolation_org_ids())
$$;

-- Verdadeiro só quando o isolamento se aplica ao usuário logado na organização p_org.
CREATE OR REPLACE FUNCTION public.seller_isolation_applies(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.seller_isolation_org_ids() i(id) WHERE i.id = p_org)
$$;

-- Uma linha com dono p_owner é visível, salvo quando o dono é OUTRO vendedor e o isolamento se aplica ao usuário.
-- (As políticas usam a forma inline equivalente, que o planejador avalia como InitPlan; esta função é um invólucro fino.)
CREATE OR REPLACE FUNCTION public.seller_can_see(p_org uuid, p_owner uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_owner IS NULL
      OR p_owner = auth.uid()
      OR NOT EXISTS (SELECT 1 FROM public.seller_hidden_owners() h WHERE h.organization_id = p_org AND h.user_id = p_owner)
$$;

-- Existe alguma conversa do contato? Ignora RLS de propósito: uma subconsulta comum dentro de política só enxergaria as conversas
-- visíveis e faria um contato cujas conversas são todas de outro vendedor parecer "sem conversa" (vazamento).
-- Contato de organização de que o usuário não é membro: falso.
CREATE OR REPLACE FUNCTION public.contact_has_any_conversation(p_contact uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.wa_contacts k
     WHERE k.id = p_contact AND k.organization_id IN (SELECT public.get_user_org_ids())
       AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = p_contact))
$$;

-- Existe algum vínculo do contato (conversa, negócio ou tarefa), visível ou não? Ignora RLS; falso fora das organizações do usuário.
CREATE OR REPLACE FUNCTION public.contact_has_any_link(p_contact uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.wa_contacts k WHERE k.id = p_contact AND k.organization_id IN (SELECT public.get_user_org_ids()))
     AND (EXISTS (SELECT 1 FROM public.conversations c WHERE c.contact_id = p_contact)
       OR EXISTS (SELECT 1 FROM public.opportunities o WHERE o.contact_id = p_contact)
       OR EXISTS (SELECT 1 FROM public.tasks t WHERE t.contact_id = p_contact))
$$;

-- Seguras para anon: sem login (auth.uid() nulo) tudo devolve vazio/falso; o Realtime avalia as políticas como anon antes do JWT.
REVOKE ALL ON FUNCTION public.seller_isolation_org_ids(), public.seller_hidden_owners(), public.seller_isolation_applies(uuid), public.seller_can_see(uuid, uuid),
  public.contact_has_any_conversation(uuid), public.contact_has_any_link(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seller_isolation_org_ids(), public.seller_hidden_owners(), public.seller_isolation_applies(uuid), public.seller_can_see(uuid, uuid),
  public.contact_has_any_conversation(uuid), public.contact_has_any_link(uuid) TO anon, authenticated, service_role;
