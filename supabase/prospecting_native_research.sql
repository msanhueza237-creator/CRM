-- Coordinated CRM/worker v3 release. Apply after prospecting_discovery_candidates.sql.
-- Preserves historical evidence and run snapshots. Does not modify accounting.
begin;
alter table public.prospecting_campaigns drop constraint if exists prospecting_campaign_sources_allowed;
alter table public.prospecting_campaigns add constraint prospecting_campaign_sources_allowed
  check (sources <@ array['google_places','deepseek_web','brave_search','official_website']::text[]);
alter table public.prospecting_campaigns alter column sources set default array['deepseek_web','google_places','official_website'];
alter table public.prospecting_campaigns drop constraint if exists prospecting_campaign_deepseek_requires_official;
alter table public.prospecting_campaigns add constraint prospecting_campaign_deepseek_requires_official
  check (not ('deepseek_web'=any(sources)) or ('official_website'=any(sources) and deepseek_enabled));

create or replace function public.prepare_native_prospecting_campaign()
returns trigger language plpgsql as $$
begin
  new.sources:=array(select distinct case when s='brave_search' then 'deepseek_web' else s end from unnest(new.sources) s);
  new.deepseek_enabled:='deepseek_web'=any(new.sources);
  if new.deepseek_enabled and not ('official_website'=any(new.sources)) then new.sources:=array_append(new.sources,'official_website'); end if;
  return new;
end $$;
drop trigger if exists aa_native_prospecting_campaign on public.prospecting_campaigns;
create trigger aa_native_prospecting_campaign before insert or update on public.prospecting_campaigns
for each row execute function public.prepare_native_prospecting_campaign();
update public.prospecting_campaigns set sources=sources where 'brave_search'=any(sources);

