-- External simulations have no catalog inventory row. Their vehicle remains
-- exclusively inside the encrypted application; existing inventory links stay intact.
alter table public.financing_requests alter column vehicle_id drop not null;
alter table public.financing_requests
  add constraint financing_vehicle_id_positive check (vehicle_id is null or vehicle_id > 0),
  add column vehicle_source text generated always as
    (case when vehicle_id is null then 'external'::text else 'stock'::text end) stored;
comment on column public.financing_requests.vehicle_id is 'Catalog inventory ID; null for an external vehicle contained in the encrypted application.';
comment on column public.financing_requests.vehicle_source is 'Derived origin; callers cannot override it. Existing create/requery RPCs preserve nullable vehicle_id.';
-- Existing service-only table/function permissions and RLS remain in force.
