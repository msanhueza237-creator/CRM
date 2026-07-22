-- Ejecutar en Supabase SQL Editor.
-- Asegura los campos usados por la ficha de empresas y corrige ubicaciones vacias.

alter table public.companies
  add column if not exists description text,
  add column if not exists whatsapp_number text,
  add column if not exists whatsapp_opt_in boolean not null default false,
  add column if not exists whatsapp_status text not null default 'sin_consentimiento';

alter table public.companies
  drop constraint if exists companies_whatsapp_status_check;

alter table public.companies
  add constraint companies_whatsapp_status_check
  check (whatsapp_status in ('sin_consentimiento', 'opt_in', 'bloqueado', 'invalido'));

update public.companies
set whatsapp_number = coalesce(nullif(whatsapp_number, ''), nullif(whatsapp, ''), nullif(phone, ''))
where nullif(whatsapp_number, '') is null
  and (nullif(whatsapp, '') is not null or nullif(phone, '') is not null);

do $$
begin
  if to_regclass('public.geo_comunas') is not null
     and to_regclass('public.geo_regions') is not null
     and to_regprocedure('public.normalize_prospect_text(text)') is not null then
    if to_regclass('public.company_locations') is not null then
      with primary_locations as (
        select distinct on (location.company_id)
          location.company_id,
          comuna.name as comuna_name,
          case
            when public.normalize_prospect_text(region.name) in ('metropolitanadesantiago','regionmetropolitanadesantiago')
              then 'Región Metropolitana de Santiago'
            when lower(region.name) like 'región%' or lower(region.name) like 'region%' then region.name
            else 'Región ' || region.name
          end as region_name
        from public.company_locations location
        join public.geo_comunas comuna on comuna.code = location.comuna_code
        join public.geo_regions region on region.code = comuna.region_code
        where nullif(trim(location.comuna_code), '') is not null
        order by location.company_id, location.is_primary desc, location.updated_at desc nulls last, location.created_at desc
      )
      update public.companies company
      set
        city = coalesce(nullif(trim(company.city), ''), primary_locations.comuna_name),
        region = coalesce(nullif(trim(company.region), ''), primary_locations.region_name)
      from primary_locations
      where company.id = primary_locations.company_id
        and (nullif(trim(company.city), '') is null or nullif(trim(company.region), '') is null);
    end if;

    if to_regclass('public.prospecting_campaign_candidates') is not null
       and to_regclass('public.prospect_locations') is not null then
      with approved_locations as (
        select distinct on (candidate.company_id)
          candidate.company_id,
          comuna.name as comuna_name,
          case
            when public.normalize_prospect_text(region.name) in ('metropolitanadesantiago','regionmetropolitanadesantiago')
              then 'Región Metropolitana de Santiago'
            when lower(region.name) like 'región%' or lower(region.name) like 'region%' then region.name
            else 'Región ' || region.name
          end as region_name
        from public.prospecting_campaign_candidates candidate
        join public.prospect_locations location on location.entity_id = candidate.entity_id
        join public.geo_comunas comuna on comuna.code = location.comuna_code
        join public.geo_regions region on region.code = comuna.region_code
        where candidate.company_id is not null
          and candidate.review_status in ('approved', 'linked')
        order by candidate.company_id, location.is_primary desc, candidate.reviewed_at desc nulls last, location.created_at desc
      )
      update public.companies company
      set
        city = coalesce(nullif(trim(company.city), ''), approved_locations.comuna_name),
        region = coalesce(nullif(trim(company.region), ''), approved_locations.region_name)
      from approved_locations
      where company.id = approved_locations.company_id
        and (nullif(trim(company.city), '') is null or nullif(trim(company.region), '') is null);
    end if;

    with matches as (
      select distinct on (company.id)
        company.id,
        comuna.name as comuna_name,
        case
          when public.normalize_prospect_text(region.name) in ('metropolitanadesantiago','regionmetropolitanadesantiago')
            then 'Región Metropolitana de Santiago'
          when lower(region.name) like 'región%' or lower(region.name) like 'region%' then region.name
          else 'Región ' || region.name
        end as region_name
      from public.companies company
      join public.geo_comunas comuna
        on public.normalize_prospect_text(company.address)
           like '%' || public.normalize_prospect_text(comuna.name) || '%'
      join public.geo_regions region
        on region.code = comuna.region_code
      where nullif(trim(company.address), '') is not null
        and (nullif(trim(company.city), '') is null or nullif(trim(company.region), '') is null)
      order by company.id, length(comuna.name) desc
    )
    update public.companies company
    set
      city = coalesce(nullif(trim(company.city), ''), matches.comuna_name),
      region = coalesce(nullif(trim(company.region), ''), matches.region_name)
    from matches
    where company.id = matches.id;

    with address_matches as (
      select
        company.id,
        comuna.name as comuna_name,
        case
          when public.normalize_prospect_text(region.name) in ('metropolitanadesantiago','regionmetropolitanadesantiago')
            then 'RegiÃ³n Metropolitana de Santiago'
          when lower(region.name) like 'regiÃ³n%' or lower(region.name) like 'region%' then region.name
          else 'RegiÃ³n ' || region.name
        end as region_name,
        count(*) over (partition by company.id) as match_count
      from public.companies company
      join public.geo_comunas comuna
        on public.normalize_prospect_text(company.address)
           like '%' || public.normalize_prospect_text(comuna.name) || '%'
      join public.geo_regions region
        on region.code = comuna.region_code
      where nullif(trim(company.address), '') is not null
    )
    update public.companies company
    set
      city = address_matches.comuna_name,
      region = address_matches.region_name
    from address_matches
    where company.id = address_matches.id
      and address_matches.match_count = 1
      and (
        nullif(trim(company.city), '') is null
        or public.normalize_prospect_text(company.city) <> public.normalize_prospect_text(address_matches.comuna_name)
        or nullif(trim(company.region), '') is null
      );
  end if;
end $$;

update public.companies
set
  region = coalesce(nullif(trim(region), ''), 'Región Metropolitana de Santiago'),
  city = coalesce(nullif(trim(city), ''), 'Santiago')
where (nullif(trim(region), '') is null or nullif(trim(city), '') is null)
  and (
    lower(coalesce(address, '')) like '%santiago%'
    or lower(coalesce(address, '')) like '%región metropolitana%'
    or lower(coalesce(address, '')) like '%region metropolitana%'
  );

update public.companies
set region = 'Región Metropolitana de Santiago'
where public.normalize_prospect_text(coalesce(region, '')) in (
  'metropolitanadesantiago',
  'regionmetropolitanadesantiago'
);

create index if not exists companies_whatsapp_number_idx on public.companies(whatsapp_number);
create index if not exists companies_city_region_idx on public.companies(city, region);
