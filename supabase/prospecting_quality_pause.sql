-- Apply after prospecting_native_research.sql. No existing candidates are deleted.
begin;
create or replace function public.fail_prospect_enrichment(p_job_id uuid,p_api_key_id uuid,p_worker_id text,p_lease_token uuid,p_error text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.prospect_enrichment_jobs%rowtype; v_status text; v_reason text; v_defer boolean:=false;
begin
  select * into v_job from public.prospect_enrichment_jobs where id=p_job_id for update;
  if not found then raise exception using errcode='P0002',message='Enrichment job not found'; end if;
  if v_job.status<>'running' or v_job.claimed_by_api_key is distinct from p_api_key_id or v_job.claimed_by_worker is distinct from trim(p_worker_id)
    or v_job.lease_token is distinct from p_lease_token then raise exception using errcode='42501',message='Invalid enrichment lease'; end if;
  v_reason:=substring(p_error from '^ResearchDeferred: (DAILY_LIMIT|RUN_LIMIT|INSUFFICIENT_BALANCE|RATE_LIMIT)$');
  -- Independently confirm budget state; a worker's free-text error alone cannot pause a run.
  if v_reason='DAILY_LIMIT' then
    select count(*)>=20 into v_defer from public.prospecting_research_requests
      where created_at >= (date_trunc('day',now() at time zone 'America/Santiago') at time zone 'America/Santiago');
  elsif v_reason='RUN_LIMIT' then
    select count(*)>=20 into v_defer from public.prospecting_research_requests where run_id=v_job.run_id and kind='validation';
  elsif v_reason in ('INSUFFICIENT_BALANCE','RATE_LIMIT') then
    select exists(select 1 from public.prospecting_research_requests where operation_id=p_job_id and run_id=v_job.run_id
      and kind='validation' and report->>'reason_code'=v_reason and completed_at is not null) into v_defer;
  end if;
  if v_defer then
    update public.prospect_enrichment_jobs set attempts=greatest(0,attempts-1) where id=p_job_id;
    update public.prospect_enrichment_jobs set status='paused',last_error='Investigacion pausada: '||v_reason,
      lease_token=null,lease_expires_at=null,claimed_by_api_key=null,claimed_by_worker=null,updated_at=now()
      where run_id=v_job.run_id and status in ('pending','running');
    update public.prospecting_campaign_candidates set enrichment_status='paused',enrichment_error='Investigacion pausada: '||v_reason
      where run_id=v_job.run_id and enrichment_status in ('pending','running');
    update public.prospecting_runs set enrichment_status='paused',updated_at=now() where id=v_job.run_id;
    return jsonb_build_object('id',p_job_id,'status','paused','reason_code',v_reason);
  end if;
  v_status:=case when v_job.attempts>=v_job.max_attempts then 'failed' else 'pending' end;
  update public.prospect_enrichment_jobs set status=v_status,last_error=left(coalesce(p_error,'Unknown enrichment error'),4000),lease_token=null,lease_expires_at=null,
    claimed_by_api_key=null,claimed_by_worker=null,completed_at=case when v_status='failed' then now() else null end,updated_at=now() where id=p_job_id;
  update public.prospecting_campaign_candidates set enrichment_status=v_status,enrichment_error=left(coalesce(p_error,'Unknown enrichment error'),4000) where id=v_job.candidate_relation_id;
  perform public.refresh_prospect_enrichment_progress(v_job.run_id);
  return jsonb_build_object('id',p_job_id,'status',v_status);
end $$;
revoke all on function public.fail_prospect_enrichment(uuid,uuid,text,uuid,text) from public;
grant execute on function public.fail_prospect_enrichment(uuid,uuid,text,uuid,text) to service_role;
commit;