create or replace function public.enqueue_prospecting_run(
  p_campaign_id uuid,
  p_requested_by uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign public.prospecting_campaigns%rowtype;
  v_run_id uuid := gen_random_uuid();
  v_comuna_codes text[];
  v_territories jsonb;
  v_snapshot jsonb;
  v_task_count integer;
  v_requester uuid;
begin
  perform public.prospecting_require_roles(array['administrador']);

  if coalesce(auth.role(), '') = 'service_role' then
    v_requester := coalesce(p_requested_by, auth.uid());
  else
    if p_requested_by is not null and p_requested_by is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'requested_by must match the authenticated user';
    end if;
    v_requester := auth.uid();
  end if;
  if v_requester is null then
    raise exception using errcode = '22023', message = 'A requester is required';
  end if;

  select * into v_campaign
  from public.prospecting_campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Prospecting campaign not found';
  end if;
  if v_campaign.status = 'archived' then
    raise exception using errcode = '22023', message = 'Archived campaign cannot be enqueued';
  end if;
  if not public.prospecting_keywords_valid(v_campaign.keywords) then
    raise exception using errcode = '22023',
      message = 'Campaign keywords must contain 1 to 50 unique trimmed values of at most 200 characters';
  end if;
  if 'deepseek_web' = any(v_campaign.sources)
     and not ('official_website' = any(v_campaign.sources)) then
    raise exception using errcode = '22023',
      message = 'deepseek_web requires official_website to validate contact and territory';
  end if;

  select coalesce(array_agg(distinct c.code order by c.code), '{}')
  into v_comuna_codes
  from public.geo_comunas c
  where c.active
    and (
      (cardinality(v_campaign.comuna_codes) > 0 and c.code = any(v_campaign.comuna_codes))
      or
      (cardinality(v_campaign.comuna_codes) = 0 and c.region_code = any(v_campaign.region_codes))
    );

  if cardinality(v_comuna_codes) = 0 then
    raise exception using errcode = '22023', message = 'Campaign must include at least one valid region or comuna';
  end if;

  if exists (
    select 1 from unnest(v_campaign.comuna_codes) code
    where not exists (select 1 from public.geo_comunas c where c.code = code and c.active)
  ) or exists (
    select 1 from unnest(v_campaign.region_codes) code
    where not exists (select 1 from public.geo_regions r where r.code = code and r.active)
  ) then
    raise exception using errcode = '22023', message = 'Campaign contains an unknown geographic code';
  end if;

  v_task_count := cardinality(v_comuna_codes) * cardinality(v_campaign.keywords)
    * (select count(*) from unnest(v_campaign.sources) s where s in ('google_places','deepseek_web'));
  if v_task_count = 0 then
    raise exception using errcode = '22023', message = 'Campaign requires google_places or deepseek_web as discovery source';
  end if;
  if v_task_count > 10000 then
    raise exception using errcode = '54000', message = 'Campaign expands to more than 10000 tasks';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'country_code', 'CL',
    'region_code', r.code,
    'region_name', r.name,
    'comuna_code', c.code,
    'comuna_name', c.name
  ) order by r.sort_order, c.name), '[]'::jsonb)
  into v_territories
  from public.geo_comunas c
  join public.geo_regions r on r.code = c.region_code
  where c.code = any(v_comuna_codes);

  v_snapshot := jsonb_build_object(
    'schema_version', '1.0',
    'crm_run_id', v_run_id,
    'campaign_version', v_campaign.version,
    'campaign', jsonb_build_object(
      'crm_campaign_id', v_campaign.id,
      'name', v_campaign.name,
      'description', v_campaign.description,
      'sector', v_campaign.sector,
      'territories', v_territories,
      'keywords', to_jsonb(v_campaign.keywords),
      'sources', to_jsonb(v_campaign.sources),
      'target_types', to_jsonb(v_campaign.target_types),
      'max_results_per_task', v_campaign.result_limit_per_query,
      'max_candidates', v_campaign.candidate_limit
    ),
    'territories', v_territories,
    'limits', jsonb_build_object(
      'results_per_query', v_campaign.result_limit_per_query,
      'candidate_limit', v_campaign.candidate_limit,
      'estimated_queries', v_task_count
    ),
    'requested_at', now(),
    'requested_by', v_requester::text
  );

  insert into public.prospecting_runs (
    id, campaign_id, status, snapshot, requested_by, total_tasks,
    progress
  ) values (
    v_run_id, v_campaign.id, 'pending', v_snapshot,
    v_requester, v_task_count,
    jsonb_build_object('percent', 0, 'completed_tasks', 0, 'failed_tasks', 0)
  );

  insert into public.prospecting_tasks (run_id, source, keyword, region_code, comuna_code)
  select v_run_id, source, keyword, c.region_code, c.code
  from unnest(v_campaign.sources) source
  cross join unnest(v_campaign.keywords) keyword
  cross join public.geo_comunas c
  where c.code = any(v_comuna_codes)
    and source in ('google_places','deepseek_web');

  update public.prospecting_campaigns
  set status = 'active', updated_by = v_requester
  where id = v_campaign.id;

  insert into public.prospecting_events (run_id, level, stage, message, metrics)
  values (v_run_id, 'info', 'queued', 'Prospecting run queued by CRM', jsonb_build_object('total_tasks', v_task_count));

  return jsonb_build_object(
    'id', v_run_id,
    'campaign_id', v_campaign.id,
    'status', 'pending',
    'total_tasks', v_task_count,
    'snapshot', v_snapshot
  );
end;
$$;


create or replace function public.prospecting_discovery_identity(p_url text)
returns text language sql immutable set search_path=public,pg_temp as $$
  select case when lower(p_url) ~ '^https?://(www[.]|m[.])?(instagram[.]com|facebook[.]com)/'
    then regexp_replace(regexp_replace(lower(p_url),'^https?://(www[.]|m[.])?',''),'[/]$','')
    else split_part(regexp_replace(lower(p_url),'^https?://(www[.])?',''),'/',1) end
$$;

