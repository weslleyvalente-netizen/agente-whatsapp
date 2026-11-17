-- Leitura SOMENTE DO CATÁLOGO do PostgreSQL de produção (metadados e estatísticas já coletadas).
-- Objetivo: estimar tamanho de `messages` e dos índices que a fila "Precisam de resposta" usa, sem tocar nos dados.
--
-- O que NÃO há aqui: nenhum SELECT nas tabelas de dados, nenhum COUNT(*), nenhum EXPLAIN ANALYZE, nenhum DDL, nenhum índice.
-- Só pg_class, pg_indexes, pg_stat_user_*, pg_stats e funções de tamanho (pg_*_size lê metadados de arquivo, não varre linhas).
-- Seguro para rodar no SQL Editor do Supabase. Cada bloco é independente; rode um por vez e cole o resultado.

-- 1) Tamanho e estimativa de linhas (reltuples é estimativa do planejador; -1 = nunca analisada)
SELECT c.relname AS tabela,
       c.reltuples::bigint AS linhas_estimadas,
       c.relpages AS paginas_8kb,
       pg_size_pretty(pg_relation_size(c.oid)) AS tabela_heap,
       pg_size_pretty(pg_indexes_size(c.oid)) AS todos_indices,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
  AND c.relname IN ('messages', 'conversations', 'lead_assignments', 'wa_contacts', 'sales_reps')
ORDER BY pg_total_relation_size(c.oid) DESC;

-- 2) Definição e tamanho de cada índice dessas tabelas
SELECT i.tablename AS tabela, i.indexname AS indice,
       pg_size_pretty(pg_relation_size(format('public.%I', i.indexname)::regclass)) AS tamanho,
       i.indexdef AS definicao
FROM pg_indexes i
WHERE i.schemaname = 'public' AND i.tablename IN ('messages', 'conversations', 'lead_assignments', 'wa_contacts')
ORDER BY i.tablename, pg_relation_size(format('public.%I', i.indexname)::regclass) DESC;

-- 3) Uso dos índices desde o último reset das estatísticas (idx_scan = nº de varreduras; 0 = nunca usado)
SELECT s.relname AS tabela, s.indexrelname AS indice, s.idx_scan, s.idx_tup_read, s.idx_tup_fetch
FROM pg_stat_user_indexes s
WHERE s.schemaname = 'public' AND s.relname IN ('messages', 'conversations', 'lead_assignments', 'wa_contacts')
ORDER BY s.relname, s.idx_scan DESC;

-- 4) Atividade e saúde das tabelas (varreduras sequenciais, linhas mortas, últimas manutenções) + quando as estatísticas foram zeradas
SELECT t.relname AS tabela, t.n_live_tup, t.n_dead_tup, t.seq_scan, t.seq_tup_read, t.idx_scan, t.idx_tup_fetch,
       t.last_autovacuum, t.last_autoanalyze, t.last_vacuum, t.last_analyze
FROM pg_stat_user_tables t
WHERE t.schemaname = 'public' AND t.relname IN ('messages', 'conversations', 'lead_assignments', 'wa_contacts')
ORDER BY t.relname;
SELECT datname, stats_reset FROM pg_stat_database WHERE datname = current_database();

-- 5) Estatísticas do planejador de `messages` (distribuição já amostrada pelo ANALYZE; não lê a tabela)
SELECT attname, null_frac, n_distinct, most_common_vals::text AS valores_mais_comuns, most_common_freqs::text AS frequencias, correlation
FROM pg_stats
WHERE schemaname = 'public' AND tablename = 'messages' AND attname IN ('role', 'conversation_id', 'created_at');
