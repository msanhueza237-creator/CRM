-- Investigacion posterior de candidatos sin repetir el descubrimiento original.
-- Aplicar despues de supabase/prospecting.sql.

alter table public.prospecting_runs drop constraint if exists prospecting_run_status_check;
alter table public.prospecting_runs add constraint prospecting_run_status_check
  check (status in ('pending','running','paused','partial','completed','failed','cancel_requested','cancelled'));
alter table public.prospecting_runs add column if not exists enrichment_status text not null default 'not_requested';
alter table public.prospecting_runs add column if not exists enrichment_total integer not null default 0;
alter table public.prospecting_runs add column if not exists enrichment_completed integer not null default 0;
alter table public.prospecting_runs add column if not exists enrichment_failed integer not null default 0;
alter table public.prospecting_runs add column if not exists enrichment_started_at timestamptz;
alter table public.prospecting_runs add column if not exists enrichment_completed_at timestamptz;

alter table public.prospecting_campaign_candidates add column if not exists enrichment_status text not null default 'not_requested';
alter table public.prospecting_campaign_candidates add column if not exists enrichment_summary jsonb not null default '{}'::jsonb;
alter table public.prospecting_campaign_candidates add column if not exists enriched_at timestamptz;
alter table public.prospecting_campaign_candidates add column if not exists enrichment_error text;
alter table public.prospect_entities add column if not exists social_media jsonb not null default '{}'::jsonb;
alter table public.prospect_entities add column if not exists specialties text[] not null default '{}'::text[];
alter table public.prospect_entities add column if not exists brands text[] not null default '{}'::text[];
alter table public.prospect_entities add column if not exists enriched_at timestamptz;
alter table public.prospect_entities add column if not exists company_summary text;

create table if not exists public.prospect_enrichment_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.prospecting_runs(id) on delete cascade,
  candidate_relation_id uuid not null references public.prospecting_campaign_candidates(id) on delete cascade,
  entity_id uuid not null references public.prospect_entities(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','running','completed','failed','paused')),
  attempts integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  claimed_by_api_key uuid,
  claimed_by_worker text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, candidate_relation_id)
);
create index if not exists prospect_enrichment_jobs_claim_idx on public.prospect_enrichment_jobs(status, created_at);
create index if not exists prospect_enrichment_jobs_run_idx on public.prospect_enrichment_jobs(run_id, status);

