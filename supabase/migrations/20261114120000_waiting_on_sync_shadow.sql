-- Modo sombra da sincronização de waiting_on: registra o que a regra FARIA, sem alterar o negócio.
-- Aditiva e opcional: sem esta tabela o modo sombra cai para uma linha de log. RLS ligada e sem políticas = só o service role escreve e lê.
CREATE TABLE IF NOT EXISTS public.waiting_on_sync_shadow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES public.opportunities(id) ON DELETE CASCADE,
  rule text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('task_completed', 'customer_message', 'seller_message')),
  would_set jsonb NOT NULL,
  observed jsonb NOT NULL,
  evidence text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS waiting_on_sync_shadow_org_created_idx ON public.waiting_on_sync_shadow (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS waiting_on_sync_shadow_opp_idx ON public.waiting_on_sync_shadow (opportunity_id, created_at DESC);
ALTER TABLE public.waiting_on_sync_shadow ENABLE ROW LEVEL SECURITY;
