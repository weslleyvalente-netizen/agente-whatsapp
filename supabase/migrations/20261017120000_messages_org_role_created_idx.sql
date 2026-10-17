-- Índice de desempenho do alerta de silêncio (última mensagem de cliente e contagem por faixa de horário).
-- EXECUTAR MANUALMENTE, FORA de transação (SQL Editor/psql, uma instrução por vez): CREATE INDEX CONCURRENTLY
-- não roda dentro de BEGIN/COMMIT e não bloqueia a tabela messages. Não rodar durante uma recuperação de mensagens.
-- Esta instrução não está embrulhada em bloco de transação; se o seu fluxo de migração envolve cada arquivo em
-- transação, não o aplique por ele.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_org_role_created_at
  ON messages (organization_id, role, created_at DESC);