create or replace function public.pause_prospecting_run(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_status text;
begin
  perform public.prospecting_require_roles(array['administrador']);
  select status into v_status from public.prospecting_runs where id=p_run_id for update;
  if not found then raise exception using errcode='P0002',message='Prospecting run not found'; end if;
  if v_status not in ('pending','running') then return jsonb_build_object('id',p_run_id,'status',v_status); end if;
  update public.prospecting_tasks set status='pending',started_at=null
    where run_id=p_run_id and status='running' and attempts<max_attempts;
  update public.prospecting_runs set status='paused',lease_token=null,lease_expires_at=null,
    claimed_by_api_key=null,claimed_by_worker=null,heartbeat_at=null,updated_at=now() where id=p_run_id;
  insert into public.prospecting_events(run_id,level,stage,message) values(p_run_id,'warning','paused','Prospecting run paused from CRM');
  return jsonb_build_object('id',p_run_id,'status','paused');
end $$;

create or replace function public.resume_prospecting_run(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_status text;
begin
  perform public.prospecting_require_roles(array['administrador']);
  select status into v_status from public.prospecting_runs where id=p_run_id for update;
  if not found then raise exception using errcode='P0002',message='Prospecting run not found'; end if;
  if v_status='paused' then
    update public.prospecting_runs set status='pending',updated_at=now() where id=p_run_id;
    insert into public.prospecting_events(run_id,level,stage,message) values(p_run_id,'info','resumed','Prospecting run resumed from CRM');
    v_status := 'pending';
  end if;
  return jsonb_build_object('id',p_run_id,'status',v_status);
end $$;

create or replace function public.enqueue_prospect_enrichment(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_total integer; v_active integer;
begin
  perform public.prospecting_require_roles(array['administrador']);
  if not exists(select 1 from public.prospecting_runs where id=p_run_id) then raise exception using errcode='P0002',message='Prospecting run not found'; end if;
  select count(*) into v_active from public.prospect_enrichment_jobs where run_id=p_run_id and status in ('pending','running');
  if v_active=0 then
    insert into public.prospect_enrichment_jobs(run_id,candidate_relation_id,entity_id)
      select run_id,id,entity_id from public.prospecting_campaign_candidates where run_id=p_run_id
    on conflict(run_id,candidate_relation_id) do update set status='pending',attempts=0,lease_token=null,
      lease_expires_at=null,claimed_by_api_key=null,claimed_by_worker=null,last_error=null,started_at=null,completed_at=null,updated_at=now();
    update public.prospecting_campaign_candidates set enrichment_status='pending',enrichment_error=null where run_id=p_run_id;
  end if;
  select count(*) into v_total from public.prospect_enrichment_jobs where run_id=p_run_id;
  update public.prospecting_runs set enrichment_status=case when v_total>0 then 'pending' else 'completed' end,
    enrichment_total=v_total,enrichment_completed=0,enrichment_failed=0,enrichment_started_at=null,
    enrichment_completed_at=case when v_total=0 then now() else null end,updated_at=now() where id=p_run_id;
  insert into public.prospecting_events(run_id,level,stage,message,metrics)
    values(p_run_id,'info','enrichment_queued','Candidate investigation queued',jsonb_build_object('total',v_total));
  return jsonb_build_object('run_id',p_run_id,'status',case when v_total>0 then 'pending' else 'completed' end,'total',v_total);
end $$;

create or replace function public.claim_prospect_enrichment(p_api_key_id uuid,p_worker_id text,p_lease_seconds integer default 300)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.prospect_enrichment_jobs%rowtype; v_relation public.prospecting_campaign_candidates%rowtype;
  v_entity public.prospect_entities%rowtype; v_token uuid:=gen_random_uuid(); v_seconds integer:=least(greatest(coalesce(p_lease_seconds,300),60),600);
begin
  update public.prospect_enrichment_jobs set status=case when attempts>=max_attempts then 'failed' else 'pending' end,
    lease_token=null,lease_expires_at=null,claimed_by_api_key=null,claimed_by_worker=null,last_error=coalesce(last_error,'Worker lease expired'),updated_at=now()
    where status='running' and lease_expires_at<now();
  select * into v_job from public.prospect_enrichment_jobs where status='running' and claimed_by_api_key=p_api_key_id
    and claimed_by_worker=trim(p_worker_id) and lease_expires_at>=now() order by started_at for update limit 1;
  if not found then
    select job.* into v_job from public.prospect_enrichment_jobs job join public.prospecting_runs run on run.id=job.run_id
      where job.status='pending' and run.enrichment_status in ('pending','running') order by job.created_at for update of job skip locked limit 1;
    if not found then return jsonb_build_object('job',null); end if;
    update public.prospect_enrichment_jobs set status='running',attempts=attempts+1,claimed_by_api_key=p_api_key_id,
      claimed_by_worker=trim(p_worker_id),lease_token=v_token,lease_expires_at=now()+make_interval(secs=>v_seconds),
      started_at=coalesce(started_at,now()),updated_at=now() where id=v_job.id returning * into v_job;
  end if;
  select * into v_relation from public.prospecting_campaign_candidates where id=v_job.candidate_relation_id;
  select * into v_entity from public.prospect_entities where id=v_job.entity_id;
  update public.prospecting_runs set enrichment_status='running',enrichment_started_at=coalesce(enrichment_started_at,now()),updated_at=now() where id=v_job.run_id;
  update public.prospecting_campaign_candidates set enrichment_status='running' where id=v_job.candidate_relation_id;
  return jsonb_build_object('job',to_jsonb(v_job)-'lease_token','lease_token',v_job.lease_token,'lease_expires_at',v_job.lease_expires_at,
    'candidate',case when v_relation.candidate_snapshot<>'{}'::jsonb then v_relation.candidate_snapshot else
      jsonb_build_object('candidate_id',v_relation.external_candidate_id,'name',v_entity.name,'trade_name',v_entity.legal_name,
        'rut',v_entity.rut,'phone',v_entity.phone,'email',v_entity.email,'website',v_entity.website,
        'description',v_entity.description,'company_summary',v_entity.company_summary,
        'location',jsonb_build_object('country_code','CL')) end);
end $$;

create or replace function public.refresh_prospect_enrichment_progress(p_run_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pending integer;v_failed integer;v_completed integer;
begin
  select count(*) filter(where status in ('pending','running','paused')),count(*) filter(where status='failed'),count(*) filter(where status='completed')
    into v_pending,v_failed,v_completed from public.prospect_enrichment_jobs where run_id=p_run_id;
  update public.prospecting_runs set enrichment_completed=v_completed,enrichment_failed=v_failed,
    enrichment_status=case when v_pending=0 then case when v_failed>0 then 'partial' else 'completed' end
      when enrichment_status='paused' then 'paused' else 'running' end,
    enrichment_completed_at=case when v_pending=0 then now() else null end,updated_at=now() where id=p_run_id;
end $$;

create or replace function public.complete_prospect_enrichment(p_job_id uuid,p_api_key_id uuid,p_worker_id text,p_lease_token uuid,p_candidate jsonb,p_summary jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.prospect_enrichment_jobs%rowtype;v_item jsonb;
begin
  if jsonb_typeof(p_candidate)<>'object' then raise exception using errcode='22023',message='candidate must be an object'; end if;
  select * into v_job from public.prospect_enrichment_jobs where id=p_job_id for update;
  if not found then raise exception using errcode='P0002',message='Enrichment job not found'; end if;
  if v_job.status<>'running' or v_job.claimed_by_api_key is distinct from p_api_key_id or v_job.claimed_by_worker is distinct from trim(p_worker_id)
    or v_job.lease_token is distinct from p_lease_token or v_job.lease_expires_at<=now() then raise exception using errcode='42501',message='Invalid enrichment lease'; end if;
  update public.prospecting_campaign_candidates set candidate_snapshot=p_candidate,enrichment_status='completed',
    enrichment_summary=coalesce(p_summary,'{}'::jsonb),enrichment_error=null,enriched_at=now(),last_seen_at=now() where id=v_job.candidate_relation_id;
  update public.prospect_entities set name=coalesce(nullif(trim(p_candidate->>'name'),''),name),legal_name=coalesce(nullif(trim(p_candidate->>'trade_name'),''),legal_name),
    website=coalesce(nullif(trim(p_candidate->>'website'),''),website),phone=coalesce(nullif(trim(p_candidate->>'phone'),''),phone),
    email=coalesce(nullif(lower(trim(p_candidate->>'email')),''),email),description=coalesce(nullif(trim(p_candidate->>'description'),''),description),
    company_summary=coalesce(nullif(trim(p_candidate->>'company_summary'),''),company_summary),
    social_media=coalesce(p_candidate->'social_media','{}'::jsonb),specialties=array(select jsonb_array_elements_text(coalesce(p_candidate->'specialties','[]'::jsonb))),
    brands=array(select jsonb_array_elements_text(coalesce(p_candidate->'brands','[]'::jsonb))),enriched_at=now(),updated_at=now() where id=v_job.entity_id;
  for v_item in select value from jsonb_array_elements(coalesce(p_candidate->'evidence','[]'::jsonb)) loop
    if v_item->>'provider' in ('official_website','brave_search') and coalesce(v_item->>'field','')<>''
      and (nullif(v_item->>'source_url','') is not null or nullif(v_item->>'provider_record_id','') is not null) then
      insert into public.prospect_source_records(entity_id,run_id,provider,provider_record_id,source_url,field_name,field_value,confidence,observed_at,retention_until,metadata)
      values(v_job.entity_id,v_job.run_id,v_item->>'provider',nullif(v_item->>'provider_record_id',''),nullif(v_item->>'source_url',''),v_item->>'field',v_item->>'value',
        coalesce((v_item->>'confidence')::numeric,1),coalesce((v_item->>'observed_at')::timestamptz,now()),nullif(v_item->>'retention_until','')::timestamptz,jsonb_build_object('enrichment_job_id',v_job.id)) on conflict do nothing;
    end if;
  end loop;
  update public.prospect_enrichment_jobs set status='completed',completed_at=now(),lease_token=null,lease_expires_at=null,updated_at=now() where id=p_job_id;
  perform public.refresh_prospect_enrichment_progress(v_job.run_id);
  return jsonb_build_object('id',p_job_id,'status','completed');
end $$;

create or replace function public.fail_prospect_enrichment(p_job_id uuid,p_api_key_id uuid,p_worker_id text,p_lease_token uuid,p_error text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.prospect_enrichment_jobs%rowtype;v_status text;
begin
  select * into v_job from public.prospect_enrichment_jobs where id=p_job_id for update;
  if not found then raise exception using errcode='P0002',message='Enrichment job not found'; end if;
  if v_job.status<>'running' or v_job.claimed_by_api_key is distinct from p_api_key_id or v_job.claimed_by_worker is distinct from trim(p_worker_id)
    or v_job.lease_token is distinct from p_lease_token then raise exception using errcode='42501',message='Invalid enrichment lease'; end if;
  v_status:=case when v_job.attempts>=v_job.max_attempts then 'failed' else 'pending' end;
  update public.prospect_enrichment_jobs set status=v_status,last_error=left(coalesce(p_error,'Unknown enrichment error'),4000),lease_token=null,lease_expires_at=null,
    claimed_by_api_key=null,claimed_by_worker=null,completed_at=case when v_status='failed' then now() else null end,updated_at=now() where id=p_job_id;
  update public.prospecting_campaign_candidates set enrichment_status=v_status,enrichment_error=left(coalesce(p_error,'Unknown enrichment error'),4000) where id=v_job.candidate_relation_id;
  perform public.refresh_prospect_enrichment_progress(v_job.run_id);
  return jsonb_build_object('id',p_job_id,'status',v_status);
end $$;

create or replace function public.pause_prospect_enrichment(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$ begin
  perform public.prospecting_require_roles(array['administrador']);
  update public.prospect_enrichment_jobs set status='paused',lease_token=null,lease_expires_at=null,claimed_by_api_key=null,claimed_by_worker=null,updated_at=now() where run_id=p_run_id and status in ('pending','running');
  update public.prospecting_campaign_candidates set enrichment_status='paused' where run_id=p_run_id and enrichment_status in ('pending','running');
  update public.prospecting_runs set enrichment_status='paused',updated_at=now() where id=p_run_id and enrichment_status in ('pending','running');
  return jsonb_build_object('run_id',p_run_id,'status','paused'); end $$;

create or replace function public.resume_prospect_enrichment(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$ begin
  perform public.prospecting_require_roles(array['administrador']);
  update public.prospect_enrichment_jobs set status='pending',updated_at=now() where run_id=p_run_id and status='paused';
  update public.prospecting_campaign_candidates set enrichment_status='pending' where run_id=p_run_id and enrichment_status='paused';
  update public.prospecting_runs set enrichment_status='pending',enrichment_completed_at=null,updated_at=now() where id=p_run_id and enrichment_status='paused';
  return jsonb_build_object('run_id',p_run_id,'status','pending'); end $$;

alter table public.prospect_enrichment_jobs enable row level security;
drop policy if exists "authenticated read prospect enrichment jobs" on public.prospect_enrichment_jobs;
create policy "authenticated read prospect enrichment jobs" on public.prospect_enrichment_jobs for select to authenticated using(true);
grant select on public.prospect_enrichment_jobs to authenticated;
grant select,insert,update,delete on public.prospect_enrichment_jobs to service_role;
revoke all on function public.pause_prospecting_run(uuid),public.resume_prospecting_run(uuid),public.enqueue_prospect_enrichment(uuid),
  public.pause_prospect_enrichment(uuid),public.resume_prospect_enrichment(uuid) from public;
grant execute on function public.pause_prospecting_run(uuid),public.resume_prospecting_run(uuid),public.enqueue_prospect_enrichment(uuid),
  public.pause_prospect_enrichment(uuid),public.resume_prospect_enrichment(uuid) to authenticated;
revoke all on function public.claim_prospect_enrichment(uuid,text,integer),public.complete_prospect_enrichment(uuid,uuid,text,uuid,jsonb,jsonb),
  public.fail_prospect_enrichment(uuid,uuid,text,uuid,text),public.refresh_prospect_enrichment_progress(uuid) from public;
grant execute on function public.claim_prospect_enrichment(uuid,text,integer),public.complete_prospect_enrichment(uuid,uuid,text,uuid,jsonb,jsonb),
  public.fail_prospect_enrichment(uuid,uuid,text,uuid,text),public.refresh_prospect_enrichment_progress(uuid) to service_role;

comment on table public.prospect_enrichment_jobs is 'Cola durable para investigar candidatos existentes sin repetir Google Places.';

create or replace function public.build_prospect_company_summary(p_candidate jsonb)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare
  v_comuna text := coalesce(nullif(p_candidate#>>'{location,comuna_name}',''),nullif(p_candidate#>>'{location,region_name}',''),'Chile');
  v_specialties text;
  v_brands text;
  v_category text := nullif(trim(coalesce(p_candidate->>'category','')),'');
  v_result text;
begin
  select string_agg(value, ', ' order by ordinality) into v_specialties
  from jsonb_array_elements_text(coalesce(p_candidate->'specialties','[]'::jsonb)) with ordinality
  where ordinality<=5;
  select string_agg(value, ', ' order by ordinality) into v_brands
  from jsonb_array_elements_text(coalesce(p_candidate->'brands','[]'::jsonb)) with ordinality
  where ordinality<=5;
  if v_specialties is not null then
    v_result := format('Empresa del sector climatización y HVAC con actividad en %s. En sus fuentes públicas se identifican servicios de %s.',v_comuna,v_specialties);
  elsif v_category is not null and lower(v_category)<>'otro' then
    v_result := format('Candidato comercial del sector climatización y HVAC con actividad en %s, clasificado como %s. La actividad específica requiere confirmación cuando no está detallada en su sitio público.',v_comuna,lower(v_category));
  else
    v_result := format('Empresa encontrada durante una búsqueda de climatización y HVAC en %s. No fue posible confirmar públicamente su actividad específica.',v_comuna);
  end if;
  if v_brands is not null then v_result := v_result||format(' En su información pública se mencionan marcas como %s.',v_brands); end if;
  if nullif(p_candidate->>'website','') is not null then v_result := v_result||' Cuenta con un sitio web público.'; end if;
  return left(v_result,1200);
end $$;

update public.prospecting_campaign_candidates
set candidate_snapshot=jsonb_set(candidate_snapshot,'{company_summary}',to_jsonb(public.build_prospect_company_summary(candidate_snapshot)),true)
where enrichment_status='completed' and coalesce(candidate_snapshot->>'company_summary','')='';

update public.prospect_entities entity
set company_summary=relation.candidate_snapshot->>'company_summary',updated_at=now()
from public.prospecting_campaign_candidates relation
where relation.entity_id=entity.id and relation.enrichment_status='completed'
  and coalesce(relation.candidate_snapshot->>'company_summary','')<>''
  and coalesce(entity.company_summary,'')='';

revoke all on function public.build_prospect_company_summary(jsonb) from public;
grant execute on function public.build_prospect_company_summary(jsonb) to authenticated,service_role;
