-- VALIDAÇÃO pós-aplicação da 20261122120000 (somente leitura; nenhuma escrita).
-- Esperado: todas as linhas com ok = true.
select * from (values
 ('historico_registrado',      exists(select 1 from supabase_migrations.schema_migrations where version='20261122120000'), ''),
 ('historico_conteudo_integro',(select md5(statements[1]) = '1bca2eaae8fc7a41e8721f82ba85ffa4' and name = 'commitments_followup' from supabase_migrations.schema_migrations where version='20261122120000'), 'md5 do arquivo da migração'),
 ('tabela_proposal_followups', to_regclass('public.proposal_followups') is not null, ''),
 ('tabela_seller_commitments', to_regclass('public.seller_commitments') is not null, ''),
 ('tabelas_vazias',            (select count(*) from public.proposal_followups) + (select count(*) from public.seller_commitments) = 0, 'vazias até ligar commitments_enabled'),
 ('rls_ligada',                (select bool_and(relrowsecurity) from pg_class where oid in ('public.proposal_followups'::regclass,'public.seller_commitments'::regclass)), ''),
 ('politicas_so_select',       (select count(*) = 2 and bool_and(cmd = 'SELECT') from pg_policies where schemaname='public' and tablename in ('proposal_followups','seller_commitments')), 'escrita só service_role'),
 ('indices',                   (select count(*) = 4 from pg_indexes where schemaname='public' and indexname in ('proposal_followups_org_sent','proposal_followups_open','seller_commitments_open','seller_commitments_conversation')), ''),
 ('unique_seller_message_id',  (select count(*) = 2 from pg_indexes where schemaname='public' and tablename in ('proposal_followups','seller_commitments') and indexdef like '%UNIQUE%seller_message_id%'), ''),
 ('fn_adopt_secdef_searchpath',(select prosecdef and array_to_string(proconfig,',') like '%search_path=public, pg_temp%' from pg_proc where oid='public.adopt_lid_contact(uuid,text,text,text[])'::regprocedure), ''),
 ('fn_escaped_secdef_searchpath',(select prosecdef and array_to_string(proconfig,',') like '%search_path=public, pg_temp%' from pg_proc where oid='public.distribute_escaped_lead(uuid,uuid,timestamptz)'::regprocedure), ''),
 ('fn_so_service_role',        not has_function_privilege('anon','public.adopt_lid_contact(uuid,text,text,text[])','execute')
                           and not has_function_privilege('authenticated','public.adopt_lid_contact(uuid,text,text,text[])','execute')
                           and not has_function_privilege('anon','public.distribute_escaped_lead(uuid,uuid,timestamptz)','execute')
                           and not has_function_privilege('authenticated','public.distribute_escaped_lead(uuid,uuid,timestamptz)','execute')
                           and has_function_privilege('service_role','public.adopt_lid_contact(uuid,text,text,text[])','execute')
                           and has_function_privilege('service_role','public.distribute_escaped_lead(uuid,uuid,timestamptz)','execute'), ''),
 ('constraint_handoff_nova',   (select pg_get_constraintdef(oid) like '%sistema_sem_resposta%' and convalidated from pg_constraint where conrelid='public.handoff_events'::regclass and conname='handoff_events_trigger_type_check'), ''),
 ('handoff_sem_linhas_novas',  (select count(*) = 0 from public.handoff_events where trigger_type='sistema_sem_resposta'), 'zero até ligar escape_distribution_enabled'),
 ('adopt_entrada_invalida',    public.adopt_lid_contact('00000000-0000-0000-0000-000000000000'::uuid, 'x', 'y', null) = 'invalid', 'chamada inofensiva: não toca dados'),
 ('flags_desligadas',          (select coalesce(settings->>'commitments_enabled','false') <> 'true' and coalesce(settings->>'escape_distribution_enabled','false') <> 'true'
                                   and coalesce(settings->>'lid_auto_merge_enabled','false') <> 'true' and coalesce(settings->>'urgent_cards_enabled','false') <> 'true'
                              from public.organizations where id='cf01d00d-77f9-42bf-afd7-f22819f201c8'), '')
) v(verificacao, ok, obs);
