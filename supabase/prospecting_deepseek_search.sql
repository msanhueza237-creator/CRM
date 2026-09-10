-- Apply after prospecting.sql and prospecting_deepseek_settings.sql.
-- Opt-in only. No candidate, company, source evidence or accounting changes.
begin;
alter table public.prospecting_campaigns add column if not exists deepseek_enabled boolean not null default false;
alter table public.prospecting_runs add column if not exists search_assistance jsonb not null default '{}'::jsonb;

create or replace function public.freeze_prospecting_search_assistance()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_enabled boolean;
begin
  select deepseek_enabled into v_enabled from public.prospecting_campaigns where id = new.campaign_id;
  new.snapshot := coalesce(new.snapshot, '{}'::jsonb) || jsonb_build_object('deepseek_enabled', coalesce(v_enabled, false));
  new.search_assistance := jsonb_build_object('status', case when v_enabled then 'pending' else 'disabled' end);
  return new;
end; $$;
drop trigger if exists freeze_prospecting_search_assistance on public.prospecting_runs;
create trigger freeze_prospecting_search_assistance before insert on public.prospecting_runs
for each row execute function public.freeze_prospecting_search_assistance();

create or replace function public.version_prospecting_search_assistance()
returns trigger language plpgsql as $$
begin
  if new.deepseek_enabled is distinct from old.deepseek_enabled then
    new.version := greatest(new.version, old.version + 1);
  end if;
  return new;
end; $$;
drop trigger if exists zz_version_prospecting_search_assistance on public.prospecting_campaigns;
create trigger zz_version_prospecting_search_assistance before update on public.prospecting_campaigns
for each row execute function public.version_prospecting_search_assistance();

create table if not exists public.prospecting_search_reservations (
  run_id uuid primary key references public.prospecting_runs(id) on delete cascade,
  reservation_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  attempted boolean not null default false,
  report jsonb not null
);
alter table public.prospecting_search_reservations enable row level security;
revoke all on public.prospecting_search_reservations from public, anon, authenticated;
grant select, insert, update on public.prospecting_search_reservations to service_role;

create or replace function public.reserve_prospecting_search_assistance(
  p_run_id uuid, p_api_key_id uuid, p_worker_id text, p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_run public.prospecting_runs%rowtype; v_res public.prospecting_search_reservations%rowtype;
  v_count integer; v_report jsonb;
begin
  -- Serialize the daily cap and same-run reservations, including concurrent workers.
  perform pg_advisory_xact_lock(83276091);
  select * into v_run from public.prospecting_runs where id = p_run_id for update;
  if not found or v_run.claimed_by_api_key is distinct from p_api_key_id
    or v_run.claimed_by_worker is distinct from trim(p_worker_id)
    or v_run.lease_token is distinct from p_lease_token or v_run.status <> 'running'
    or v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    raise exception using errcode = '42501', message = 'Invalid active run lease';
  end if;
  if v_run.snapshot->>'deepseek_enabled' is distinct from 'true' then
    return jsonb_build_object('status','disabled');
  end if;
  select * into v_res from public.prospecting_search_reservations where run_id = p_run_id;
  if found then
    if v_res.report->>'status' = 'preparing' then
      -- Never repeat an uncertain paid request or change a plan after tasks start.
      v_report := jsonb_build_object('status','fallback','reason_code','INTERRUPTED','queries','[]'::jsonb,'completed_at',now());
      update public.prospecting_search_reservations set report = v_report where run_id = p_run_id;
      update public.prospecting_runs set search_assistance = v_report where id = p_run_id;
      return v_report;
    end if;
    return v_res.report;
  end if;
  select count(*) into v_count from public.prospecting_search_reservations
    where attempted and created_at >= (date_trunc('day', now() at time zone 'America/Santiago') at time zone 'America/Santiago');
  v_report := jsonb_build_object('status',case when v_count < 20 then 'preparing' else 'fallback' end,
    'reason_code',case when v_count >= 20 then 'DAILY_LIMIT' else null end,'queries','[]'::jsonb,'started_at',now());
  insert into public.prospecting_search_reservations(run_id, attempted, report)
    values(p_run_id, v_count < 20, v_report) returning * into v_res;
  update public.prospecting_runs set search_assistance = v_report where id = p_run_id;
  return v_report || case when v_count < 20 then jsonb_build_object('reservation_token',v_res.reservation_token) else '{}'::jsonb end;
end; $$;

create or replace function public.finish_prospecting_search_assistance(
  p_run_id uuid, p_reservation_token uuid, p_report jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_res public.prospecting_search_reservations%rowtype; v_report jsonb;
begin
  perform pg_advisory_xact_lock(83276091);
  select * into v_res from public.prospecting_search_reservations where run_id = p_run_id for update;
  if not found or v_res.reservation_token is distinct from p_reservation_token then
    raise exception using errcode = '42501', message = 'Invalid search reservation';
  end if;
  if v_res.report->>'status' <> 'preparing' then return v_res.report; end if;
  if p_report->>'status' is null or p_report->>'status' not in ('applied','fallback')
    or octet_length(p_report::text) > 120000 then raise exception 'Invalid search report'; end if;
  v_report := p_report || jsonb_build_object('started_at',v_res.created_at,'completed_at',now());
  update public.prospecting_search_reservations set report = v_report where run_id = p_run_id;
  update public.prospecting_runs set search_assistance = v_report where id = p_run_id;
  return v_report;
end; $$;

revoke all on function public.reserve_prospecting_search_assistance(uuid,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.finish_prospecting_search_assistance(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.reserve_prospecting_search_assistance(uuid,uuid,text,uuid) to service_role;
grant execute on function public.finish_prospecting_search_assistance(uuid,uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
