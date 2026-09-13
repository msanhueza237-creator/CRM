-- Apply after prospecting_native_research.sql in the coordinated worker/API release.
begin;
create or replace function public.stage_google_prospecting_candidates(
  p_run_id uuid,p_task_id uuid,p_api_key_id uuid,p_worker_id text,p_lease_token uuid,p_candidates jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_run public.prospecting_runs%rowtype; v_task public.prospecting_tasks%rowtype;
  v_hit jsonb; v_evidence jsonb; v_id text; v_key text; v_name text;
  v_entity uuid; v_relation uuid; v_count integer; v_limit integer; v_added integer:=0; v_duplicates integer:=0;
begin
  select * into v_run from public.prospecting_runs where id=p_run_id for update;
  if not found or v_run.status<>'running' or v_run.claimed_by_api_key is distinct from p_api_key_id
    or v_run.claimed_by_worker is distinct from trim(p_worker_id) or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at is null or v_run.lease_expires_at<=now()
    or v_run.snapshot->>'discovery_strategy' is distinct from 'google_places_first' then
    raise exception using errcode='42501',message='Invalid Google discovery lease'; end if;
  select * into v_task from public.prospecting_tasks where id=p_task_id and run_id=p_run_id and source='google_places';
  if not found then raise exception using errcode='42501',message='Invalid Google discovery task'; end if;
  if jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_array_length(p_candidates)>200 then
    raise exception using errcode='22023',message='Invalid Google discovery batch'; end if;
  v_limit:=least(1000,greatest(1,(v_run.snapshot#>>'{campaign,max_candidates}')::integer));
  select count(*) into v_count from public.prospecting_campaign_candidates where run_id=p_run_id;
  for v_hit in select value from jsonb_array_elements(p_candidates) loop
    v_id:=nullif(trim(v_hit#>>'{provider_ids,google_places}'),'');
    v_name:=nullif(trim(v_hit->>'name'),'');
    if v_id is null or length(v_id)>300 or v_name is null or length(v_name)>300
      or v_hit#>>'{location,country_code}' is distinct from 'CL'
      or v_hit#>>'{location,comuna_code}' is distinct from v_task.comuna_code
      or v_hit#>>'{location,region_code}' is distinct from v_task.region_code then
      raise exception using errcode='22023',message='Google hint requires place identity and task territory'; end if;
    v_key:='google:'||md5(v_id);
    if exists(select 1 from public.prospecting_campaign_candidates where run_id=p_run_id and external_candidate_id=v_key) then
      v_duplicates:=v_duplicates+1; continue; end if;
    exit when v_count>=v_limit;
    insert into public.prospect_entities(name,name_normalized)
      values(v_name,public.normalize_prospect_name(v_name)) returning id into v_entity;
    -- Google payloads remain expiring evidence. Never copy them to discovery_origin,
    -- permanent company records or AI-authored facts. The existing purge scrubs snapshots.
    insert into public.prospecting_campaign_candidates(run_id,campaign_id,entity_id,external_candidate_id,
      candidate_snapshot,discovery_origin,discovery_status,enrichment_status)
    values(p_run_id,v_run.campaign_id,v_entity,v_key,jsonb_build_object(
      'candidate_id',v_key,'name',v_name,'website',v_hit->>'website','location',v_hit->'location',
      'phone',v_hit->>'phone','description',v_hit->>'description',
      'locations',jsonb_build_array(v_hit->'location'),'evidence','[]'::jsonb,
      'import_eligible',false,'importable_location_indexes','[]'::jsonb,
      'market_signals',jsonb_build_object('google_discovery',true),'review_flags',jsonb_build_array('discovery_pending')),
      jsonb_build_object('provider','google_places','place_id',v_id,'task_id',p_task_id,'observed_at',now()),
      'pending','pending') returning id into v_relation;
    for v_evidence in select value from jsonb_array_elements(coalesce(v_hit->'evidence','[]'::jsonb)) loop
      if v_evidence->>'provider'='google_places' and v_evidence->>'provider_record_id'=v_id then
        insert into public.prospect_source_records(entity_id,run_id,provider,provider_record_id,source_url,
          field_name,field_value,observed_at,retention_until,metadata)
        values(v_entity,p_run_id,'google_places',v_id,v_evidence->>'source_url',
          v_evidence->>'field',v_evidence->>'value',least(now(),(v_evidence->>'observed_at')::timestamptz),
          least(now()+interval '30 days',(v_evidence->>'observed_at')::timestamptz+interval '30 days'),
          jsonb_build_object('task_id',p_task_id));
      end if;
    end loop;
    if not exists(select 1 from public.prospect_source_records where entity_id=v_entity and field_name='name'
      and field_value=v_name and retention_until>now()) then
      raise exception using errcode='22023',message='Google hint requires current source evidence'; end if;
    insert into public.prospect_enrichment_jobs(run_id,candidate_relation_id,entity_id) values(p_run_id,v_relation,v_entity);
    v_added:=v_added+1; v_count:=v_count+1;
  end loop;
  update public.prospecting_runs set candidates_found=v_count,
    enrichment_total=(select count(*) from public.prospect_enrichment_jobs where run_id=p_run_id),
    enrichment_status=case when enrichment_status='paused' or v_added=0 then enrichment_status else 'pending' end,
    enrichment_completed_at=case when v_added>0 then null else enrichment_completed_at end,updated_at=now() where id=p_run_id;
  return jsonb_build_object('added',v_added,'duplicates',v_duplicates,'candidates_found',v_count,'limit_reached',v_count>=v_limit);
end $$;
revoke all on function public.stage_google_prospecting_candidates(uuid,uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.stage_google_prospecting_candidates(uuid,uuid,uuid,text,uuid,jsonb) to service_role;

create or replace function public.require_google_candidate_analysis()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if old.discovery_origin->>'provider'='google_places' and new.enrichment_status='completed'
    and (old.enrichment_status is distinct from 'completed' or new.candidate_snapshot is distinct from old.candidate_snapshot) then
    if not exists(select 1 from public.prospecting_research_requests r
      join public.prospect_enrichment_jobs j on j.id=r.operation_id
      where j.candidate_relation_id=old.id and r.kind='validation' and r.completed_at is not null
        and r.report->>'analysis_version'='climactiva-google-v1' and r.report->>'status'='applied') then
      raise exception using errcode='42501',message='Google candidates require DeepSeek analysis'; end if;
    if coalesce(new.candidate_snapshot->>'import_eligible','false')='true' and not exists(
      select 1 from public.prospecting_research_requests r join public.prospect_enrichment_jobs j on j.id=r.operation_id
      where j.candidate_relation_id=old.id and r.kind='validation' and r.completed_at is not null
        and r.report->>'analysis_accepted'='true') then
      raise exception using errcode='42501',message='DeepSeek did not confirm Climactiva fit'; end if;
  end if;
  return new;
end $$;
drop trigger if exists aa_google_candidate_analysis on public.prospecting_campaign_candidates;
create trigger aa_google_candidate_analysis before update on public.prospecting_campaign_candidates
for each row execute function public.require_google_candidate_analysis();
commit;
