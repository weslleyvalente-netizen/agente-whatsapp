-- Fase 2 (triagem de tarefas), item 2: quando várias pendências caem na
-- mesma oportunidade, a tarefa consolidada guarda a lista completa aqui em
-- vez de perder as anteriores. type/title/description/priority/due_date da
-- própria linha sempre refletem a pendência de maior prioridade da lista
-- (ver packages/shared/src/task-consolidation.ts) — a lista é o dado fonte,
-- as colunas continuam existindo para não quebrar nenhuma leitura atual.
ALTER TABLE tasks
  ADD COLUMN consolidated_pendencies jsonb NOT NULL DEFAULT '[]'::jsonb;
