-- Follow-up de proposta, promessas e clientes que escapam (desenho 2026-11-22). Idempotente. NÃO aplicada nesta entrega.
SET LOCAL lock_timeout = '5s';

-- 1) Propostas identificadas (métricas e auditoria). Uma linha por mensagem do vendedor.
CREATE TABLE IF NOT EXISTS public.proposal_followups (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  opportunity_id             uuid REFERENCES public.opportunities(id) ON DELETE SET NULL,
  conversation_id            uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  owner_user_id              uuid,
  seller_message_id          uuid NOT NULL UNIQUE,
  sent_at                    timestamptz NOT NULL,
  identified_by              text NOT NULL CHECK (identified_by IN ('stage_event', 'content')),
  evidence                   text NOT NULL,
  reminder_task_id           uuid,
  reminder_created_at        timestamptz,
  first_seller_followup_at   timestamptz,
  first_customer_reply_at    timestamptz,
  outcome                    text CHECK (outcome IN ('won', 'lost')),
  outcome_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposal_followups_org_sent ON public.proposal_followups (organization_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS proposal_followups_open ON public.proposal_followups (organization_id)
  WHERE first_seller_followup_at IS NULL AND first_customer_reply_at IS NULL;

ALTER TABLE public.proposal_followups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS proposal_followups_select ON public.proposal_followups;
CREATE POLICY proposal_followups_select ON public.proposal_followups
  FOR SELECT USING (organization_id IN (SELECT public.get_user_org_ids()));
-- Escrita só pelo service_role (worker): nenhuma política de insert/update para usuários.

-- 1b) Promessas de retorno do vendedor ("vou verificar e te retorno"). Uma linha por mensagem; a aberta mais recente da conversa
--     vale (as anteriores ficam 'superseded'). Vencida e não resolvida = card Urgente. Mensagem genérica NÃO resolve.
CREATE TABLE IF NOT EXISTS public.seller_commitments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id    uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL,
  opportunity_id     uuid REFERENCES public.opportunities(id) ON DELETE SET NULL,
  owner_user_id      uuid,
  seller_message_id  uuid NOT NULL UNIQUE,
  sent_at            timestamptz NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('quick', 'standard', 'explicit_time', 'tomorrow')),
  phrase             text NOT NULL,
  due_at             timestamptz NOT NULL,
  task_id            uuid,
  resolved_at        timestamptz,
  resolution         text CHECK (resolution IN ('task_completed', 'delivered', 'opportunity_closed', 'superseded')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seller_commitments_open ON public.seller_commitments (organization_id, due_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS seller_commitments_conversation ON public.seller_commitments (conversation_id, sent_at DESC);
ALTER TABLE public.seller_commitments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS seller_commitments_select ON public.seller_commitments;
CREATE POLICY seller_commitments_select ON public.seller_commitments
  FOR SELECT USING (organization_id IN (SELECT public.get_user_org_ids()));

-- 2) Encaminhamento pelo sistema: cliente que escreveu e ninguém (nem a IA) respondeu.
ALTER TABLE public.handoff_events DROP CONSTRAINT IF EXISTS handoff_events_trigger_type_check;
ALTER TABLE public.handoff_events ADD CONSTRAINT handoff_events_trigger_type_check CHECK (trigger_type IN (
  'request_human', 'painel_manual', 'fromMe_real', 'fromMe_greeting_filtered', 'sistema_sem_resposta'
));

-- 3) Contato @lid que reaparece com o número real (par vindo do próprio WhatsApp, verificado no webhook).
--    Sem contato real: o @lid assume o número (conversa, vendedor e histórico ficam). Com contato real: move tudo que aponta
--    para o @lid (descoberto em pg_constraint) para o real. Qualquer erro desfaz o bloco inteiro e devolve 'conflict'.
CREATE OR REPLACE FUNCTION public.adopt_lid_contact(p_organization_id uuid, p_lid_phone text, p_real_phone text, p_real_variants text[])
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  lid public.wa_contacts; real public.wa_contacts; fk record;
BEGIN
  IF p_lid_phone IS NULL OR p_lid_phone NOT LIKE '%@lid' OR p_real_phone !~ '^\d{10,15}$' THEN RETURN 'invalid'; END IF;
  SELECT * INTO lid FROM public.wa_contacts WHERE organization_id = p_organization_id AND phone = p_lid_phone FOR UPDATE;
  IF lid.id IS NULL THEN RETURN 'none'; END IF;
  SELECT * INTO real FROM public.wa_contacts WHERE organization_id = p_organization_id AND phone = ANY(COALESCE(p_real_variants, ARRAY[p_real_phone]))
    AND id <> lid.id ORDER BY updated_at DESC LIMIT 1 FOR UPDATE;
  BEGIN
    IF real.id IS NULL THEN
      UPDATE public.wa_contacts SET phone = p_real_phone,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('lid', p_lid_phone, 'lid_adopted_at', now())
       WHERE id = lid.id;
      RETURN 'renamed';
    END IF;
    FOR fk IN
      SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'public.wa_contacts'::regclass AND array_length(c.conkey, 1) = 1
    LOOP
      EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', fk.tbl, fk.col, fk.col) USING real.id, lid.id;
    END LOOP;
    UPDATE public.wa_contacts SET phone = p_lid_phone || '#merged',
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('merged_into', real.id, 'merged_at', now())
     WHERE id = lid.id;
    UPDATE public.wa_contacts SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('lid', p_lid_phone) WHERE id = real.id;
    RETURN 'merged';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'adopt_lid_contact conflict: %', SQLERRM;
    RETURN 'conflict';
  END;
END $$;
REVOKE ALL ON FUNCTION public.adopt_lid_contact(uuid, text, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adopt_lid_contact(uuid, text, text, text[]) TO service_role;
