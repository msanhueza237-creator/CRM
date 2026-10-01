-- Manual Facto consolidation safety. Apply after accounting_facto_history.sql.
-- Does not repair/cancel historical runs or change financial data during installation.
begin;

alter table public.accounting_facto_sync_runs
  add column if not exists heartbeat_at timestamptz,
  add column if not exists lease_expires_at timestamptz;

create table if not exists public.accounting_facto_sync_leases (
  entity_id uuid primary key references public.accounting_entities(id),
  run_id uuid not null unique references public.accounting_facto_sync_runs(id),
  token uuid not null,
  expires_at timestamptz not null
);
alter table public.accounting_facto_sync_leases enable row level security;
revoke all on public.accounting_facto_sync_leases from public, anon, authenticated;
grant all on public.accounting_facto_sync_leases to service_role;

create or replace function public.accounting_claim_facto_sync(
  p_entity_id uuid, p_from_date date, p_to_date date, p_actor_id uuid, p_request_id text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_lease public.accounting_facto_sync_leases%rowtype;
  v_run public.accounting_facto_sync_runs%rowtype;
  v_id uuid; v_token uuid := gen_random_uuid(); v_now timestamptz;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required'; end if;
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date then
    raise exception 'invalid_facto_range';
  end if;
  -- Serialize claims without blocking FK KEY SHARE locks held by an active writer.
  perform 1 from public.accounting_entities where id=p_entity_id and active for no key update;
  if not found then raise exception 'inactive_accounting_entity'; end if;
  select * into v_lease from public.accounting_facto_sync_leases where entity_id=p_entity_id for update;
  v_now := clock_timestamp();
  if v_lease.run_id is not null then
    select * into v_run from public.accounting_facto_sync_runs where id=v_lease.run_id for update;
    if v_run.status='running' and v_lease.expires_at > v_now then
      return jsonb_build_object('acquired',false,'runId',v_run.id,'reason','active');
    end if;
    if v_run.status='running' then
      update public.accounting_facto_sync_runs set status='failed',completed_at=v_now,updated_at=v_now,
        error_message='FACTO_SYNC_LEASE_EXPIRED: ejecución interrumpida; puede haber lotes ya guardados.'
        where id=v_run.id;
    end if;
  end if;
  -- Legacy runs have no fencing token. Age alone cannot prove they stopped.
  select * into v_run from public.accounting_facto_sync_runs
    where entity_id=p_entity_id and status='running' and lease_expires_at is null
    order by created_at limit 1;
  if found then return jsonb_build_object('acquired',false,'runId',v_run.id,'reason','legacy_review_required'); end if;
  insert into public.accounting_facto_sync_runs(entity_id,from_date,to_date,status,requested_by,summary,heartbeat_at,lease_expires_at)
    values(p_entity_id,p_from_date,p_to_date,'running',p_actor_id,
      jsonb_build_object('request_id',p_request_id,'source','integration_records/facto','accounting_policy','document_only'),
      v_now,v_now+interval '3 minutes') returning id into v_id;
  insert into public.accounting_facto_sync_leases(entity_id,run_id,token,expires_at)
    values(p_entity_id,v_id,v_token,v_now+interval '3 minutes')
    on conflict(entity_id) do update set run_id=excluded.run_id,token=excluded.token,expires_at=excluded.expires_at;
  return jsonb_build_object('acquired',true,'runId',v_id,'token',v_token);
end $$;

create or replace function public.accounting_assert_facto_sync(p_run_id uuid,p_token uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_lease public.accounting_facto_sync_leases%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required'; end if;
  -- Held to transaction end. A replacement cannot acquire the lease while a write commits.
  select * into v_lease from public.accounting_facto_sync_leases where run_id=p_run_id for update;
  if not found or v_lease.token is distinct from p_token or v_lease.expires_at <= clock_timestamp()
    or not exists(select 1 from public.accounting_facto_sync_runs where id=p_run_id and status='running') then
    raise exception 'FACTO_SYNC_LEASE_LOST';
  end if;
  return v_lease.entity_id;
end $$;

create or replace function public.accounting_heartbeat_facto_sync(p_run_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_now timestamptz;
begin
  perform public.accounting_assert_facto_sync(p_run_id,p_token);
  v_now := clock_timestamp();
  update public.accounting_facto_sync_leases set expires_at=v_now+interval '3 minutes' where run_id=p_run_id;
  update public.accounting_facto_sync_runs set heartbeat_at=v_now,lease_expires_at=v_now+interval '3 minutes',updated_at=v_now where id=p_run_id;
end $$;

create or replace function public.accounting_finish_facto_sync(p_run_id uuid,p_token uuid,p_status text,p_error text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_status not in ('completed','partial','failed','cancelled') then raise exception 'invalid_terminal_status'; end if;
  perform public.accounting_assert_facto_sync(p_run_id,p_token);
  update public.accounting_facto_sync_runs set status=p_status,error_message=left(p_error,1000),
    completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_run_id;
  update public.accounting_facto_sync_leases set expires_at=clock_timestamp() where run_id=p_run_id;
end $$;

-- PostgREST passes these server-only headers to every existing mutation helper.
-- No generic SQL executor or alternate synchronization path is exposed.
create or replace function public.accounting_guard_facto_sync_write()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_headers jsonb := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  v_run uuid; v_entity uuid; v_row jsonb;
begin
  if not (v_headers ? 'x-facto-sync-run') then
    if TG_OP='DELETE' then return OLD; else return NEW; end if;
  end if;
  v_run := (v_headers->>'x-facto-sync-run')::uuid;
  v_entity := public.accounting_assert_facto_sync(v_run,(v_headers->>'x-facto-sync-token')::uuid);
  if TG_OP='DELETE' then v_row:=to_jsonb(OLD); else v_row:=to_jsonb(NEW); end if;
  if (v_row ? 'entity_id' and (v_row->>'entity_id')::uuid is distinct from v_entity)
    or (TG_TABLE_NAME='accounting_facto_sync_records' and (v_row->>'run_id')::uuid is distinct from v_run)
    or (TG_TABLE_NAME='accounting_facto_sync_runs' and (v_row->>'id')::uuid is distinct from v_run) then
    raise exception 'FACTO_SYNC_ENTITY_MISMATCH';
  end if;
  if TG_TABLE_NAME='accounting_source_documents' and TG_OP='UPDATE' then
    if OLD.status not in ('pending','validated','inconsistent') then return null; end if;
    if OLD.source_updated_at is not null and (NEW.source_updated_at is null or NEW.source_updated_at < OLD.source_updated_at) then return null; end if;
  end if;
  if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;

create or replace function public.accounting_lock_facto_sync_statement()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_headers jsonb := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
begin
  if v_headers ? 'x-facto-sync-run' then
    perform public.accounting_assert_facto_sync((v_headers->>'x-facto-sync-run')::uuid,(v_headers->>'x-facto-sync-token')::uuid);
  end if;
  return null;
end $$;

do $$ declare v_table text; begin
  foreach v_table in array array['accounting_source_documents','accounting_receivables','accounting_payables',
    'accounting_facto_sync_records','accounting_facto_sync_runs','accounting_audit_events','accounting_control_findings'] loop
    execute format('drop trigger if exists accounting_facto_sync_write_guard on public.%I',v_table);
    execute format('drop trigger if exists accounting_facto_sync_statement_lock on public.%I',v_table);
    execute format('create trigger accounting_facto_sync_statement_lock before insert or update or delete on public.%I for each statement execute function public.accounting_lock_facto_sync_statement()',v_table);
    execute format('create trigger accounting_facto_sync_write_guard before insert or update or delete on public.%I for each row execute function public.accounting_guard_facto_sync_write()',v_table);
  end loop;
end $$;

revoke all on function public.accounting_claim_facto_sync(uuid,date,date,uuid,text) from public,anon,authenticated;
revoke all on function public.accounting_assert_facto_sync(uuid,uuid) from public,anon,authenticated;
revoke all on function public.accounting_heartbeat_facto_sync(uuid,uuid) from public,anon,authenticated;
revoke all on function public.accounting_finish_facto_sync(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.accounting_guard_facto_sync_write() from public,anon,authenticated;
revoke all on function public.accounting_lock_facto_sync_statement() from public,anon,authenticated;
grant execute on function public.accounting_claim_facto_sync(uuid,date,date,uuid,text),
  public.accounting_assert_facto_sync(uuid,uuid),public.accounting_heartbeat_facto_sync(uuid,uuid),
  public.accounting_finish_facto_sync(uuid,uuid,text,text) to service_role;
commit;
