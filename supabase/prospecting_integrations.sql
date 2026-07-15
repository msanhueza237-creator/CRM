begin;

create table if not exists public.prospecting_integration_status (
  provider text primary key check (provider in ('google_places', 'brave_search')),
  configured boolean not null default false,
  status text not null default 'not_configured'
    check (status in ('not_configured', 'pending', 'checking', 'connected', 'quota_exhausted', 'error')),
  message text not null default 'Sin verificar',
  error_code text,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  worker_id text,
  api_key_id uuid references public.agent_api_keys(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.prospecting_integration_checks (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('google_places', 'brave_search')),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'completed', 'failed')),
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  result_status text,
  created_at timestamptz not null default now()
);

create index if not exists prospecting_integration_checks_pending_idx
  on public.prospecting_integration_checks (status, requested_at);

insert into public.prospecting_integration_status (provider, message)
values
  ('google_places', 'Google Places aun no ha sido verificado.'),
  ('brave_search', 'Brave Search aun no ha sido configurado.')
on conflict (provider) do nothing;

create or replace function public.request_prospecting_integration_check(p_provider text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check_id uuid;
begin
  if auth.uid() is null or coalesce(public.current_role()::text, '') <> 'administrador' then
    raise exception 'Only administrators can request integration checks' using errcode = '42501';
  end if;
  if p_provider not in ('google_places', 'brave_search') then
    raise exception 'Unsupported integration provider' using errcode = '22023';
  end if;

  select id into v_check_id
  from public.prospecting_integration_checks
  where provider = p_provider
    and status in ('pending', 'claimed')
    and requested_at > now() - interval '5 minutes'
  order by requested_at desc
  limit 1;

  if v_check_id is null then
    insert into public.prospecting_integration_checks (provider, requested_by)
    values (p_provider, auth.uid())
    returning id into v_check_id;
  end if;

  update public.prospecting_integration_status
  set status = 'pending',
      message = 'Prueba solicitada. Esperando al agente...',
      error_code = null,
      updated_at = now()
  where provider = p_provider;

  return v_check_id;
end;
$$;

create or replace function public.claim_prospecting_integration_check(
  p_api_key_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check public.prospecting_integration_checks%rowtype;
begin
  if p_api_key_id is null or nullif(trim(p_worker_id), '') is null then
    raise exception 'API key and worker id are required' using errcode = '22023';
  end if;

  select * into v_check
  from public.prospecting_integration_checks
  where status = 'pending'
  order by requested_at
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('check', null);
  end if;

  update public.prospecting_integration_checks
  set status = 'claimed', claimed_by = trim(p_worker_id), claimed_at = now()
  where id = v_check.id;

  update public.prospecting_integration_status
  set status = 'checking',
      message = 'El agente esta probando la conexion...',
      worker_id = trim(p_worker_id),
      api_key_id = p_api_key_id,
      updated_at = now()
  where provider = v_check.provider;

  return jsonb_build_object(
    'check', jsonb_build_object('id', v_check.id, 'provider', v_check.provider)
  );
end;
$$;

create or replace function public.report_prospecting_integration_status(
  p_api_key_id uuid,
  p_worker_id text,
  p_check_id uuid,
  p_provider text,
  p_configured boolean,
  p_status text,
  p_message text,
  p_error_code text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_provider not in ('google_places', 'brave_search')
     or p_status not in ('not_configured', 'pending', 'connected', 'quota_exhausted', 'error')
     or nullif(trim(p_worker_id), '') is null
     or nullif(trim(p_message), '') is null then
    raise exception 'Invalid integration status payload' using errcode = '22023';
  end if;

  insert into public.prospecting_integration_status (
    provider, configured, status, message, error_code, last_checked_at,
    last_success_at, worker_id, api_key_id, metadata, updated_at
  ) values (
    p_provider, p_configured, p_status, left(trim(p_message), 500), nullif(trim(p_error_code), ''), now(),
    case when p_status = 'connected' then now() else null end,
    trim(p_worker_id), p_api_key_id, coalesce(p_metadata, '{}'::jsonb), now()
  )
  on conflict (provider) do update set
    configured = excluded.configured,
    status = excluded.status,
    message = excluded.message,
    error_code = excluded.error_code,
    last_checked_at = excluded.last_checked_at,
    last_success_at = case
      when excluded.status = 'connected' then excluded.last_checked_at
      else public.prospecting_integration_status.last_success_at
    end,
    worker_id = excluded.worker_id,
    api_key_id = excluded.api_key_id,
    metadata = excluded.metadata,
    updated_at = now();

  update public.prospecting_integration_checks
  set status = case when p_status = 'connected' then 'completed' else 'failed' end,
      completed_at = now(),
      result_status = p_status
  where id = p_check_id
    and provider = p_provider
    and status = 'claimed'
    and claimed_by = trim(p_worker_id);

  return jsonb_build_object('ok', true, 'provider', p_provider, 'status', p_status);
end;
$$;

alter table public.prospecting_integration_status enable row level security;
alter table public.prospecting_integration_checks enable row level security;

drop policy if exists prospecting_integration_status_admin_read on public.prospecting_integration_status;
create policy prospecting_integration_status_admin_read
on public.prospecting_integration_status for select to authenticated
using (public.current_role() = 'administrador');

drop policy if exists prospecting_integration_checks_admin_read on public.prospecting_integration_checks;
create policy prospecting_integration_checks_admin_read
on public.prospecting_integration_checks for select to authenticated
using (public.current_role() = 'administrador');

revoke all on table public.prospecting_integration_status from public, anon;
revoke all on table public.prospecting_integration_checks from public, anon;
grant select on table public.prospecting_integration_status to authenticated;
grant select on table public.prospecting_integration_checks to authenticated;

revoke all on function public.request_prospecting_integration_check(text) from public;
revoke all on function public.claim_prospecting_integration_check(uuid, text) from public;
revoke all on function public.report_prospecting_integration_status(uuid, text, uuid, text, boolean, text, text, text, jsonb) from public;
grant execute on function public.request_prospecting_integration_check(text) to authenticated;
grant execute on function public.claim_prospecting_integration_check(uuid, text) to service_role;
grant execute on function public.report_prospecting_integration_status(uuid, text, uuid, text, boolean, text, text, text, jsonb) to service_role;

commit;
