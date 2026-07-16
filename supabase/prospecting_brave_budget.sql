begin;

create table if not exists public.prospecting_provider_settings (
  provider text primary key check (provider = 'brave_search'),
  monthly_limit_usd numeric(8,2) not null default 5 check (monthly_limit_usd between 1 and 1000),
  free_credit_usd numeric(8,2) not null default 5 check (free_credit_usd between 0 and 1000),
  social_search_enabled boolean not null default false,
  max_social_queries_per_campaign integer not null default 6 check (max_social_queries_per_campaign between 0 and 100),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.prospecting_provider_settings (provider)
values ('brave_search') on conflict (provider) do nothing;

alter table public.prospecting_provider_settings enable row level security;
drop policy if exists prospecting_provider_settings_admin_read on public.prospecting_provider_settings;
create policy prospecting_provider_settings_admin_read on public.prospecting_provider_settings
for select to authenticated using (public.current_role() = 'administrador');
drop policy if exists prospecting_provider_settings_admin_update on public.prospecting_provider_settings;
create policy prospecting_provider_settings_admin_update on public.prospecting_provider_settings
for update to authenticated using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

revoke all on public.prospecting_provider_settings from public, anon;
grant select, update on public.prospecting_provider_settings to authenticated;
grant select on public.prospecting_provider_settings to service_role;

commit;