create or replace function public.stage_prospecting_discoveries(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_run public.prospecting_runs%rowtype;
  v_hit jsonb; v_url text; v_key text; v_name text;
  v_entity uuid; v_relation uuid; v_count integer; v_limit integer; v_added integer:=0;
begin
  select * into v_run from public.prospecting_runs where id=p_run_id for update;
  if not found then raise exception using errcode='P0002',message='Prospecting run not found'; end if;
  if coalesce(v_run.search_assistance->>'mode','') not in ('web_discovery_v1','native_research_v3')
     or v_run.search_assistance->>'status' is distinct from 'applied'
     or coalesce(v_run.snapshot->>'deepseek_enabled','false')<>'true' then
    return jsonb_build_object('added',0,'candidates_found',v_run.candidates_found);
  end if;
  v_limit:=least(10000,greatest(0,coalesce((v_run.snapshot#>>'{campaign,max_candidates}')::integer,1000)));
  select count(*) into v_count from public.prospecting_campaign_candidates where run_id=p_run_id;
  for v_hit in select value from jsonb_array_elements(v_run.search_assistance->'discoveries') limit 1000 loop
    if v_run.search_assistance->>'mode'='native_research_v3' and v_hit->>'selection_version' is distinct from 'business-selection-v1' then continue; end if;
    v_url:=trim(v_hit->>'website'); v_name:=left(trim(v_hit->>'name'),300);
    if coalesce(v_name,'')='' or length(v_url)>2048 or coalesce(v_url,'') !~ '^https?://[^/@[:space:]]+([/?#]|$)'
       or coalesce(v_hit->>'source_url','') !~ '^https?://[^/@[:space:]]+([/?#]|$)' then continue; end if;
    v_key:='deepseek:'||md5(public.prospecting_discovery_identity(v_url));
    if exists(select 1 from public.prospecting_campaign_candidates where run_id=p_run_id and (external_candidate_id=v_key
      or public.prospecting_discovery_identity(coalesce(discovery_origin->>'website',candidate_snapshot->>'website'))=public.prospecting_discovery_identity(v_url)))
       then continue; end if;
    exit when v_count>=v_limit;
    insert into public.prospect_entities(name,name_normalized)
      values(v_name,public.normalize_prospect_name(v_name)) returning id into v_entity;
    insert into public.prospecting_campaign_candidates(
      run_id,campaign_id,entity_id,external_candidate_id,candidate_snapshot,
      discovery_origin,discovery_status,enrichment_status)
    values(p_run_id,v_run.campaign_id,v_entity,v_key,jsonb_build_object(
      'candidate_id',v_key,'name',v_name,'website',v_url,'location',jsonb_build_object('country_code','CL'),
      'locations','[]'::jsonb,'evidence','[]'::jsonb,'import_eligible',false,
      'importable_location_indexes','[]'::jsonb,'market_signals',jsonb_build_object('deepseek_discovery',true),
      'review_flags',jsonb_build_array('discovery_pending')),
      v_hit||jsonb_build_object('provider','deepseek_web','observed_at',v_run.search_assistance->>'completed_at'),
      'pending','pending') returning id into v_relation;
    insert into public.prospect_enrichment_jobs(run_id,candidate_relation_id,entity_id)
      values(p_run_id,v_relation,v_entity);
    v_count:=v_count+1; v_added:=v_added+1;
  end loop;
  if v_added>0 then
    update public.prospecting_runs set candidates_found=v_count,
      enrichment_total=(select count(*) from public.prospect_enrichment_jobs where run_id=p_run_id),
      enrichment_status=case when enrichment_status='paused' then 'paused' else 'pending' end,
      enrichment_completed_at=null,updated_at=now() where id=p_run_id;
    insert into public.prospecting_events(run_id,level,stage,message,metrics)
      values(p_run_id,'info','discovery_candidates_queued','Hallazgos DeepSeek guardados como candidatos pendientes de investigacion de fuentes publicas',
        jsonb_build_object('added',v_added,'candidates_found',v_count));
  end if;
  return jsonb_build_object('added',v_added,'candidates_found',v_count);
end $$;

create or replace function public.guard_prospect_discovery_review()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_valid boolean; v_duplicate text;
begin
  if old.discovery_origin is null then return new; end if;
  new.discovery_origin:=old.discovery_origin;
  new.discovery_status:=old.discovery_status;
  -- Only a leased worker completion can change the validation state. Manual
  -- confirmation and legacy enrichment must not turn a search hit into evidence.
  if new.enrichment_status='completed' and old.enrichment_status='running'
     and exists(select 1 from public.prospect_enrichment_jobs where candidate_relation_id=old.id
       and status='running' and lease_expires_at>now()) then
    v_valid:=coalesce(new.enrichment_summary->>'validation_version','')='public-web-v4'
      and coalesce(new.enrichment_summary->>'official_pages_verified','0')='1'
      and coalesce(new.candidate_snapshot->>'import_eligible','false')='true'
      and jsonb_array_length(coalesce(new.candidate_snapshot->'importable_location_indexes','[]'::jsonb))>0
      and exists(select 1 from jsonb_array_elements(coalesce(new.candidate_snapshot->'evidence','[]'::jsonb)) e
        where e->>'provider'='official_website' and e->>'field'='name' and e->>'value'=new.candidate_snapshot->>'name'
          and public.prospecting_discovery_identity(e->>'source_url')=public.prospecting_discovery_identity(new.candidate_snapshot->>'website'))
      and length(trim(coalesce(new.candidate_snapshot->>'description','')))>=20
      and exists(select 1 from jsonb_array_elements(coalesce(new.candidate_snapshot->'evidence','[]'::jsonb)) e
        where e->>'provider'='official_website' and e->>'field'='description' and e->>'value'=new.candidate_snapshot->>'description')
      and exists(select 1 from jsonb_array_elements(coalesce(new.candidate_snapshot->'evidence','[]'::jsonb)) e
        where e->>'provider'='official_website' and e->>'value'=new.candidate_snapshot->>(e->>'field')
          and public.prospecting_discovery_identity(e->>'source_url')=public.prospecting_discovery_identity(new.candidate_snapshot->>'website')
          and ((e->>'field'='phone' and e->>'value' ~ '^\+56[2-9][0-9]{8}$')
            or (e->>'field'='email' and e->>'value' ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')))
      and exists(select 1 from public.prospecting_runs r, jsonb_array_elements(r.snapshot#>'{campaign,territories}') t
        where r.id=old.run_id and new.candidate_snapshot#>>'{location,country_code}'='CL'
          and t->>'comuna_code'=new.candidate_snapshot#>>'{location,comuna_code}'
          and t->>'region_code'=new.candidate_snapshot#>>'{location,region_code}'
          and nullif(trim(new.candidate_snapshot#>>'{location,address}'),'') is not null
          and (r.snapshot#>'{campaign,target_types}') ? (new.candidate_snapshot->>'category'));
    new.discovery_status:=case when v_valid then 'validated' else 'unverified' end;
    -- Failure to verify is not a human rejection; retain the candidate and reasons.
    new.review_status:=old.review_status; new.review_notes:=old.review_notes; new.reviewed_at:=old.reviewed_at;
    select relation.external_candidate_id into v_duplicate
    from jsonb_array_elements(coalesce(new.candidate_snapshot->'evidence','[]'::jsonb)) evidence
    join public.prospect_source_records source on source.run_id=old.run_id
      and source.provider=evidence->>'provider' and source.provider_record_id=evidence->>'provider_record_id'
      and source.entity_id<>old.entity_id and (source.retention_until is null or source.retention_until>now())
    join public.prospecting_campaign_candidates relation on relation.run_id=old.run_id and relation.entity_id=source.entity_id
    where evidence->>'field'='name' and source.field_name='name' limit 1;
    if v_duplicate is not null then
      new.discovery_status:='unverified';
      new.possible_duplicate_of:=v_duplicate;
      if old.review_status in ('pending','possible_duplicate') then new.review_status:='possible_duplicate'; end if;
      new.candidate_snapshot:=jsonb_set(new.candidate_snapshot,'{review_flags}',
        coalesce(new.candidate_snapshot->'review_flags','[]'::jsonb)||'"discovery_duplicate"'::jsonb);
      new.enrichment_summary:=new.enrichment_summary||jsonb_build_object('validation_message',
        'La misma empresa ya tiene un candidato en esta ejecucion. Revisar el registro relacionado antes de importar.');
    end if;
  end if;
  if new.discovery_status<>'validated' then
    new.candidate_snapshot:=new.candidate_snapshot||jsonb_build_object('import_eligible',false,'importable_location_indexes','[]'::jsonb);
    if new.review_status in ('approved','linked') then
      raise exception using errcode='22023',message='El hallazgo requiere validacion de identidad, contacto y territorio en fuentes publicas antes de aprobar';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists prospect_discovery_review_guard on public.prospecting_campaign_candidates;
create trigger prospect_discovery_review_guard before update on public.prospecting_campaign_candidates
for each row execute function public.guard_prospect_discovery_review();

create table if not exists public.prospecting_research_requests (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.prospecting_runs(id),
  operation_id uuid not null,
  kind text not null check(kind in ('discovery','validation')),
  reservation_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  report jsonb not null default '{"status":"preparing"}',
  unique(run_id,kind,operation_id)
);
alter table public.prospecting_research_requests enable row level security;
revoke all on public.prospecting_research_requests from public,anon,authenticated;
grant select,insert,update on public.prospecting_research_requests to service_role;

create or replace function public.reserve_native_prospecting_research(
  p_run_id uuid,p_operation_id uuid,p_kind text,p_api_key_id uuid,p_worker_id text,p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_run public.prospecting_runs%rowtype; v_job public.prospect_enrichment_jobs%rowtype;
  v_request public.prospecting_research_requests%rowtype; v_task jsonb; v_candidate jsonb;
  v_previous jsonb; v_count integer; v_limit integer; v_reason text;
begin
  perform pg_advisory_xact_lock(83276092);
  select * into v_run from public.prospecting_runs where id=p_run_id for update;
  if not found then raise exception using errcode='42501',message='Invalid research lease'; end if;
  if p_kind='discovery' then
    if not coalesce((v_run.snapshot->>'deepseek_enabled')::boolean,false) then
      raise exception using errcode='42501',message='DeepSeek is disabled in the run snapshot'; end if;
    if v_run.status<>'running' or v_run.claimed_by_api_key is distinct from p_api_key_id
      or v_run.claimed_by_worker is distinct from trim(p_worker_id) or v_run.lease_token is distinct from p_lease_token
      or v_run.lease_expires_at is null or v_run.lease_expires_at<=now() then
      raise exception using errcode='42501',message='Invalid research lease'; end if;
    select to_jsonb(t)||jsonb_build_object('region_name',r.name,'comuna_name',c.name) into v_task
      from public.prospecting_tasks t join public.geo_comunas c on c.code=t.comuna_code
      join public.geo_regions r on r.code=t.region_code
      where t.id=p_operation_id and t.run_id=p_run_id and t.source='deepseek_web';
    if v_task is null then raise exception using errcode='42501',message='Invalid research task'; end if;
  elsif p_kind='validation' then
    select * into v_job from public.prospect_enrichment_jobs where id=p_operation_id and run_id=p_run_id;
    if not found or v_job.status<>'running' or v_job.claimed_by_api_key is distinct from p_api_key_id
      or v_job.claimed_by_worker is distinct from trim(p_worker_id) or v_job.lease_token is distinct from p_lease_token
      or v_job.lease_expires_at is null or v_job.lease_expires_at<=now()
      or v_run.status in ('paused','cancel_requested','cancelled') or v_run.enrichment_status='paused' then
      raise exception using errcode='42501',message='Invalid research lease'; end if;
    select candidate_snapshot into v_candidate from public.prospecting_campaign_candidates
      where id=v_job.candidate_relation_id;
    if not coalesce((v_run.snapshot->>'deepseek_enabled')::boolean,false) then
      raise exception using errcode='42501',message='DeepSeek is disabled in the run snapshot'; end if;
    if v_candidate is null then raise exception using errcode='42501',message='Invalid discovery candidate'; end if;
  else raise exception using errcode='22023',message='Invalid research kind'; end if;
  select * into v_request from public.prospecting_research_requests
    where run_id=p_run_id and kind=p_kind and operation_id=p_operation_id;
  if found then
    if v_request.completed_at is null and v_request.created_at<now()-interval '3 minutes' then
      update public.prospecting_research_requests set completed_at=now(),
        report=jsonb_build_object('status','fallback','reason_code','INTERRUPTED','discoveries','[]'::jsonb)
        where id=v_request.id returning * into v_request;
    end if;
    return v_request.report;
  end if;
  -- Counts include failed and uncertain requests; a timeout never grants another paid call.
  select count(*) into v_count from public.prospecting_research_requests
    where created_at >= (date_trunc('day',now() at time zone 'America/Santiago') at time zone 'America/Santiago');
  if v_count>=20 then v_reason:='DAILY_LIMIT'; end if;
  select count(*) into v_count from public.prospecting_research_requests where run_id=p_run_id and kind=p_kind;
  if v_reason is null and v_count >= (case when p_kind='discovery' then 12 else 20 end) then v_reason:='RUN_LIMIT'; end if;
  v_limit:=least(1000,greatest(1,coalesce((v_run.snapshot#>>'{campaign,max_candidates}')::int,1000)));
  if p_kind='discovery' and (select count(*) from public.prospecting_campaign_candidates where run_id=p_run_id)>=v_limit then
    v_reason:=coalesce(v_reason,'CANDIDATE_LIMIT'); end if;
  if v_reason is not null then
    if p_kind='discovery' then
      update public.prospecting_runs set search_assistance=coalesce(search_assistance,'{}'::jsonb)||jsonb_build_object(
        'status',case when coalesce((search_assistance->>'discovered_websites')::int,0)>0 then 'applied' else 'fallback' end,
        'mode','native_research_v3','last_step_status','limited','reason_code',v_reason) where id=p_run_id;
    end if;
    return jsonb_build_object('status','limited','reason_code',v_reason);
  end if;
  insert into public.prospecting_research_requests(run_id,operation_id,kind)
    values(p_run_id,p_operation_id,p_kind) returning * into v_request;
  select coalesce(jsonb_agg(website),'[]'::jsonb) into v_previous from
    (select coalesce(discovery_origin->>'website',candidate_snapshot->>'website') website from public.prospecting_campaign_candidates where run_id=p_run_id order by id limit 1000) previous;
  return jsonb_build_object('reservation_token',v_request.reservation_token,'task',v_task,'candidate',v_candidate,
    'kind',p_kind,'operation_id',p_operation_id,'snapshot',v_run.snapshot,'previous_sites',v_previous);
end $$;

create or replace function public.finish_native_prospecting_research(p_token uuid,p_report jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_request public.prospecting_research_requests%rowtype; v_run public.prospecting_runs%rowtype;
  v_report jsonb; v_discoveries jsonb; v_queries jsonb; v_requests integer; v_tokens bigint; v_staged jsonb;
begin
  perform pg_advisory_xact_lock(83276092);
  select * into v_request from public.prospecting_research_requests where reservation_token=p_token for update;
  if not found then raise exception using errcode='42501',message='Invalid research reservation'; end if;
  if v_request.completed_at is not null then return v_request.report; end if;
  if coalesce(p_report->>'status','') not in ('applied','fallback') or octet_length(p_report::text)>1000000
    or jsonb_typeof(p_report->'discoveries') is distinct from 'array'
    or jsonb_array_length(p_report->'discoveries')>60 then raise exception 'Invalid research report'; end if;
  v_report:=p_report||jsonb_build_object('started_at',v_request.created_at,'completed_at',now());
  update public.prospecting_research_requests set report=v_report,completed_at=now() where id=v_request.id;
  if v_request.kind='discovery' then
    select * into v_run from public.prospecting_runs where id=v_request.run_id for update;
    select coalesce(jsonb_agg(hit),'[]'::jsonb) into v_discoveries from (
      select distinct on (hit->>'website') hit from public.prospecting_research_requests request,
        lateral jsonb_array_elements(coalesce(request.report->'discoveries','[]'::jsonb)) hit
      where request.run_id=v_request.run_id and request.kind='discovery' and request.report->>'status'='applied'
      order by hit->>'website' limit 1000) unique_hits;
    select coalesce(jsonb_agg(query),'[]'::jsonb) into v_queries from public.prospecting_research_requests request,
      lateral jsonb_array_elements(coalesce(request.report->'queries','[]'::jsonb)) query
      where request.run_id=v_request.run_id and request.kind='discovery';
    select coalesce(sum((report->>'web_requests')::integer),0),coalesce(sum((report->>'tokens')::bigint),0)
      into v_requests,v_tokens from public.prospecting_research_requests where run_id=v_request.run_id and kind='discovery';
    update public.prospecting_runs set search_assistance=v_report||jsonb_build_object(
      'status',case when jsonb_array_length(v_discoveries)>0 then 'applied' else v_report->>'status' end,
      'mode','native_research_v3','discoveries',v_discoveries,'queries',v_queries,
      'discovered_websites',jsonb_array_length(v_discoveries),'web_requests',v_requests,'tokens',v_tokens,
      'last_step_status',v_report->>'status','scope','territories_and_keywords') where id=v_request.run_id;
    if v_run.status='running' and p_report->>'status'='applied' then
      v_staged:=public.stage_prospecting_discoveries(v_request.run_id);
      v_report:=v_report||jsonb_build_object('candidates_found',v_staged->'candidates_found','added',v_staged->'added');
      update public.prospecting_research_requests set report=v_report where id=v_request.id;
    end if;
  end if;
  return v_report;
end $$;

revoke all on function public.reserve_native_prospecting_research(uuid,uuid,text,uuid,text,uuid),
  public.finish_native_prospecting_research(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_native_prospecting_research(uuid,uuid,text,uuid,text,uuid),
  public.finish_native_prospecting_research(uuid,jsonb) to service_role;
revoke all on function public.stage_prospecting_discoveries(uuid),public.guard_prospect_discovery_review() from public;
grant execute on function public.stage_prospecting_discoveries(uuid) to service_role;
notify pgrst,'reload schema';
commit;
