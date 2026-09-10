-- Apply after prospecting_deepseek_search.sql and prospecting_enrichment.sql.
-- Discovery is a review inbox, never evidence authorizing a company import.
begin;

alter table public.prospecting_campaign_candidates
  add column if not exists discovery_origin jsonb,
  add column if not exists discovery_status text
    check (discovery_status in ('pending','validated','unverified'));

create or replace function public.stage_prospecting_discoveries(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_run public.prospecting_runs%rowtype;
  v_hit jsonb; v_url text; v_key text; v_name text;
  v_entity uuid; v_relation uuid; v_count integer; v_limit integer; v_added integer:=0;
begin
  select * into v_run from public.prospecting_runs where id=p_run_id for update;
  if not found then raise exception using errcode='P0002',message='Prospecting run not found'; end if;
  if v_run.search_assistance->>'mode' is distinct from 'web_discovery_v1'
     or v_run.search_assistance->>'status' is distinct from 'applied'
     or coalesce(v_run.snapshot->>'deepseek_enabled','false')<>'true' then
    return jsonb_build_object('added',0,'candidates_found',v_run.candidates_found);
  end if;
  v_limit:=least(10000,greatest(0,coalesce((v_run.snapshot#>>'{campaign,max_candidates}')::integer,1000)));
  select count(*) into v_count from public.prospecting_campaign_candidates where run_id=p_run_id;
  for v_hit in select value from jsonb_array_elements(v_run.search_assistance->'discoveries') limit 30 loop
    v_url:=trim(v_hit->>'website'); v_name:=left(trim(v_hit->>'name'),300);
    if coalesce(v_name,'')='' or length(v_url)>2048 or coalesce(v_url,'') !~ '^https?://[^/@[:space:]]+([/?#]|$)'
       or v_hit->>'source_url' is distinct from v_url then continue; end if;
    -- Keep different directory entries separate; a directory domain is not a business identity.
    v_key:='deepseek:'||md5(regexp_replace(v_url,'#.*$',''));
    if exists(select 1 from public.prospecting_campaign_candidates where run_id=p_run_id and external_candidate_id=v_key)
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
      values(p_run_id,'info','discovery_candidates_queued','Hallazgos DeepSeek guardados como candidatos pendientes de Brave',
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
    v_valid:=coalesce(new.enrichment_summary->>'validation_version','')='deepseek-brave-v1'
      and coalesce(new.enrichment_summary->>'brave_queries_used','0')='1'
      and coalesce(new.candidate_snapshot->>'import_eligible','false')='true'
      and jsonb_array_length(coalesce(new.candidate_snapshot->'importable_location_indexes','[]'::jsonb))>0
      and exists(select 1 from jsonb_array_elements(coalesce(new.candidate_snapshot->'evidence','[]'::jsonb)) e
        where e->>'provider'='official_website' and e->>'field'='name' and nullif(e->>'source_url','') is not null);
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
      raise exception using errcode='22023',message='El hallazgo requiere validacion Brave y sitio oficial antes de aprobar';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists prospect_discovery_review_guard on public.prospecting_campaign_candidates;
create trigger prospect_discovery_review_guard before update on public.prospecting_campaign_candidates
for each row execute function public.guard_prospect_discovery_review();

revoke all on function public.stage_prospecting_discoveries(uuid),public.guard_prospect_discovery_review() from public;
grant execute on function public.stage_prospecting_discoveries(uuid) to service_role;
commit;
