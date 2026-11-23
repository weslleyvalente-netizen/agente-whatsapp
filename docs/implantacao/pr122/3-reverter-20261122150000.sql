-- REVERSÃO da 20261122150000 — usar SÓ com autorização e com commitments_enabled DESLIGADO.
-- O código do #122 funciona sem a coluna enquanto a flag estiver desligada (só a rotina de compromissos, ligada pela flag, usa a
-- coluna; isCommitmentTask lê "*" e, sem a coluna, trata tudo como tarefa comum). Não apaga tarefas: só a coluna e o índice saem.
-- Se já houver tarefas marcadas (a rotina chegou a rodar), as marcas são GUARDADAS antes numa tabela de backup (id, marca, status).
-- Uma transação só: qualquer falha desfaz tudo.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF (SELECT coalesce(settings->>'commitments_enabled','false') = 'true' FROM public.organizations
       WHERE id = 'cf01d00d-77f9-42bf-afd7-f22819f201c8') THEN
    RAISE EXCEPTION 'commitments_enabled está ligado: desligue a flag antes de reverter (nada foi alterado).';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'commitment_kind') THEN
    IF EXISTS (SELECT 1 FROM public.tasks WHERE commitment_kind IS NOT NULL) THEN
      CREATE TABLE public.tasks_commitment_kind_revertida_20261122 AS
        SELECT id AS task_id, commitment_kind, status, now() AS guardado_em FROM public.tasks WHERE commitment_kind IS NOT NULL;
      ALTER TABLE public.tasks_commitment_kind_revertida_20261122 ENABLE ROW LEVEL SECURITY; -- sem políticas: só service_role lê
      RAISE NOTICE 'Marcas guardadas em public.tasks_commitment_kind_revertida_20261122.';
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS public.tasks_commitment_open_per_conversation;
ALTER TABLE public.tasks DROP COLUMN IF EXISTS commitment_kind; -- leva junto a CHECK da coluna

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261122150000';
COMMIT;

-- Conferência (somente leitura), esperado: false, false, false.
-- select exists(select 1 from information_schema.columns where table_schema='public' and table_name='tasks' and column_name='commitment_kind') coluna,
--        to_regclass('public.tasks_commitment_open_per_conversation') is not null indice,
--        exists(select 1 from supabase_migrations.schema_migrations where version='20261122150000') historico;
