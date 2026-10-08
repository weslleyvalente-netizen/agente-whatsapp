-- Isolamento por vendedor (RLS), parte 4: histórico de distribuição. Com o isolamento aplicado ao usuário, o vendedor só lê as
-- atribuições do próprio sales_reps; gestores e interruptor desligado seguem como hoje (toda a organização).
DROP POLICY IF EXISTS "lead_assignments_select" ON public.lead_assignments;
CREATE POLICY "lead_assignments_select" ON public.lead_assignments FOR SELECT USING (
  organization_id IN (SELECT public.get_user_org_ids())
  AND (
    organization_id NOT IN (SELECT public.seller_isolation_org_ids())
    OR rep_id IN (SELECT r.id FROM public.sales_reps r WHERE r.user_id = (SELECT auth.uid()))
  )
);
