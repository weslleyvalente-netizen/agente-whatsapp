-- VALIDAÇÃO pós-aplicação da 20261122150000 (somente leitura; nenhuma escrita).
-- Esperado: todas as linhas com ok = true.
select * from (values
 ('historico_registrado',       exists(select 1 from supabase_migrations.schema_migrations where version='20261122150000'), ''),
 ('historico_conteudo_integro', (select md5(statements[1]) = '28e8e032b85a6e7ce9494bf7d11213a2' and name = 'tasks_commitment_kind' and created_by = 'sql_editor_pr122'
                                   from supabase_migrations.schema_migrations where version='20261122150000'), 'md5 do arquivo da migração'),
 ('historico_120_presente',     exists(select 1 from supabase_migrations.schema_migrations where version='20261122120000'), 'migração anterior do #120'),
 ('coluna_commitment_kind',     (select data_type = 'text' and is_nullable = 'YES' and column_default is null from information_schema.columns
                                   where table_schema='public' and table_name='tasks' and column_name='commitment_kind'), 'texto, nula, sem default'),
 ('check_valores',              (select count(*) = 1 from pg_constraint where conrelid='public.tasks'::regclass and contype='c' and convalidated
                                   and pg_get_constraintdef(oid) like '%commitment_kind%return_customer%proposal_followup%'), ''),
 ('indice_unico_parcial',       (select i.indisunique and i.indisvalid and i.indisready
                                     and pg_get_indexdef(i.indexrelid) like '%(organization_id, conversation_id, commitment_kind)%'
                                     and pg_get_indexdef(i.indexrelid) like '%commitment_kind IS NOT NULL%'
                                     and pg_get_indexdef(i.indexrelid) like '%pending%in_progress%rescheduled%'
                                   from pg_index i where i.indexrelid = to_regclass('public.tasks_commitment_open_per_conversation')), 'uma aberta por conversa e marca'),
 ('nenhuma_tarefa_marcada',     (select count(*) = 0 from public.tasks where commitment_kind is not null), 'zero até ligar commitments_enabled'),
 ('tarefas_intactas',           (select count(*) > 0 from public.tasks), 'tabela continua com as tarefas'),
 ('flags_desligadas',           (select coalesce(settings->>'commitments_enabled','false') <> 'true' and coalesce(settings->>'escape_distribution_enabled','false') <> 'true'
                                    and coalesce(settings->>'lid_auto_merge_enabled','false') <> 'true' and coalesce(settings->>'urgent_cards_enabled','false') <> 'true'
                               from public.organizations where id='cf01d00d-77f9-42bf-afd7-f22819f201c8'), '')
) v(verificacao, ok, obs);
