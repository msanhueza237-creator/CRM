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
    with matches as (
      select distinct on (company.id)
        company.id,
        comuna.name as comuna_name,
        region.name as region_name
      from public.companies company
      join public.geo_comunas comuna
        on public.normalize_prospect_text(concat_ws(' ', company.address, company.city, company.region, company.notes))
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

create index if not exists companies_whatsapp_number_idx on public.companies(whatsapp_number);
create index if not exists companies_city_region_idx on public.companies(city, region);
