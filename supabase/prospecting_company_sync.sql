begin;

create or replace function public.sync_prospect_candidate_to_company(p_candidate_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate public.prospecting_campaign_candidates%rowtype;
  v_snapshot jsonb;
  v_location jsonb;
  v_region_name text;
  v_comuna_name text;
  v_specialties text;
  v_instagram text;
  v_facebook text;
  v_whatsapp_url text;
begin
  select * into v_candidate
  from public.prospecting_campaign_candidates
  where id = p_candidate_id;

  if not found or v_candidate.company_id is null
     or v_candidate.review_status not in ('approved', 'linked') then
    return;
  end if;

  v_snapshot := coalesce(v_candidate.candidate_snapshot, '{}'::jsonb);
  v_location := case
    when jsonb_typeof(v_snapshot->'location') = 'object' then v_snapshot->'location'
    when jsonb_typeof(v_snapshot->'locations') = 'array'
         and jsonb_array_length(v_snapshot->'locations') > 0 then v_snapshot->'locations'->0
    else '{}'::jsonb
  end;

  select region.name, comuna.name into v_region_name, v_comuna_name
  from public.geo_comunas comuna
  join public.geo_regions region on region.code = comuna.region_code
  where comuna.code = v_location->>'comuna_code';

  select string_agg(value, ', ' order by ordinality) into v_specialties
  from jsonb_array_elements_text(
    case when jsonb_typeof(v_snapshot->'specialties') = 'array'
         then v_snapshot->'specialties' else '[]'::jsonb end
  ) with ordinality;

  v_instagram := nullif(trim(v_snapshot#>>'{social_media,instagram}'), '');
  v_facebook := nullif(trim(v_snapshot#>>'{social_media,facebook}'), '');
  v_whatsapp_url := nullif(trim(v_snapshot#>>'{social_media,whatsapp}'), '');

  update public.companies
  set legal_name = coalesce(nullif(trim(legal_name), ''), nullif(trim(v_snapshot->>'trade_name'), '')),
      rut = coalesce(nullif(trim(rut), ''), nullif(trim(v_snapshot->>'rut'), '')),
      description = coalesce(
        nullif(trim(description), ''),
        nullif(trim(v_snapshot->>'company_summary'), ''),
        nullif(trim(v_snapshot->>'description'), '')
      ),
      business_line = coalesce(
        nullif(trim(business_line), ''), nullif(trim(v_specialties), ''),
        nullif(trim(v_snapshot->>'category'), '')
      ),
      region_code = coalesce(nullif(trim(region_code), ''), nullif(trim(v_location->>'region_code'), '')),
      comuna_code = coalesce(nullif(trim(comuna_code), ''), nullif(trim(v_location->>'comuna_code'), '')),
      region = coalesce(nullif(trim(region), ''), nullif(trim(v_location->>'region_name'), ''), v_region_name),
      city = coalesce(nullif(trim(city), ''), nullif(trim(v_location->>'comuna_name'), ''), v_comuna_name),
      address = coalesce(nullif(trim(address), ''), nullif(trim(v_location->>'address'), '')),
      website = coalesce(nullif(trim(website), ''), nullif(trim(v_snapshot->>'website'), '')),
      phone = coalesce(nullif(trim(phone), ''), nullif(trim(v_snapshot->>'phone'), '')),
      email = coalesce(nullif(trim(email), ''), nullif(lower(trim(v_snapshot->>'email')), '')),
      instagram = coalesce(nullif(trim(instagram), ''), v_instagram),
      facebook = coalesce(nullif(trim(facebook), ''), v_facebook),
      whatsapp = coalesce(
        nullif(trim(whatsapp), ''),
        case when v_whatsapp_url is not null then nullif(trim(v_snapshot->>'phone'), '') end
      ),
      source = coalesce(nullif(trim(source), ''), 'Prospeccion CRM'),
      notes = case
        when position('Información investigada por el agente de prospección.' in coalesce(notes, '')) > 0 then notes
        else concat_ws(E'\n', nullif(trim(notes), ''), 'Información investigada por el agente de prospección.')
      end,
      updated_at = now()
  where id = v_candidate.company_id;
end;
$$;

create or replace function public.sync_reviewed_prospect_company_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.company_id is not null and new.review_status in ('approved', 'linked')
     and (old.company_id is distinct from new.company_id
          or old.review_status is distinct from new.review_status
          or old.candidate_snapshot is distinct from new.candidate_snapshot) then
    perform public.sync_prospect_candidate_to_company(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists sync_reviewed_prospect_company on public.prospecting_campaign_candidates;
create trigger sync_reviewed_prospect_company
after update of review_status, company_id, candidate_snapshot
on public.prospecting_campaign_candidates
for each row execute function public.sync_reviewed_prospect_company_trigger();

-- Completa empresas ya aprobadas sin reemplazar información editada manualmente.
do $$
declare v_candidate_id uuid;
begin
  for v_candidate_id in
    select id from public.prospecting_campaign_candidates
    where company_id is not null and review_status in ('approved', 'linked')
  loop
    perform public.sync_prospect_candidate_to_company(v_candidate_id);
  end loop;
end;
$$;

revoke all on function public.sync_prospect_candidate_to_company(uuid) from public;
revoke all on function public.sync_reviewed_prospect_company_trigger() from public;

commit;
