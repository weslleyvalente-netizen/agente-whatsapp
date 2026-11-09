-- Ticks de entrega e leitura (✓✓) nas mensagens enviadas.
-- Colado pelo dono no SQL Editor do Supabase. Idempotente. Só adiciona colunas opcionais
-- (alteração só de metadados, sem reescrever a tabela).
alter table messages
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz;
