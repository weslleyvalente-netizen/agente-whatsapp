-- PRÉ-VERIFICAÇÃO da 20261122150000 (somente leitura; rodar antes do script 1). Esperado: todas as linhas com ok = true.
select * from (values
 ('versao_ainda_nao_registrada', not exists(select 1 from supabase_migrations.schema_migrations where version='20261122150000'), ''),
 ('historico_120_presente',      exists(select 1 from supabase_migrations.schema_migrations where version='20261122120000'), 'migração do #120 já aplicada'),
 ('coluna_ainda_nao_existe',     not exists(select 1 from information_schema.columns where table_schema='public' and table_name='tasks' and column_name='commitment_kind'), ''),
 ('indice_ainda_nao_existe',     to_regclass('public.tasks_commitment_open_per_conversation') is null, ''),
 ('compromissos_vazios',         (select count(*) from public.seller_commitments) + (select count(*) from public.proposal_followups) = 0, 'rotina nunca rodou'),
 ('sem_transacao_longa',         (select count(*) = 0 from pg_stat_activity where xact_start < now() - interval '1 minute' and pid <> pg_backend_pid()), 'senão o lock de 5 s pode abortar'),
 ('flag_desligada',              (select coalesce(settings->>'commitments_enabled','false') <> 'true' from public.organizations where id='cf01d00d-77f9-42bf-afd7-f22819f201c8'), '')
) v(verificacao, ok, obs)
union all select 'tarefas_na_tabela (informativo)', true, (select count(*)::text from public.tasks);
