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
