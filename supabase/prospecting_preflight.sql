-- Ejecutar en Supabase Studio ANTES de agent_api_keys.sql y prospecting.sql.
-- No modifica datos: detiene el despliegue si falta el esquema base del CRM.

do $$
declare
  missing_objects text[] := '{}';
begin
  if to_regclass('public.profiles') is null then missing_objects := array_append(missing_objects, 'public.profiles'); end if;
  if to_regclass('public.companies') is null then missing_objects := array_append(missing_objects, 'public.companies'); end if;
  if to_regclass('public.contacts') is null then missing_objects := array_append(missing_objects, 'public.contacts'); end if;
  if to_regclass('public.activity_logs') is null then missing_objects := array_append(missing_objects, 'public.activity_logs'); end if;
  if to_regprocedure('public.current_role()') is null then missing_objects := array_append(missing_objects, 'public.current_role()'); end if;

  if cardinality(missing_objects) > 0 then
    raise exception 'Falta el esquema base del CRM: %', array_to_string(missing_objects, ', ');
  end if;
end $$;

select
  current_database() as database_name,
  current_user as executed_by,
  now() as checked_at,
  (select count(*) from public.companies) as existing_companies,
  (select count(*) from public.profiles) as existing_profiles;
