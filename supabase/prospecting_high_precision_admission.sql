-- Admision de alta precision para nuevas campanas de prospeccion.
-- Migracion aditiva e idempotente: puede ejecutarse sobre instalaciones existentes.

begin;

alter table public.prospecting_campaigns
  alter column target_types
  set default array['distribuidor','tienda comercial','tecnico','instalador grande']::text[];

-- "otro" deja de ser un objetivo ejecutable. Las campanas historicas conservan
-- sus demas tipos y, si solo contenian "otro", convergen a los cuatro tipos v1.
update public.prospecting_campaigns
set target_types = case
  when cardinality(array_remove(coalesce(target_types, '{}'::text[]), 'otro')) = 0
    then array['distribuidor','tienda comercial','tecnico','instalador grande']::text[]
  else array_remove(target_types, 'otro')
end
where target_types is null
   or cardinality(target_types) = 0
   or 'otro' = any(target_types);

create or replace function public.enforce_prospecting_campaign_target_types()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.target_types is null or cardinality(new.target_types) = 0 then
    raise exception 'target_types_required' using errcode = '23514';
  end if;

  if 'otro' = any(new.target_types) then
    raise exception 'target_type_other_not_allowed' using errcode = '23514';
  end if;

  if 'competencia' = any(new.target_types)
     and not new.target_types <@ array['distribuidor','tienda comercial','competencia']::text[] then
    raise exception 'competition_requires_market_radar' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists prospecting_campaign_target_types_admission
  on public.prospecting_campaigns;

create trigger prospecting_campaign_target_types_admission
before insert or update of target_types on public.prospecting_campaigns
for each row execute function public.enforce_prospecting_campaign_target_types();

comment on function public.enforce_prospecting_campaign_target_types() is
  'Impide objetivos no confirmables y limita competencia al radar de mercado.';

commit;
