-- APLICAÇÃO da migração 20261122150000 (PR #122). Conteúdo idêntico a supabase/migrations/20261122150000_tasks_commitment_kind.sql
-- (SHA-256 do arquivo: fef65335623ebb0341e07072ff92bc355808945a1ccf658dbf169387ba6399cb; md5: 28e8e032b85a6e7ce9494bf7d11213a2).
-- Uma transação só: qualquer falha (lock_timeout de 5 s, versão já registrada, coluna/índice em conflito) desfaz TUDO.
-- NÃO usar `supabase db push` (há migrações aplicadas pelo SQL Editor sem registro; ele tentaria reaplicá-las).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Revisão do PR #122 (22/11/2026): tarefas da rotina de compromissos (promessa de retorno / lembrete de proposta).
--
-- 1) Marca própria, gravada só na criação pela rotina. Antes a marca era o texto do motivo, que o CRM deixa editar
--    (PATCH /tasks/:id aceita reason e type): editar o motivo tirava a tarefa da proteção contra consolidação sem aviso.
--    A API não aceita commitment_kind na edição.
-- 2) No máximo UMA tarefa aberta por conversa e marca, garantida pelo banco: duas execuções simultâneas da rotina
--    (ex.: worker antigo e novo durante um deploy, ou job reprocessado) não criam tarefa duplicada; a segunda recebe 23505
--    e reaproveita a primeira.
--
-- Coluna nula e sem default (alteração só de catálogo, instantânea). Nenhuma tarefa existente é marcada: com
-- commitments_enabled desligado nada muda no CRM. O índice só contém linhas com commitment_kind (hoje nenhuma).
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS commitment_kind text
    CHECK (commitment_kind IN ('return_customer', 'proposal_followup'));

CREATE UNIQUE INDEX IF NOT EXISTS tasks_commitment_open_per_conversation
  ON public.tasks (organization_id, conversation_id, commitment_kind)
  WHERE commitment_kind IS NOT NULL AND status IN ('pending', 'in_progress', 'rescheduled');

-- Registro no histórico, no mesmo formato das migrações aplicadas pelo painel (statements = conteúdo integral do arquivo).
-- INSERT sem ON CONFLICT de propósito: se a versão já existir, a transação inteira é abortada.
INSERT INTO supabase_migrations.schema_migrations (version, name, statements, created_by)
VALUES ('20261122150000', 'tasks_commitment_kind', ARRAY[$mig_20261122150000$-- Revisão do PR #122 (22/11/2026): tarefas da rotina de compromissos (promessa de retorno / lembrete de proposta).
--
-- 1) Marca própria, gravada só na criação pela rotina. Antes a marca era o texto do motivo, que o CRM deixa editar
--    (PATCH /tasks/:id aceita reason e type): editar o motivo tirava a tarefa da proteção contra consolidação sem aviso.
--    A API não aceita commitment_kind na edição.
-- 2) No máximo UMA tarefa aberta por conversa e marca, garantida pelo banco: duas execuções simultâneas da rotina
--    (ex.: worker antigo e novo durante um deploy, ou job reprocessado) não criam tarefa duplicada; a segunda recebe 23505
--    e reaproveita a primeira.
--
-- Coluna nula e sem default (alteração só de catálogo, instantânea). Nenhuma tarefa existente é marcada: com
-- commitments_enabled desligado nada muda no CRM. O índice só contém linhas com commitment_kind (hoje nenhuma).
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS commitment_kind text
    CHECK (commitment_kind IN ('return_customer', 'proposal_followup'));

CREATE UNIQUE INDEX IF NOT EXISTS tasks_commitment_open_per_conversation
  ON public.tasks (organization_id, conversation_id, commitment_kind)
  WHERE commitment_kind IS NOT NULL AND status IN ('pending', 'in_progress', 'rescheduled');
$mig_20261122150000$], 'sql_editor_pr122');

COMMIT;
