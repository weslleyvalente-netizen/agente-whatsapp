-- PR #120/#122 — monitoramento de commitments_enabled (SOMENTE LEITURA). Trocar o instante da ativação em "p".
-- Revisado em 23/11 para o #122: as tarefas da rotina são independentes e marcadas por tasks.commitment_kind (linhas 9, 11, 16, 17 e 18).
-- Rodar: a cada 5 min na primeira hora; a cada 30 min até 12:00; de hora em hora até 18:00; fechamento em 24 h.
-- Gatilhos de desligamento (5-desligar): ver a coluna "alerta" — qualquer linha com alerta = 'DESLIGAR' para tudo.
with p as (select timestamptz 'AAAA-MM-DD HH:MI:SS-03' as ativ, 'cf01d00d-77f9-42bf-afd7-f22819f201c8'::uuid as org),
sc as (select c.* from public.seller_commitments c, p where c.organization_id = p.org),
pf as (select f.* from public.proposal_followups f, p where f.organization_id = p.org),
tk as (select t.* from public.tasks t, p where t.organization_id = p.org and t.created_at >= p.ativ),
own as (select task_id id from sc where task_id is not null union select reminder_task_id from pf where reminder_task_id is not null)
select * from (
  select 1 o, 'flag' k, (select coalesce(settings->>'commitments_enabled','ausente') from public.organizations, p where id = p.org) v,
         case when (select coalesce(settings->>'escape_distribution_enabled','false') = 'true' or coalesce(settings->>'lid_auto_merge_enabled','false') = 'true'
                           or coalesce(settings->>'urgent_cards_enabled','false') = 'true' or coalesce(settings->>'exception_manager_push_enabled','false') = 'true'
                           or settings->'business_calendar' ? 'holiday_set'
                    from public.organizations, p where id = p.org) then 'PARAR: flag nao autorizada ligada' else 'ok' end alerta
  union all select 2, 'promessas (total / abertas / sem tarefa >10min)',
         (select count(*) || ' / ' || count(*) filter (where resolved_at is null) || ' / ' ||
                 count(*) filter (where task_id is null and resolved_at is null and created_at < now() - interval '10 minutes') from sc),
         case when (select count(*) from sc where task_id is null and resolved_at is null and created_at < now() - interval '10 minutes') > 0 then 'ATENCAO' else 'ok' end
  union all select 3, 'promessas por tipo', (select coalesce(string_agg(kind || ':' || n, ', '), '0') from (select kind, count(*) n from sc group by 1) s), 'info'
  union all select 4, 'resolucoes', (select coalesce(string_agg(coalesce(resolution, 'aberta') || ':' || n, ', '), '0') from (select resolution, count(*) n from sc group by 1) s), 'info'
  union all select 5, 'encerramento rapido (<15 min, exceto superseded)',
         (select count(*)::text from sc where resolved_at is not null and resolution <> 'superseded' and resolved_at - created_at < interval '15 minutes'),
         case when (select count(*) from sc where resolved_at is not null and resolution <> 'superseded' and resolved_at - created_at < interval '15 minutes') > 2 then 'ATENCAO' else 'ok' end
  union all select 6, 'task_completed com tarefa ainda aberta',
         (select count(*)::text from sc join public.tasks t on t.id = sc.task_id where sc.resolution = 'task_completed' and t.status in ('pending', 'in_progress')),
         case when (select count(*) from sc join public.tasks t on t.id = sc.task_id where sc.resolution = 'task_completed' and t.status in ('pending', 'in_progress')) > 0 then 'DESLIGAR' else 'ok' end
  union all select 7, 'propostas (total / por conteudo / por etapa / lembretes criados)',
         (select count(*) || ' / ' || count(*) filter (where identified_by = 'content') || ' / ' || count(*) filter (where identified_by = 'stage_event') || ' / ' || count(*) filter (where reminder_task_id is not null) from pf), 'info'
  union all select 8, 'duas promessas abertas na mesma conversa',
         (select count(*)::text from (select conversation_id from sc where resolved_at is null group by 1 having count(*) > 1) s),
         case when (select count(*) from (select conversation_id from sc where resolved_at is null group by 1 having count(*) > 1) s) > 0 then 'DESLIGAR' else 'ok' end
  union all select 9, 'tarefas comuns abertas duplicadas criadas desde a ativacao (mesmo negocio + tipo)',
         (select count(*)::text from (select opportunity_id, type from public.tasks, p where organization_id = p.org and status in ('pending', 'in_progress') and opportunity_id is not null and commitment_kind is null and created_at >= p.ativ group by 1, 2 having count(*) > 1) s),
         case when (select count(*) from (select opportunity_id, type from public.tasks, p where organization_id = p.org and status in ('pending', 'in_progress') and opportunity_id is not null and commitment_kind is null and created_at >= p.ativ group by 1, 2 having count(*) > 1) s) > 0 then 'DESLIGAR' else 'ok' end
  union all select 10, 'tarefas da rotina criadas desde a ativacao (novas / por hora max)',
         (select (select count(*) from tk where id in (select id from own)) || ' / ' ||
                 coalesce((select max(n) from (select date_trunc('hour', created_at) h, count(*) n from tk where id in (select id from own) group by 1) x), 0)),
         case when (select coalesce(max(n), 0) from (select date_trunc('hour', created_at) h, count(*) n from tk where id in (select id from own) group by 1) x) > 15 then 'ATENCAO' else 'ok' end
  union all select 11, 'tarefas antigas usadas pela rotina (deve ser 0 desde o #122)',
         (select count(*)::text from public.tasks t, p where t.organization_id = p.org and t.id in (select id from own) and t.created_at < p.ativ),
         case when (select count(*) from public.tasks t, p where t.organization_id = p.org and t.id in (select id from own) and t.created_at < p.ativ) > 0 then 'DESLIGAR' else 'ok' end
  union all select 12, 'tarefas por vendedor (rotina)', (select coalesce(string_agg(left(assignee_id::text, 8) || ':' || n, ', '), '0') from (select assignee_id, count(*) n from public.tasks where id in (select id from own) group by 1) s), 'info'
  union all select 13, 'mensagens a cliente sem vendedor desde a ativacao (human_agent sem sent_by_user_id)',
         (select count(*)::text from public.messages m, p where m.organization_id = p.org and m.created_at >= p.ativ and m.role = 'human_agent' and not (coalesce(m.metadata, '{}'::jsonb) ? 'sent_by_user_id')),
         'info (mensagens pelo celular do vendedor; a rotina não tem caminho de envio)'
  union all select 14, 'falhas de envio desde a ativacao',
         (select count(*)::text from public.messages m, p where m.organization_id = p.org and m.created_at >= p.ativ and m.metadata ? 'send_failed_at'), 'info'
  union all select 15, 'rotina viva: ultima linha criada', (select coalesce(to_char(greatest((select max(created_at) from sc), (select max(created_at) from pf)) at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nenhuma ainda') ), 'info'
  union all select 16, 'tarefas da rotina sem commitment_kind',
         (select count(*)::text from public.tasks where id in (select id from own) and commitment_kind is null),
         case when (select count(*) from public.tasks where id in (select id from own) and commitment_kind is null) > 0 then 'DESLIGAR' else 'ok' end
  union all select 17, 'duas tarefas da rotina abertas na mesma conversa + marca',
         (select count(*)::text from (select conversation_id, commitment_kind from public.tasks, p where organization_id = p.org and commitment_kind is not null and status in ('pending', 'in_progress', 'rescheduled') group by 1, 2 having count(*) > 1) s),
         case when (select count(*) from (select conversation_id, commitment_kind from public.tasks, p where organization_id = p.org and commitment_kind is not null and status in ('pending', 'in_progress', 'rescheduled') group by 1, 2 having count(*) > 1) s) > 0 then 'DESLIGAR' else 'ok' end
  union all select 18, 'tarefas de outros fluxos que receberam pendencia da rotina',
         (select count(*)::text from public.tasks t, p where t.organization_id = p.org and t.commitment_kind is null and t.updated_at >= p.ativ
            and exists (select 1 from jsonb_array_elements(coalesce(t.consolidated_pendencies, '[]'::jsonb)) e
                         where e->>'description' like 'Retornar ao cliente: você disse%' or e->>'description' like 'Proposta enviada há 30 min%')),
         case when (select count(*) from public.tasks t, p where t.organization_id = p.org and t.commitment_kind is null and t.updated_at >= p.ativ
            and exists (select 1 from jsonb_array_elements(coalesce(t.consolidated_pendencies, '[]'::jsonb)) e
                         where e->>'description' like 'Retornar ao cliente: você disse%' or e->>'description' like 'Proposta enviada há 30 min%')) > 0 then 'DESLIGAR' else 'ok' end
  union all select 19, 'tarefas da rotina por status (marca:status)',
         (select coalesce(string_agg(commitment_kind || ':' || status || '=' || n, ', '), '0') from (select commitment_kind, status, count(*) n from public.tasks, p where organization_id = p.org and commitment_kind is not null group by 1, 2) s), 'info'
) r order by o;
