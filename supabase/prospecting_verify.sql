-- Ejecutar DESPUES de agent_api_keys.sql y prospecting.sql.
-- Todo debe devolver true y el catalogo territorial debe ser 16/346.

with checks as (
  select 'agent_api_keys' as component,
         to_regclass('public.agent_api_keys') is not null as installed
  union all select 'prospecting_campaigns', to_regclass('public.prospecting_campaigns') is not null
  union all select 'prospecting_runs', to_regclass('public.prospecting_runs') is not null
  union all select 'prospecting_tasks', to_regclass('public.prospecting_tasks') is not null
  union all select 'prospect_entities', to_regclass('public.prospect_entities') is not null
  union all select 'prospect_source_records', to_regclass('public.prospect_source_records') is not null
  union all select 'historical_import_batches', to_regclass('public.historical_import_batches') is not null
  union all select 'historical_entities', to_regclass('public.historical_entities') is not null
  union all select 'historical_matches', to_regclass('public.historical_matches') is not null
  union all select 'create_agent_api_key', to_regprocedure('public.create_agent_api_key(text,text[],timestamp with time zone)') is not null
  union all select 'enqueue_prospecting_run', to_regprocedure('public.enqueue_prospecting_run(uuid,uuid)') is not null
  union all select 'claim_prospecting_run', to_regprocedure('public.claim_prospecting_run(uuid,text,integer)') is not null
  union all select 'create_historical_import_batch', to_regprocedure('public.create_historical_import_batch(text,text,date,integer,text[],boolean)') is not null
)
select * from checks order by component;

select
  (select count(*) from public.geo_regions where active) as active_regions,
  (select count(*) from public.geo_comunas where active) as active_comunas,
  (select count(*) from pg_policies where schemaname = 'public' and tablename like 'prospect%') as prospecting_policies,
  (select count(*) from pg_policies where schemaname = 'public' and tablename like 'historical%') as historical_policies;

-- Confirma que la instalacion no creo destinatarios ni altero campanas comerciales.
select
  (select count(*) from public.campaign_recipients) as campaign_recipients,
  (select count(*) from public.prospecting_campaigns) as prospecting_campaigns,
  (select count(*) from public.historical_entities) as historical_entities;
