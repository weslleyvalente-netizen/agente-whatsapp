-- Negócio novo (ou reaberto) sem dono, para um cliente cuja conversa já é de um vendedor, herda o responsável da conversa.
-- Sem isso o negócio fica "sem dono" e, com o isolamento por vendedor ligado, aparece para os outros vendedores
-- (o gatilho sync_owner_on_conversation_assign só dispara quando a conversa MUDA de responsável). Idempotente.
-- Só vale para vendedor cadastrado: conversa na conta compartilhada (encaminhamento da IA) mantém o negócio sem dono.
-- Reverter: DROP TRIGGER trg_owner_on_opportunity_open ON public.opportunities; DROP FUNCTION public.owner_on_opportunity_open();
CREATE OR REPLACE FUNCTION public.owner_on_opportunity_open()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_owner uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM 'open' OR NEW.owner_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT c.assigned_to INTO v_owner
    FROM public.conversations c
   WHERE c.organization_id = NEW.organization_id AND c.contact_id = NEW.contact_id AND c.assigned_to IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.organization_id = c.organization_id AND r.user_id = c.assigned_to)
   ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
   LIMIT 1;
  IF v_owner IS NOT NULL THEN
    NEW.owner_id := v_owner;
    NEW.owner_assigned_at := now();
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.owner_on_opportunity_open() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_owner_on_opportunity_open ON public.opportunities;
CREATE TRIGGER trg_owner_on_opportunity_open
  BEFORE INSERT OR UPDATE OF status ON public.opportunities
  FOR EACH ROW EXECUTE FUNCTION public.owner_on_opportunity_open();
