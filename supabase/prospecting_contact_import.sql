-- Permite aprobar prospectos sin sitio web cuando tienen contacto comercial
-- (telefono/WhatsApp o email) y una comuna canonica validada por la prospeccion.
-- Mantiene revision manual; no crea destinatarios de campana automaticamente.

alter table public.companies
  add column if not exists whatsapp_number text,
  add column if not exists whatsapp_opt_in boolean not null default false,
  add column if not exists whatsapp_status text not null default 'sin_consentimiento';

create or replace function public.normalize_prospect_whatsapp(p_value text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when public.normalize_prospect_phone(p_value) ~ '^\+569[0-9]{8}$'
      then public.normalize_prospect_phone(p_value)
    else null
  end
$$;

create or replace function public.review_contact_prospect_candidate(
  p_candidate_id uuid,
  p_action text,
  p_company_id uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate public.prospecting_campaign_candidates%rowtype;
  v_entity public.prospect_entities%rowtype;
  v_location public.prospect_locations%rowtype;
  v_company_id uuid;
  v_company_location_id uuid;
  v_created_company boolean := false;
  v_review_status text;
  v_snapshot jsonb;
  v_snapshot_locations jsonb;
  v_snapshot_location jsonb;
  v_import_name text;
  v_import_phone text;
  v_import_whatsapp text;
  v_import_email text;
  v_import_website text;
  v_import_address text;
  v_import_description text;
  v_import_business_line text;
  v_company_type public.company_type;
  v_region_code text;
  v_comuna_code text;
  v_region_name text;
  v_comuna_name text;
  v_source text;
  v_exact_company_ids uuid[];
begin
  perform public.prospecting_require_roles(array['administrador','vendedor']);

  if p_action = 'reject' then
    return public.review_prospect_candidate(p_candidate_id, p_action, p_company_id, p_notes);
  end if;

  if p_action not in ('approve','link') then
    raise exception using errcode = '22023', message = 'action must be approve, link or reject';
  end if;

  select * into v_candidate
  from public.prospecting_campaign_candidates
  where id = p_candidate_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Prospect candidate not found';
  end if;

  if v_candidate.review_status in ('approved','linked') then
    return jsonb_build_object(
      'candidate_id', v_candidate.id,
      'review_status', v_candidate.review_status,
      'company_id', v_candidate.company_id,
      'idempotent', true
    );
  end if;

  if v_candidate.review_status = 'rejected' then
    raise exception using errcode = '55000', message = 'Rejected candidate cannot be approved or linked';
  end if;

  select * into v_entity from public.prospect_entities where id = v_candidate.entity_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Prospect entity not found';
  end if;

  v_snapshot := case
    when v_candidate.candidate_snapshot is not null and v_candidate.candidate_snapshot <> '{}'::jsonb
      then v_candidate.candidate_snapshot
    else jsonb_build_object(
      'name', v_entity.name,
      'trade_name', v_entity.legal_name,
      'category', v_entity.company_type,
      'description', v_entity.description,
      'phone', v_entity.phone,
      'email', v_entity.email,
      'website', v_entity.website,
      'locations', '[]'::jsonb
    )
  end;

  v_import_name := coalesce(nullif(trim(v_snapshot->>'name'), ''), v_entity.name);
  v_import_phone := coalesce(nullif(trim(v_snapshot->>'phone'), ''), nullif(trim(v_entity.phone), ''));
  v_import_whatsapp := public.normalize_prospect_whatsapp(
    coalesce(nullif(trim(v_snapshot->>'whatsapp_number'), ''), v_import_phone)
  );
  v_import_email := lower(coalesce(nullif(trim(v_snapshot->>'email'), ''), nullif(trim(v_entity.email), '')));
  v_import_website := coalesce(nullif(trim(v_snapshot->>'website'), ''), nullif(trim(v_entity.website), ''));
  v_import_description := coalesce(nullif(trim(v_snapshot->>'company_summary'), ''), nullif(trim(v_snapshot->>'description'), ''), v_entity.description);
  v_import_business_line := coalesce(nullif(trim(v_snapshot->>'category'), ''), nullif(trim(v_snapshot->>'business_line'), ''), nullif(trim(v_entity.company_type), ''), 'otro');

  if nullif(trim(v_import_name), '') is null then
    raise exception using errcode = '22023', message = 'Candidate requires name';
  end if;

  if public.normalize_prospect_phone(v_import_phone) is null and nullif(trim(v_import_email), '') is null then
    raise exception using errcode = '22023', message = 'Candidate requires phone/WhatsApp or email';
  end if;

  v_snapshot_locations := case
    when jsonb_typeof(v_snapshot->'locations') = 'array' then v_snapshot->'locations'
    else '[]'::jsonb
  end;

  select item.value into v_snapshot_location
  from jsonb_array_elements(v_snapshot_locations) with ordinality item(value, ordinality)
  where nullif(trim(item.value->>'region_code'), '') is not null
    and nullif(trim(item.value->>'comuna_code'), '') is not null
  order by coalesce((item.value->>'is_primary')::boolean, false) desc, item.ordinality
  limit 1;

  if v_snapshot_location is not null then
    v_region_code := v_snapshot_location->>'region_code';
    v_comuna_code := v_snapshot_location->>'comuna_code';
    v_import_address := nullif(trim(v_snapshot_location->>'address'), '');
  else
    select * into v_location
    from public.prospect_locations
    where entity_id = v_entity.id
    order by is_primary desc, created_at
    limit 1;

    if not found then
      raise exception using errcode = '22023', message = 'Candidate requires canonical location';
    end if;

    v_region_code := v_location.region_code;
    v_comuna_code := v_location.comuna_code;
    v_import_address := v_location.address;
  end if;

  if nullif(trim(v_region_code), '') is null or nullif(trim(v_comuna_code), '') is null then
    raise exception using errcode = '22023', message = 'Candidate requires canonical region and commune';
  end if;

  select
    case
      when public.normalize_prospect_text(region.name) in ('metropolitanadesantiago','regionmetropolitanadesantiago')
        then 'Región Metropolitana de Santiago'
      when lower(region.name) like 'región%' or lower(region.name) like 'region%' then region.name
      else 'Región ' || region.name
    end,
    comuna.name
  into v_region_name, v_comuna_name
  from public.geo_comunas comuna
  join public.geo_regions region on region.code = comuna.region_code
  where comuna.code = v_comuna_code and comuna.region_code = v_region_code;

  if v_comuna_name is null then
    raise exception using errcode = '22023', message = 'Candidate commune is not valid';
  end if;

  if not exists (
    select 1 from public.prospect_source_records evidence
    where evidence.run_id = v_candidate.run_id
      and evidence.entity_id = v_entity.id
      and evidence.provider in ('google_places','brave_search','official_website')
      and evidence.field_name = 'name'
      and public.normalize_prospect_name(evidence.field_value) = public.normalize_prospect_name(v_import_name)
      and (evidence.retention_until is null or evidence.retention_until > now())
  ) then
    raise exception using errcode = '55000', message = 'Candidate lacks current name evidence';
  end if;

  if public.normalize_prospect_phone(v_import_phone) is not null and not exists (
    select 1 from public.prospect_source_records evidence
    where evidence.run_id = v_candidate.run_id
      and evidence.entity_id = v_entity.id
      and evidence.provider in ('google_places','brave_search','official_website')
      and evidence.field_name = 'phone'
      and public.normalize_prospect_phone(evidence.field_value) = public.normalize_prospect_phone(v_import_phone)
      and (evidence.retention_until is null or evidence.retention_until > now())
  ) then
    raise exception using errcode = '55000', message = 'Candidate phone lacks current evidence';
  end if;

  if nullif(trim(v_import_email), '') is not null and not exists (
    select 1 from public.prospect_source_records evidence
    where evidence.run_id = v_candidate.run_id
      and evidence.entity_id = v_entity.id
      and evidence.provider in ('google_places','brave_search','official_website')
      and evidence.field_name = 'email'
      and lower(trim(evidence.field_value)) = lower(trim(v_import_email))
      and (evidence.retention_until is null or evidence.retention_until > now())
  ) then
    raise exception using errcode = '55000', message = 'Candidate email lacks current evidence';
  end if;

  select coalesce(array_agg(distinct matches.company_id), '{}'::uuid[])
  into v_exact_company_ids
  from (
    select company.id company_id
    from public.companies company
    where public.normalize_prospect_phone(v_import_phone) is not null
      and (
        public.normalize_prospect_phone(company.phone) = public.normalize_prospect_phone(v_import_phone)
        or public.normalize_prospect_phone(company.whatsapp) = public.normalize_prospect_phone(v_import_phone)
        or public.normalize_prospect_phone(company.whatsapp_number) = public.normalize_prospect_phone(v_import_phone)
      )
    union all
    select company.id
    from public.companies company
    left join public.company_locations location on location.company_id = company.id
    where public.normalize_prospect_name(company.name) = public.normalize_prospect_name(v_import_name)
      and coalesce(location.comuna_code, company.comuna_code) = v_comuna_code
  ) matches;

  if p_action = 'link' then
    if p_company_id is null or not exists (select 1 from public.companies where id = p_company_id) then
      raise exception using errcode = '22023', message = 'link requires an existing company_id';
    end if;
    v_company_id := p_company_id;
  else
    if cardinality(v_exact_company_ids) > 1 then
      raise exception using errcode = '55000', message = 'Multiple exact company matches require an explicit link decision';
    end if;
    v_company_id := v_exact_company_ids[1];
  end if;

  select string_agg(distinct provider, ', ' order by provider) into v_source
  from public.prospect_source_records
  where run_id = v_candidate.run_id
    and entity_id = v_entity.id
    and provider in ('google_places','brave_search','official_website')
    and (retention_until is null or retention_until > now());

  v_company_type := case
    when v_import_business_line in ('distribuidor','tienda comercial','tecnico','instalador grande','competencia','otro')
      then v_import_business_line::public.company_type
    else 'otro'::public.company_type
  end;

  if v_company_id is null then
    insert into public.companies (
      name, legal_name, business_line, type, city, region, address, region_code, comuna_code,
      website, phone, whatsapp, whatsapp_number, whatsapp_opt_in, whatsapp_status,
      email, source, notes, status
    ) values (
      v_import_name, nullif(trim(v_snapshot->>'trade_name'), ''), v_import_business_line, v_company_type,
      v_comuna_name, v_region_name, v_import_address, v_region_code, v_comuna_code,
      v_import_website, v_import_phone, v_import_whatsapp, v_import_whatsapp, false, 'sin_consentimiento',
      v_import_email, v_source,
      concat_ws(E'\n',
        'Importada desde prospeccion CRM.',
        'Prospecto sin sitio web obligatorio: aprobado por contacto comercial y comuna validada.',
        nullif(trim(p_notes),'')
      ),
      'prospecto'
    ) returning id into v_company_id;
    v_created_company := true;
  else
    update public.companies
    set region_code = coalesce(nullif(trim(region_code), ''), v_region_code),
        comuna_code = coalesce(nullif(trim(comuna_code), ''), v_comuna_code),
        region = coalesce(nullif(trim(region), ''), v_region_name),
        city = coalesce(nullif(trim(city), ''), v_comuna_name),
        address = coalesce(nullif(trim(address), ''), v_import_address),
        website = coalesce(nullif(trim(website), ''), v_import_website),
        phone = coalesce(nullif(trim(phone), ''), v_import_phone),
        whatsapp = coalesce(nullif(trim(whatsapp), ''), v_import_whatsapp),
        whatsapp_number = coalesce(nullif(trim(whatsapp_number), ''), v_import_whatsapp),
        email = coalesce(nullif(trim(email), ''), v_import_email),
        notes = concat_ws(E'\n', nullif(trim(notes), ''), nullif(trim(p_notes), ''))
    where id = v_company_id;
  end if;

  select id into v_company_location_id
  from public.company_locations
  where company_id = v_company_id
    and comuna_code = v_comuna_code
    and (
      public.normalize_prospect_address(address) is null
      or public.normalize_prospect_address(address) = public.normalize_prospect_address(v_import_address)
    )
  order by is_primary desc, created_at
  limit 1
  for update;

  if v_company_location_id is null then
    insert into public.company_locations (
      company_id, kind, region_code, comuna_code, address, phone, email, is_primary
    ) values (
      v_company_id,
      case when not exists (select 1 from public.company_locations where company_id = v_company_id)
        then 'headquarters' else 'branch' end,
      v_region_code, v_comuna_code, v_import_address, v_import_phone, v_import_email,
      not exists (select 1 from public.company_locations where company_id = v_company_id)
    );
  else
    update public.company_locations
    set region_code = coalesce(region_code, v_region_code),
        comuna_code = coalesce(comuna_code, v_comuna_code),
        address = coalesce(address, v_import_address),
        phone = coalesce(phone, v_import_phone),
        email = coalesce(email, v_import_email),
        updated_at = now()
    where id = v_company_location_id;
  end if;

  v_review_status := case when v_created_company then 'approved' else 'linked' end;

  update public.prospecting_campaign_candidates
  set review_status = v_review_status,
      company_id = v_company_id,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_notes = nullif(trim(p_notes),'')
  where id = p_candidate_id;

  insert into public.activity_logs (actor_id, entity_type, entity_id, action, metadata)
  values (
    auth.uid(), 'prospecting_candidate', p_candidate_id,
    case when v_created_company then 'contact_prospect_approved' else 'contact_prospect_linked' end,
    jsonb_build_object('company_id', v_company_id, 'run_id', v_candidate.run_id, 'contact_only_import', true)
  );

  return jsonb_build_object(
    'candidate_id', p_candidate_id,
    'review_status', v_review_status,
    'company_id', v_company_id,
    'created_company', v_created_company
  );
end;
$$;

revoke all on function public.review_contact_prospect_candidate(uuid,text,uuid,text) from public;
grant execute on function public.review_contact_prospect_candidate(uuid,text,uuid,text) to authenticated;

comment on function public.review_contact_prospect_candidate(uuid,text,uuid,text) is
  'Aprueba manualmente prospectos sin sitio web cuando tienen contacto comercial vigente y comuna canonica.';
