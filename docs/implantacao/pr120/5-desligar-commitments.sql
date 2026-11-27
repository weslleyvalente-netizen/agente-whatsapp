-- PR #120 — DESLIGAMENTO IMEDIATO de commitments_enabled (botão de emergência)
-- Efeito: a próxima rodada do worker (até 5 min) não processa mais a organização. Uma rodada já em curso termina.
-- Não apaga nada: promessas, propostas e tarefas já criadas continuam como estão (ver consulta B para revisão manual).

BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE public.organizations
   SET settings = jsonb_set(settings, '{commitments_enabled}', 'false'::jsonb, true)
 WHERE id = 'cf01d00d-77f9-42bf-afd7-f22819f201c8'
RETURNING id, settings->'commitments_enabled' AS commitments_enabled;
-- Esperado: 1 linha, false.
COMMIT;

-- B) Revisão (somente leitura): tarefas criadas/alteradas pela rotina desde a ativação.
-- Cancelar alguma delas é decisão separada do dono, feita tarefa a tarefa.
-- select t.id, t.type, t.status, t.assignee_id, t.due_date, t.due_time, left(t.description, 80) descricao, t.created_at
--   from public.tasks t
--  where t.id in (select task_id from public.seller_commitments where task_id is not null
--                 union select reminder_task_id from public.proposal_followups where reminder_task_id is not null)
--  order by t.created_at;
