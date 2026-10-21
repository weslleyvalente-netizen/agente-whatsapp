begin;
create table public.manual_financing_settings(
 organization_id uuid primary key references public.organizations(id),
 revision uuid not null default gen_random_uuid(),mode text not null check(mode in('sandbox','live')),
 enabled boolean not null default false,credentials_encrypted text not null,
 account_hash text not null check(account_hash ~ '^[a-f0-9]{64}$'),banks text[] not null check(cardinality(banks) between 1 and 17),
 updated_by uuid not null,updated_at timestamptz not null default now()
);
create table public.manual_financing_accounts(
 account_hash text primary key check(account_hash ~ '^[a-f0-9]{64}$'),next_call_at timestamptz not null default '-infinity'
);
create table public.manual_financing_cases(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),seller_id uuid not null,
 idempotency_key uuid not null,fingerprint text not null,config_revision uuid not null,account_hash text not null,
 mode text not null check(mode in('sandbox','live')),application_encrypted text not null,credentials_encrypted text not null,
 banks text[] not null check(cardinality(banks) between 1 and 17),
 state text not null default 'prepared' check(state in('prepared','submitting','processing','completed','creation_unknown','failed','cancelled')),
 consent_expires_at timestamptz not null,revoked_at timestamptz,submitted_at timestamptz,completed_at timestamptz,last_polled_at timestamptz,
 provider_finished_at timestamptz,provider_id bigint check(provider_id>0),results jsonb not null default '[]' check(jsonb_typeof(results)='array'),
 error_code text check(length(error_code)<=64),created_at timestamptz not null default now(),
 unique(organization_id,idempotency_key),unique(account_hash,provider_id)
);
create index manual_financing_owner on public.manual_financing_cases(organization_id,seller_id,created_at desc);
create index manual_financing_active on public.manual_financing_cases(account_hash,state) where submitted_at is not null and provider_finished_at is null;
-- APIs authorize seller/manager on every read and mutation. No direct browser access.
do $$declare t text;begin
 foreach t in array array['manual_financing_settings','manual_financing_accounts','manual_financing_cases'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end$$;
create function public.manual_financing_gate(p_org uuid,p_case uuid,p_account text,p_action text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare r public.manual_financing_cases; next_at timestamptz; call_time timestamptz:=clock_timestamp(); active_count int;
begin
 if p_action not in('start','poll','test') then return false;end if;
 insert into public.manual_financing_accounts(account_hash) values(p_account) on conflict do nothing;
 select next_call_at into next_at from public.manual_financing_accounts where account_hash=p_account for update;
 if next_at>call_time then return false;end if;
 if p_action<>'test' then
  select * into r from public.manual_financing_cases where id=p_case and organization_id=p_org and account_hash=p_account for update;
  if not found then return false;end if;
  if p_action='start' then
   if r.revoked_at is not null or r.state<>'prepared' or r.consent_expires_at<=call_time then return false;end if;
   if not exists(select 1 from public.manual_financing_settings s where s.organization_id=p_org and s.revision=r.config_revision and s.mode=r.mode and s.enabled) then return false;end if;
   select count(*) into active_count from public.manual_financing_cases where account_hash=p_account and submitted_at is not null and provider_finished_at is null;
   if active_count>=3 then return false;end if;
   update public.manual_financing_cases set state='submitting',submitted_at=call_time where id=r.id;
  else
   if r.state not in('processing','cancelled') or r.provider_finished_at is not null or r.provider_id is null or r.last_polled_at>call_time-interval '10 seconds' then return false;end if;
   update public.manual_financing_cases set last_polled_at=call_time where id=r.id;
  end if;
 else
  if not exists(select 1 from public.manual_financing_settings where organization_id=p_org and account_hash=p_account) then return false;end if;
 end if;
 update public.manual_financing_accounts set next_call_at=call_time+interval '3.1 seconds' where account_hash=p_account;
 return true;
end$$;
create function public.manual_financing_cancel(p_org uuid,p_case uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.manual_financing_cases set state='cancelled',revoked_at=coalesce(revoked_at,clock_timestamp()) where id=p_case and organization_id=p_org;
 return found;
end$$;
create function public.manual_financing_register(p_org uuid,p_case uuid,p_provider bigint)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.manual_financing_cases set provider_id=p_provider,state=case when revoked_at is not null then 'cancelled' else 'processing' end
 where id=p_case and organization_id=p_org and submitted_at is not null and provider_id is null and state in('submitting','creation_unknown','cancelled');
 return found;
end$$;
create function public.manual_financing_finish(p_org uuid,p_case uuid,p_provider bigint,p_results jsonb,p_completed boolean)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.manual_financing_cases set
 results=case when revoked_at is null then p_results else '[]'::jsonb end,
 state=case when revoked_at is not null then 'cancelled' when p_completed then 'completed' else 'processing' end,
 completed_at=case when p_completed then clock_timestamp() else completed_at end,
 provider_finished_at=case when p_completed then clock_timestamp() else provider_finished_at end,error_code=null
 where id=p_case and organization_id=p_org and provider_id=p_provider and state in('processing','cancelled');
 return found;
end$$;
revoke all on function public.manual_financing_register(uuid,uuid,bigint),public.manual_financing_finish(uuid,uuid,bigint,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.manual_financing_register(uuid,uuid,bigint),public.manual_financing_finish(uuid,uuid,bigint,jsonb,boolean) to service_role;
revoke all on function public.manual_financing_gate(uuid,uuid,text,text),public.manual_financing_cancel(uuid,uuid) from public,anon,authenticated;
grant execute on function public.manual_financing_gate(uuid,uuid,text,text),public.manual_financing_cancel(uuid,uuid) to service_role;
create function public.manual_financing_rejected(p_org uuid,p_case uuid,p_code text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 if p_code not in('not_created_401','not_created_402','not_created_422','not_created_429') then return false;end if;
 update public.manual_financing_cases set state=case when revoked_at is null then 'failed' else 'cancelled' end,
 provider_finished_at=clock_timestamp(),completed_at=clock_timestamp(),error_code=p_code
 where id=p_case and organization_id=p_org and state in('submitting','cancelled') and submitted_at is not null and provider_id is null;
 return found;
end$$;
revoke all on function public.manual_financing_rejected(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.manual_financing_rejected(uuid,uuid,text) to service_role;
comment on table public.manual_financing_cases is 'Manual seller-initiated financing only. No AI dispatch, customer notification or automatic credit requery.';
commit;
