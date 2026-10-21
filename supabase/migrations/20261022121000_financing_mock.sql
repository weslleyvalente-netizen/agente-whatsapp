begin;
-- Backend-only: no direct client/agent access, encrypted application snapshot.
create table public.financing_consents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  opportunity_id uuid not null references public.opportunities(id),
  recorded_by uuid not null,
  evidence text not null check(length(evidence) between 10 and 2000),
  banks text[] not null check(cardinality(banks) between 1 and 4),
  allow_requery boolean not null default false,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check(expires_at > granted_at)
);
create index financing_consent_opportunity on public.financing_consents(organization_id,opportunity_id);
create table public.financing_requests (
  id uuid primary key default gen_random_uuid(),
  root_id uuid not null,
  organization_id uuid not null references public.organizations(id),
  opportunity_id uuid not null references public.opportunities(id),
  consent_id uuid not null references public.financing_consents(id),
  idempotency_key uuid not null,
  fingerprint text not null,
  vehicle_id bigint not null,
  application_encrypted text not null,
  banks text[] not null,
  mode text not null default 'mock' check(mode='mock'),
  attempt smallint not null default 0 check(attempt in (0,1)),
  state text not null default 'queued' check(state in ('queued','running','completed','cancelled')),
  first_started_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  requery_on date,
  execute_on date,
  check ((attempt=0 and execute_on is null) or (attempt=1 and execute_on is not null)),
  requery_used boolean not null default false,
  created_at timestamptz not null default now(),
  unique(organization_id,idempotency_key), unique(root_id,attempt)
);
create index financing_pending on public.financing_requests(state,lease_until) where state in ('queued','running');
create index financing_due on public.financing_requests(requery_on) where requery_on is not null and not requery_used;
create index financing_opportunity on public.financing_requests(organization_id,opportunity_id);
create index financing_consent on public.financing_requests(consent_id);
create table public.financing_results (
  request_id uuid not null references public.financing_requests(id),
  bank text not null,
  status text not null check(status in ('pending','preapproved','rejected','simulation','error')),
  offers jsonb not null default '[]',
  primary key(request_id,bank)
);
create table public.financing_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.financing_requests(id),
  event text not null check(event in ('created','started','completed','cancelled','requery_created')),
  created_at timestamptz not null default now()
);
create table public.financing_alerts (
  request_id uuid primary key references public.financing_requests(id),
  organization_id uuid not null references public.organizations(id),
  opportunity_id uuid not null references public.opportunities(id),
  created_at timestamptz not null default now()
);
-- Ownership is resolved from opportunities at read time, so alerts follow a
-- reassignment from Marina to Márcio. No send-message queue is involved.
do $$ declare t text; begin
  foreach t in array array['financing_consents','financing_requests','financing_results','financing_events','financing_alerts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;
grant usage,select on sequence public.financing_events_id_seq to service_role;

create function public.financing_create(p_org uuid,p_opp uuid,p_consent uuid,p_key uuid,p_fingerprint text,p_vehicle bigint,p_application text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.financing_requests; c public.financing_consents; result uuid;
begin
  -- Serialize creation, revocation and completion through opportunity lock.
  perform 1 from public.opportunities where id=p_opp and organization_id=p_org and status='open' for update;
  if not found then raise exception 'Opportunity unavailable'; end if;
  select * into r from public.financing_requests where organization_id=p_org and idempotency_key=p_key;
  if found then
    if r.fingerprint<>p_fingerprint or r.opportunity_id<>p_opp then raise exception 'Idempotency conflict'; end if;
    return r.id;
  end if;
  select * into c from public.financing_consents where id=p_consent and organization_id=p_org and opportunity_id=p_opp;
  if not found or c.revoked_at is not null or c.expires_at<=now() then raise exception 'Consent unavailable'; end if;
  result:=gen_random_uuid();
  insert into public.financing_requests(id,root_id,organization_id,opportunity_id,consent_id,idempotency_key,fingerprint,vehicle_id,application_encrypted,banks)
    values(result,result,p_org,p_opp,p_consent,p_key,p_fingerprint,p_vehicle,p_application,c.banks);
  insert into public.financing_results(request_id,bank,status) select result,unnest(c.banks),'pending';
  insert into public.financing_events(request_id,event) values(result,'created');
  return result;
end $$;

create function public.financing_cancel(p_org uuid,p_opp uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from public.opportunities where id=p_opp and organization_id=p_org for update;
  if not found then raise exception 'Opportunity unavailable'; end if;
  update public.financing_consents set revoked_at=now() where organization_id=p_org and opportunity_id=p_opp and revoked_at is null;
  insert into public.financing_events(request_id,event) select id,'cancelled' from public.financing_requests
    where organization_id=p_org and opportunity_id=p_opp and (state in ('queued','running') or requery_on is not null);
  update public.financing_requests set state=case when state='completed' then state else 'cancelled' end,
    requery_on=null,requery_used=true,lease_token=null,lease_until=null
    where organization_id=p_org and opportunity_id=p_opp;
end $$;

create function public.financing_claim() returns setof public.financing_requests
language plpgsql security invoker set search_path='' as $$
declare r public.financing_requests;
begin
  -- Cancel before claiming, including sold/lost opportunities and revoked consent.
  update public.financing_requests target set state=case when target.state='completed' then target.state else 'cancelled' end,requery_on=null,requery_used=true
    where (target.state in ('queued','running') or target.requery_on is not null) and ((target.attempt=1 and target.execute_on<>(now() at time zone 'America/Sao_Paulo')::date) or not exists (
      select 1 from public.financing_consents c join public.opportunities o on o.id=c.opportunity_id
      where c.id=target.consent_id and c.revoked_at is null and c.expires_at>now() and o.status='open'));
  select * into r from public.financing_requests where state='queued' or (state='running' and lease_until<now())
    order by created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.financing_requests set state='running',lease_until=now()+interval '5 minutes',lease_token=gen_random_uuid(),
    first_started_at=coalesce(first_started_at,now()) where id=r.id returning * into r;
  insert into public.financing_events(request_id,event) values(r.id,'started');
  return next r;
end $$;

create function public.financing_complete(p_id uuid,p_token uuid,p_results jsonb,p_requery date)
returns boolean language plpgsql security invoker set search_path='' as $$
declare r public.financing_requests; c public.financing_consents; item jsonb; opp uuid;
begin
  select opportunity_id into opp from public.financing_requests where id=p_id;
  perform 1 from public.opportunities where id=opp for update;
  select * into r from public.financing_requests where id=p_id for update;
  if not found or r.state<>'running' or r.lease_token is distinct from p_token then return false; end if;
  select * into c from public.financing_consents where id=r.consent_id;
  if c.revoked_at is not null or c.expires_at<=now() or (r.attempt=1 and r.execute_on<>(now() at time zone 'America/Sao_Paulo')::date) or not exists(select 1 from public.opportunities where id=r.opportunity_id and status='open') then
    update public.financing_requests set state='cancelled',requery_on=null,requery_used=true where id=p_id;
    insert into public.financing_events(request_id,event) values(p_id,'cancelled'); return false;
  end if;
  if jsonb_array_length(p_results)<>cardinality(r.banks) then raise exception 'Incomplete results'; end if;
  if (select count(distinct x->>'bank') from jsonb_array_elements(p_results) x)<>cardinality(r.banks) then raise exception 'Duplicate results'; end if;
  for item in select * from jsonb_array_elements(p_results) loop
    if not (item->>'bank'=any(r.banks)) then raise exception 'Unknown bank'; end if;
    update public.financing_results set status=item->>'status',offers=item->'offers' where request_id=p_id and bank=item->>'bank';
  end loop;
  update public.financing_requests set state='completed',lease_until=null,lease_token=null,
    requery_on=case when r.attempt=0 and c.allow_requery and p_requery>(r.first_started_at at time zone 'America/Sao_Paulo')::date
      and not exists(select 1 from public.financing_results where request_id=p_id and status<>'rejected')
      then p_requery else null end where id=p_id;
  insert into public.financing_events(request_id,event) values(p_id,'completed');
  insert into public.financing_alerts(request_id,organization_id,opportunity_id) values(p_id,r.organization_id,r.opportunity_id) on conflict do nothing;
  return true;
end $$;

create function public.financing_schedule_requeries() returns int language plpgsql security invoker set search_path='' as $$
declare r public.financing_requests; child uuid; n int:=0; today date:=(now() at time zone 'America/Sao_Paulo')::date;
begin
  -- A missed day is expired, never rolled forward indefinitely.
  update public.financing_requests set requery_on=null,requery_used=true where requery_on<today;
  for r in select * from public.financing_requests where requery_on=today and not requery_used and attempt=0 and state='completed'
    for update skip locked loop
    update public.financing_requests set requery_used=true,requery_on=null where id=r.id;
    if not exists(select 1 from public.financing_consents c join public.opportunities o on o.id=c.opportunity_id
      where c.id=r.consent_id and c.allow_requery and c.revoked_at is null and c.expires_at>now() and o.status='open') then continue; end if;
    if exists(select 1 from public.financing_results where request_id=r.id and status<>'rejected') then continue; end if;
    child:=gen_random_uuid();
    insert into public.financing_requests(id,root_id,organization_id,opportunity_id,consent_id,idempotency_key,fingerprint,vehicle_id,application_encrypted,banks,attempt,first_started_at,execute_on)
      values(child,r.root_id,r.organization_id,r.opportunity_id,r.consent_id,child,r.fingerprint,r.vehicle_id,r.application_encrypted,r.banks,1,r.first_started_at,today)
      on conflict(root_id,attempt) do nothing;
    if not found then continue; end if;
    insert into public.financing_results(request_id,bank,status) select child,unnest(r.banks),'pending';
    insert into public.financing_events(request_id,event) values(child,'requery_created'); n:=n+1;
  end loop;
  return n;
end $$;
-- Only service_role can invoke any new RPC, no SECURITY DEFINER bypass.
do $$ declare f text; begin
 foreach f in array array[
  'financing_create(uuid,uuid,uuid,uuid,text,bigint,text)',
  'financing_cancel(uuid,uuid)','financing_claim()',
  'financing_complete(uuid,uuid,jsonb,date)','financing_schedule_requeries()'] loop
   execute 'revoke all on function public.'||f||' from public,anon,authenticated';
   execute 'grant execute on function public.'||f||' to service_role';
 end loop;
end $$;
-- A closed sale must cancel immediately, even if reopened before a sweep.
-- Private trigger is not an RPC. Definer is needed because ordinary sellers
-- cannot access financing tables; scope is fixed to the row already authorized
-- by opportunities RLS. No user-controlled SQL or search_path.
create schema if not exists financing_private;
revoke all on schema financing_private from public,anon,authenticated;
create function financing_private.cancel_closed_sale() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.financing_events(request_id,event)
    select id,'cancelled' from public.financing_requests where opportunity_id=new.id and organization_id=new.organization_id
    and (state in ('queued','running') or requery_on is not null);
  update public.financing_requests set state=case when state='completed' then state else 'cancelled' end,
    requery_on=null,requery_used=true,lease_until=null,lease_token=null
    where opportunity_id=new.id and organization_id=new.organization_id;
  update public.financing_consents set revoked_at=coalesce(revoked_at,now())
    where opportunity_id=new.id and organization_id=new.organization_id;
  return new;
end $$;
revoke all on function financing_private.cancel_closed_sale() from public,anon,authenticated;
create trigger financing_cancel_closed_sale after update of status on public.opportunities
  for each row when (new.status<>'open' and old.status is distinct from new.status)
  execute function financing_private.cancel_closed_sale();
commit;
