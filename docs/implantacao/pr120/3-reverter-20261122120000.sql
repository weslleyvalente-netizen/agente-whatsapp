-- REVERSÃO da 20261122120000 — usar SÓ com autorização e DEPOIS de desligar as flags do PR #120.
-- Não apaga dados: tabelas com linhas são RENOMEADAS (guardadas), não removidas. Funções são só código (podem sair).
-- A constraint antiga só volta se não houver encaminhamento 'sistema_sem_resposta' (senão a ampliada fica — inofensiva).
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.distribute_escaped_lead(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.adopt_lid_contact(uuid, text, text, text[]);

DO $$
BEGIN
  IF to_regclass('public.proposal_followups') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.proposal_followups) THEN
      ALTER TABLE public.proposal_followups RENAME TO proposal_followups_revertida_20261122;
    ELSE
      DROP TABLE public.proposal_followups;
    END IF;
  END IF;
  IF to_regclass('public.seller_commitments') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.seller_commitments) THEN
      ALTER TABLE public.seller_commitments RENAME TO seller_commitments_revertida_20261122;
    ELSE
      DROP TABLE public.seller_commitments;
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.handoff_events WHERE trigger_type = 'sistema_sem_resposta') THEN
    ALTER TABLE public.handoff_events DROP CONSTRAINT IF EXISTS handoff_events_trigger_type_check;
    ALTER TABLE public.handoff_events ADD CONSTRAINT handoff_events_trigger_type_check CHECK (trigger_type IN (
      'request_human', 'painel_manual', 'fromMe_real', 'fromMe_greeting_filtered'));
  ELSE
    RAISE NOTICE 'Há encaminhamentos sistema_sem_resposta: constraint ampliada mantida (nenhum dado removido).';
  END IF;
END $$;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261122120000';
COMMIT;

-- Contatos @lid já ajustados pela adopt_lid_contact NÃO são desfeitos por este script. Para listar (somente leitura):
-- select id, phone, metadata->>'lid' lid, metadata->>'lid_adopted_at' adotado_em, metadata->>'merged_into' juntado_em
--   from public.wa_contacts where organization_id='cf01d00d-77f9-42bf-afd7-f22819f201c8'
--    and (metadata ? 'lid_adopted_at' or metadata ? 'merged_into');
