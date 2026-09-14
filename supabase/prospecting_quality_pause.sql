-- Apply after prospecting_native_research.sql. No existing candidates are deleted.
begin;
alter table public.prospecting_runs add column if not exists enrichment_pause jsonb not null default '{}'::jsonb;
create index if not exists prospecting_research_requests_created_idx on public.prospecting_research_requests(created_at);

create or replace function public.prospecting_research_daily_budget()
returns jsonb language sql volatile security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('daily_limit',20,'daily_used',count(*),
    'resume_after',((date_trunc('day',now() at time zone 'America/Santiago')+interval '1 day') at time zone 'America/Santiago'))
  from public.prospecting_research_requests
  where created_at >= (date_trunc('day',now() at time zone 'America/Santiago') at time zone 'America/Santiago');
$$;
revoke all on function public.prospecting_research_daily_budget() from public,anon,authenticated;
grant execute on function public.prospecting_research_daily_budget() to service_role;

create or replace function public.fail_prospect_enrichment(p_job_id uuid,p_api_key_id uuid,p_worker_id text,p_lease_token uuid,p_error text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.prospect_enrichment_jobs%rowtype; v_status text; v_reason text; v_defer boolean:=false; v_pause jsonb;
begin
  perform pg_advisory_xact_lock(83276092);
  select * into v_job from public.prospect_enrichment_jobs where id=p_job_id for update;
  if not found then raise exception using errcode='P0002',message='Enrichment job not found'; end if;
  if v_job.status<>'running' or v_job.claimed_by_api_key is distinct from p_api_key_id or v_job.claimed_by_worker is distinct from trim(p_worker_id)
    or v_job.lease_token is distinct from p_lease_token then raise exception using errcode='42501',message='Invalid enrichment lease'; end if;
  v_reason:=substring(p_error from '^ResearchDeferred: (DAILY_LIMIT|RUN_LIMIT|INSUFFICIENT_BALANCE|RATE_LIMIT)$');
  -- Independently confirm budget state; a worker's free-text error alone cannot pause a run.
  if v_reason='DAILY_LIMIT' then
    select count(*)>=20 into v_defer from public.prospecting_research_requests
      where created_at >= (date_trunc('day',now() at time zone 'America/Santiago') at time zone 'America/Santiago');
  elsif v_reason in ('INSUFFICIENT_BALANCE','RATE_LIMIT') then
    select exists(select 1 from public.prospecting_research_requests where operation_id=p_job_id and run_id=v_job.run_id
      and kind='validation' and report->>'reason_code'=v_reason and completed_at is not null) into v_defer;
  end if;
  if v_defer then
    v_pause:=jsonb_build_object('reason_code',v_reason,'auto_resume',v_reason='DAILY_LIMIT');
    if v_reason='DAILY_LIMIT' then v_pause:=v_pause||public.prospecting_research_daily_budget(); end if;
    update public.prospect_enrichment_jobs set attempts=greatest(0,attempts-1) where id=p_job_id;
    update public.prospect_enrichment_jobs set status='paused',last_error='Investigacion pausada: '||v_reason,
      lease_token=null,lease_expires_at=null,claimed_by_api_key=null,claimed_by_worker=null,updated_at=now()
      where run_id=v_job.run_id and status in ('pending','running');
    update public.prospecting_campaign_candidates set enrichment_status='paused',enrichment_error='Investigacion pausada: '||v_reason
      where run_id=v_job.run_id and enrichment_status in ('pending','running');
    update public.prospecting_runs set enrichment_status='paused',enrichment_pause=v_pause,updated_at=now() where id=v_job.run_id;
    return jsonb_build_object('id',p_job_id,'status','paused','reason_code',v_reason,'enrichment_pause',v_pause);
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

create or replace function public.pause_prospect_enrichment(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.prospecting_require_roles(array['administrador']);
  perform pg_advisory_xact_lock(83276092);
  if not exists(select 1 from public.prospecting_runs where id=p_run_id) then raise exception 'Prospecting run not found'; end if;
  update public.prospect_enrichment_jobs set status='paused',lease_token=null,lease_expires_at=null,
    claimed_by_api_key=null,claimed_by_worker=null,updated_at=now() where run_id=p_run_id and status in ('pending','running');
  update public.prospecting_campaign_candidates set enrichment_status='paused'
    where run_id=p_run_id and enrichment_status in ('pending','running');
  update public.prospecting_runs set enrichment_status='paused',enrichment_pause='{"reason_code":"MANUAL","auto_resume":false}',updated_at=now()
    where id=p_run_id and enrichment_status in ('pending','running','paused');
  return (select jsonb_build_object('run_id',id,'status',enrichment_status,'enrichment_pause',enrichment_pause)
    from public.prospecting_runs where id=p_run_id);
end $$;

create or replace function public.resume_prospect_enrichment(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_run public.prospecting_runs%rowtype; v_pause jsonb; v_budget jsonb;
begin
  perform public.prospecting_require_roles(array['administrador']);
  perform pg_advisory_xact_lock(83276092);
  select * into v_run from public.prospecting_runs where id=p_run_id for update;
  if not found then raise exception 'Prospecting run not found'; end if;
  if v_run.status in ('paused','cancel_requested','cancelled') then
    raise exception 'La busqueda esta pausada o cancelada; no se puede reanudar su investigacion.';
  end if;
  if v_run.enrichment_status='paused' then
    v_budget:=public.prospecting_research_daily_budget();
    if coalesce((v_run.snapshot->>'deepseek_enabled')::boolean,false) and (v_budget->>'daily_used')::int >= (v_budget->>'daily_limit')::int then
      v_pause:=v_budget||jsonb_build_object('reason_code','DAILY_LIMIT','auto_resume',true);
      update public.prospecting_runs set enrichment_pause=v_pause,updated_at=now() where id=p_run_id;
      return jsonb_build_object('run_id',p_run_id,'status','paused','enrichment_pause',v_pause);
    end if;
    update public.prospect_enrichment_jobs set status='pending',last_error=null,updated_at=now() where run_id=p_run_id and status='paused';
    update public.prospecting_campaign_candidates set enrichment_status='pending',enrichment_error=null
      where run_id=p_run_id and enrichment_status='paused';
    update public.prospecting_runs set enrichment_status='pending',enrichment_pause='{}',enrichment_completed_at=null,updated_at=now() where id=p_run_id;
  end if;
  return (select jsonb_build_object('run_id',id,'status',enrichment_status,'enrichment_pause',enrichment_pause)
    from public.prospecting_runs where id=p_run_id);
end $$;

create or replace function public.claim_prospect_enrichment(p_api_key_id uuid,p_worker_id text,p_lease_seconds integer default 300)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.prospect_enrichment_jobs%rowtype; v_relation public.prospecting_campaign_candidates%rowtype;
  v_entity public.prospect_entities%rowtype; v_token uuid:=gen_random_uuid(); v_seconds integer:=least(greatest(coalesce(p_lease_seconds,300),60),600);
  v_run_id uuid; v_budget jsonb;
begin
  perform pg_advisory_xact_lock(83276092);
  v_budget:=public.prospecting_research_daily_budget();
  -- Only quota pauses scheduled by the new flow resume. Historical and manual
  -- pauses remain untouched; the original reservations prevent paid replays.
  if (v_budget->>'daily_used')::int < (v_budget->>'daily_limit')::int then
    for v_run_id in select id from public.prospecting_runs
      where enrichment_status='paused' and status not in ('paused','cancel_requested','cancelled')
        and enrichment_pause->>'reason_code'='DAILY_LIMIT' and enrichment_pause->>'auto_resume'='true'
        and (enrichment_pause->>'resume_after')::timestamptz<=now() for update skip locked
    loop
      update public.prospect_enrichment_jobs set status='pending',last_error=null,updated_at=now() where run_id=v_run_id and status='paused';
      update public.prospecting_campaign_candidates set enrichment_status='pending',enrichment_error=null where run_id=v_run_id and enrichment_status='paused';
      update public.prospecting_runs set enrichment_status='pending',enrichment_pause='{}',updated_at=now() where id=v_run_id;
      insert into public.prospecting_events(run_id,level,stage,message)
        values(v_run_id,'info','enrichment_resumed','Investigacion reanudada al renovarse el cupo diario de DeepSeek');
    end loop;
  end if;
  update public.prospect_enrichment_jobs set status=case when attempts>=max_attempts then 'failed' else 'pending' end,
    lease_token=null,lease_expires_at=null,claimed_by_api_key=null,claimed_by_worker=null,last_error=coalesce(last_error,'Worker lease expired'),updated_at=now()
    where status='running' and lease_expires_at<now();
  select job.* into v_job from public.prospect_enrichment_jobs job join public.prospecting_runs run on run.id=job.run_id
    where job.status='running' and job.claimed_by_api_key=p_api_key_id and job.claimed_by_worker=trim(p_worker_id)
      and job.lease_expires_at>=now() and run.enrichment_status in ('pending','running')
      and run.status not in ('paused','cancel_requested','cancelled') order by job.started_at for update of job limit 1;
  if not found then
    select job.* into v_job from public.prospect_enrichment_jobs job join public.prospecting_runs run on run.id=job.run_id
      where job.status='pending' and run.enrichment_status in ('pending','running') and run.status not in ('paused','cancel_requested','cancelled')
      order by job.created_at for update of job skip locked limit 1;
    if not found then return jsonb_build_object('job',null); end if;
    update public.prospect_enrichment_jobs set status='running',attempts=attempts+1,claimed_by_api_key=p_api_key_id,
      claimed_by_worker=trim(p_worker_id),lease_token=v_token,lease_expires_at=now()+make_interval(secs=>v_seconds),
      started_at=coalesce(started_at,now()),updated_at=now() where id=v_job.id returning * into v_job;
  end if;
  select * into v_relation from public.prospecting_campaign_candidates where id=v_job.candidate_relation_id;
  select * into v_entity from public.prospect_entities where id=v_job.entity_id;
  update public.prospecting_runs set enrichment_status='running',enrichment_pause='{}',enrichment_started_at=coalesce(enrichment_started_at,now()),updated_at=now() where id=v_job.run_id;
  update public.prospecting_campaign_candidates set enrichment_status='running' where id=v_job.candidate_relation_id;
  return jsonb_build_object('job',to_jsonb(v_job)-'lease_token','lease_token',v_job.lease_token,'lease_expires_at',v_job.lease_expires_at,
    'candidate',case when v_relation.candidate_snapshot<>'{}'::jsonb then v_relation.candidate_snapshot else
      jsonb_build_object('candidate_id',v_relation.external_candidate_id,'name',v_entity.name,'trade_name',v_entity.legal_name,
        'rut',v_entity.rut,'phone',v_entity.phone,'email',v_entity.email,'website',v_entity.website,
        'description',v_entity.description,'company_summary',v_entity.company_summary,
        'location',jsonb_build_object('country_code','CL')) end);
end $$;
revoke all on function public.pause_prospect_enrichment(uuid),public.resume_prospect_enrichment(uuid),
  public.claim_prospect_enrichment(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.pause_prospect_enrichment(uuid),public.resume_prospect_enrichment(uuid) to authenticated;
grant execute on function public.claim_prospect_enrichment(uuid,text,integer) to service_role;
notify pgrst,'reload schema';
commit;
