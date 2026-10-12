-- Registro de ligações do vendedor (comparação "mensagem antes de ligar" x "só ligar").
CREATE TABLE public.sales_call_logs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  opportunity_id     uuid NOT NULL REFERENCES public.opportunities(id) ON DELETE CASCADE,
  contact_id         uuid REFERENCES public.wa_contacts(id) ON DELETE SET NULL,
  rep_user_id        uuid NOT NULL,
  strategy           text NOT NULL CHECK (strategy IN ('message_first', 'call_only')),
  suggested_strategy text CHECK (suggested_strategy IN ('message_first', 'call_only')),
  outcome            text NOT NULL CHECK (outcome IN ('answered', 'no_answer', 'callback', 'no_interest', 'wrong_number')),
  note               text,
  called_at          timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sales_call_logs_org_called_at ON public.sales_call_logs(organization_id, called_at);
CREATE INDEX idx_sales_call_logs_opportunity ON public.sales_call_logs(opportunity_id);

ALTER TABLE public.sales_call_logs ENABLE ROW LEVEL SECURITY;

-- Mesmo padrão de opportunity_events: a visibilidade do negócio (já filtrada pelo RLS de opportunities) decide.
-- Sem UPDATE/DELETE para usuários (só o service_role, que ignora RLS).
CREATE POLICY "sales_call_logs_select" ON public.sales_call_logs FOR SELECT
  USING (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = sales_call_logs.opportunity_id));
CREATE POLICY "sales_call_logs_insert" ON public.sales_call_logs FOR INSERT
  WITH CHECK (organization_id IN (SELECT get_user_org_ids()) AND EXISTS (SELECT 1 FROM public.opportunities o WHERE o.id = sales_call_logs.opportunity_id));
