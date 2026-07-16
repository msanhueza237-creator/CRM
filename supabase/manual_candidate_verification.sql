-- Permite que un administrador o vendedor deje constancia de una revision
-- humana del sitio oficial antes de aprobar un candidato bloqueado.
create or replace function public.confirm_prospect_candidate_evidence(p_candidate_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate public.prospecting_campaign_candidates%rowtype;
  v_entity public.prospect_entities%rowtype;
  v_location public.prospect_locations%rowtype;
  v_snapshot jsonb;
  v_snapshot_location jsonb;
  v_source_url text;
  v_record_id text;
  v_location_index integer := 0;
  v_flags jsonb := '[]'::jsonb;
begin
  perform public.prospecting_require_roles(array['administrador','vendedor']);

  select * into v_candidate
  from public.prospecting_campaign_candidates
  where id = p_candidate_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Prospect candidate not found';
  end if;
  if v_candidate.review_status not in ('pending','possible_duplicate') then
    raise exception using errcode = '55000', message = 'Candidate was already reviewed';
  end if;

  select * into v_entity
  from public.prospect_entities
  where id = v_candidate.entity_id;
  v_snapshot := coalesce(v_candidate.candidate_snapshot, '{}'::jsonb);
  v_source_url := nullif(trim(v_snapshot->>'website'), '');
  if v_source_url is null then
    raise exception using errcode = '55000', message = 'Candidate has no official website to verify';
  end if;
  if nullif(trim(v_snapshot->>'name'), '') is null then
    raise exception using errcode = '55000', message = 'Candidate has no name to verify';
  end if;

  if jsonb_typeof(v_snapshot->'location') = 'object' then
    v_snapshot_location := v_snapshot->'location';
  elsif jsonb_typeof(v_snapshot->'locations') = 'array' and jsonb_array_length(v_snapshot->'locations') > 0 then
    v_snapshot_location := v_snapshot->'locations'->0;
  else
    raise exception using errcode = '55000', message = 'Candidate has no canonical location to verify';
  end if;

  if nullif(trim(v_snapshot_location->>'region_code'), '') is null
     or nullif(trim(v_snapshot_location->>'comuna_code'), '') is null then
    raise exception using errcode = '55000', message = 'Candidate has no canonical territory to verify';
  end if;

  select * into v_location
  from public.prospect_locations location
  where location.entity_id = v_candidate.entity_id
    and location.region_code = v_snapshot_location->>'region_code'
    and location.comuna_code = v_snapshot_location->>'comuna_code'
  order by
    (coalesce(location.address_normalized, '') = coalesce(public.normalize_prospect_address(v_snapshot_location->>'address'), '')) desc,
    location.is_primary desc,
    location.created_at
  limit 1;
  if v_location.id is null then
    raise exception using errcode = '55000', message = 'Candidate has no matching canonical location';
  end if;

  if jsonb_typeof(v_snapshot->'locations') = 'array' then
    select greatest(position::integer - 1, 0) into v_location_index
    from jsonb_array_elements(v_snapshot->'locations') with ordinality item(value, position)
    where value->>'region_code' = v_location.region_code
      and value->>'comuna_code' = v_location.comuna_code
    order by position
    limit 1;
    v_location_index := coalesce(v_location_index, 0);
  end if;

  v_record_id := 'human-review:' || p_candidate_id::text || ':' || auth.uid()::text || ':' || extract(epoch from clock_timestamp())::bigint::text;

  insert into public.prospect_source_records (
    entity_id, run_id, location_id, provider, provider_record_id, source_url,
    field_name, field_value, confidence, observed_at, metadata
  )
  select
    v_candidate.entity_id, v_candidate.run_id, evidence.location_id,
    'official_website', v_record_id, v_source_url,
    evidence.field_name, evidence.field_value, 1, now(),
    jsonb_build_object(
      'verification_method', 'human_review',
      'verified_by', auth.uid(),
      'candidate_id', p_candidate_id
    )
  from (values
    ('name'::text, v_snapshot->>'name', null::uuid),
    ('website', v_snapshot->>'website', null::uuid),
    ('phone', v_snapshot->>'phone', null::uuid),
    ('email', v_snapshot->>'email', null::uuid),
    (format('locations[%s].region_code', v_location_index), v_location.region_code, v_location.id),
    (format('locations[%s].comuna_code', v_location_index), v_location.comuna_code, v_location.id),
    (format('locations[%s].address', v_location_index), v_snapshot_location->>'address', v_location.id)
  ) evidence(field_name, field_value, location_id)
  where nullif(trim(evidence.field_value), '') is not null;

  select coalesce(jsonb_agg(flag), '[]'::jsonb) into v_flags
  from jsonb_array_elements_text(
    case when jsonb_typeof(v_snapshot->'review_flags') = 'array'
      then v_snapshot->'review_flags' else '[]'::jsonb end
  ) flag
  where flag not in (
    'insufficient_permanent_evidence',
    'location_0_temporary_evidence',
    'eligibility_not_reported',
    'eligibility_without_importable_locations'
  );

  v_snapshot := v_snapshot || jsonb_build_object(
    'import_eligible', true,
    'importable_location_indexes', jsonb_build_array(v_location_index),
    'review_flags', v_flags,
    'human_verified_at', now(),
    'human_verified_by', auth.uid()
  );
  update public.prospecting_campaign_candidates
  set candidate_snapshot = v_snapshot, last_seen_at = now()
  where id = p_candidate_id;

  insert into public.prospecting_events (run_id, level, stage, message, metrics, source, comuna_code)
  values (
    v_candidate.run_id, 'info', 'human_verification',
    'Un usuario confirmo nombre, contacto y territorio revisando el sitio oficial.',
    jsonb_build_object('candidate_id', p_candidate_id, 'verified_by', auth.uid()),
    'official_website', v_location.comuna_code
  );

  return jsonb_build_object(
    'candidate_id', p_candidate_id,
    'import_eligible', true,
    'importable_location_indexes', jsonb_build_array(v_location_index)
  );
end;
$$;

revoke all on function public.confirm_prospect_candidate_evidence(uuid) from public;
grant execute on function public.confirm_prospect_candidate_evidence(uuid) to authenticated;

comment on function public.confirm_prospect_candidate_evidence(uuid) is
  'Registra evidencia auditada por un usuario que reviso el sitio oficial; no aprueba ni crea empresas.';
