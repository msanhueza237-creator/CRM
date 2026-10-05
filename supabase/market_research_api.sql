-- LOCAL proposal. Apply only after separate database/deployment approval.
-- Prerequisites: agent_api_keys.sql, market_study.sql, content_center.sql.
-- Defines infrastructure only. No credentials, bindings or activation rows are created.
begin;
create table public.market_research_integrations (
 id uuid primary key default gen_random_uuid(),
 api_key_id uuid not null unique references public.agent_api_keys(id),
 provider text not null unique check(provider = btrim(provider) and length(provider) between 1 and 80),
 allowed_skus text[] not null check(cardinality(allowed_skus) between 1 and 500 and array_position(allowed_skus,null) is null),
 active boolean not null default false,
 authorized_at timestamptz not null default now(),
 expires_at timestamptz not null,
 authorized_by uuid not null references public.profiles(id),
 check(expires_at > authorized_at and expires_at <= authorized_at + interval '30 days')
);
alter table public.market_research_integrations enable row level security;
revoke all on public.market_research_integrations from public,anon,authenticated,service_role;
grant select on public.market_research_integrations to service_role;
-- These existing source tables remain accessible only through the server projection.
grant select on public.agent_api_keys, public.profiles, public.content_products to service_role;

alter table public.market_study_observations alter column created_by drop not null;
alter table public.market_study_observations add column origin_integration_id uuid references public.market_research_integrations(id);
alter table public.market_study_observations add column origin_api_key_id uuid references public.agent_api_keys(id);
alter table public.market_study_observations add constraint market_observation_actor check (
 (created_by is not null and origin_integration_id is null and origin_api_key_id is null) or
 (created_by is null and origin_integration_id is not null and origin_api_key_id is not null)
);
create index market_research_daily on public.market_study_observations(origin_integration_id,created_at);

create function public.market_research_binding_immutable() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.id is distinct from old.id or new.provider is distinct from old.provider then raise exception 'Integration identity is immutable'; end if;
 return new;
end $$;
create trigger market_research_binding_identity before update on public.market_research_integrations for each row execute function public.market_research_binding_immutable();

create function public.market_research_origin_check() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare binding uuid;
begin
 select id into binding from public.market_research_integrations where provider=new.provider;
 if binding is distinct from new.origin_integration_id then raise exception 'Provider reserved for a different origin' using errcode='42501'; end if;
 return new;
end $$;
create trigger market_research_observation_origin before insert on public.market_study_observations for each row execute function public.market_research_origin_check();

create function public.market_research_access(p_key_id uuid,p_scope text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare b public.market_research_integrations%rowtype;
begin
 if p_scope is null or p_scope not in ('market-research:catalog:read','market-research:observations:write','market-research:extract') then raise exception 'Forbidden' using errcode='42501'; end if;
 select i.* into b from public.market_research_integrations i
 join public.agent_api_keys k on k.id=i.api_key_id
 join public.profiles p on p.id=i.authorized_by
 where k.id=p_key_id and k.active is true and k.revoked_at is null
 and k.expires_at is not null and k.expires_at>clock_timestamp()
 and p_scope=any(k.scopes)
 and k.scopes <@ array['market-research:catalog:read','market-research:observations:write','market-research:extract']::text[]
 and i.active is true and i.authorized_at<=clock_timestamp() and i.expires_at>clock_timestamp()
 and p.role='administrador' and p.active is true;
 if not found then raise exception 'Forbidden' using errcode='42501'; end if;
 return jsonb_build_object('id',b.id,'provider',b.provider,'allowed_skus',b.allowed_skus);
end $$;

-- Explicit field projection. Do not expose descriptions/variants JSON, prices, costs,
-- inventory quantities, suppliers, unpublished items, or foreign-trade operation data.
create function public.market_research_catalog(p_key_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare b jsonb; result jsonb; available integer; authorized integer;
begin
 b:=public.market_research_access(p_key_id,'market-research:catalog:read');
 select count(distinct s) into authorized from jsonb_array_elements_text(b->'allowed_skus') s;
 with candidates as (
  select p.id,p.name,p.brand,p.product_url,p.last_synced_at,btrim(p.sku) sku
  from public.content_products p where p.source_status='active' and p.paused is false and p.sync_status='synced'
  union
  select p.id,p.name,p.brand,p.product_url,p.last_synced_at,btrim(v->>'sku') sku
  from public.content_products p cross join lateral jsonb_array_elements(p.variants) v
  where p.source_status='active' and p.paused is false and p.sync_status='synced'
 ), eligible as (
  select c.*,count(*) over(partition by upper(c.sku)) matches from candidates c
  where c.sku is not null and c.sku<>''
 ), selected as (
  select * from eligible where matches=1 and sku in (select jsonb_array_elements_text(b->'allowed_skus'))
 )
 select coalesce(jsonb_agg(jsonb_build_object('sku',sku,'name',name,'brand',brand,'product_url',product_url,'catalog_observed_at',last_synced_at) order by sku),'[]'::jsonb),count(*) into result,available from selected;
 return jsonb_build_object('items',result,'unavailable_skus',authorized-available);
end $$;

create function public.market_research_ingest(p_key_id uuid,p_items jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare b jsonb; item jsonb; existing public.market_study_observations%rowtype; latest integer; inserted integer:=0; duplicates integer:=0; daily integer; oid uuid; receipts jsonb:='[]'::jsonb; integration uuid;
begin
 b:=public.market_research_access(p_key_id,'market-research:observations:write');
 integration:=(b->>'id')::uuid;
 -- Serializes concurrent batches for this integration, including the quota check.
 perform pg_advisory_xact_lock(hashtextextended(integration::text,37));
 b:=public.market_research_access(p_key_id,'market-research:observations:write');
 if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'Invalid batch' using errcode='22023'; end if;
 if jsonb_array_length(p_items) not between 1 and 200 or octet_length(p_items::text)>350000 then raise exception 'Invalid batch' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_items) v group by v->>'provider',v->>'external_id',v->>'revision' having count(*)>1) then raise exception 'Repeated identity' using errcode='22023'; end if;
 select count(*) into daily from public.market_study_observations where origin_integration_id=integration and created_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC';
 for item in select value from jsonb_array_elements(p_items) order by value->>'external_id',(value->>'revision')::integer loop
  if jsonb_typeof(item)<>'object' then raise exception 'Invalid item' using errcode='22023'; end if;
  if (item->>'provider') is distinct from b->>'provider' or coalesce(item->>'suggested_sku','') not in (select jsonb_array_elements_text(b->'allowed_skus')) then raise exception 'Forbidden' using errcode='42501'; end if;
  if exists(select 1 from jsonb_object_keys(item) k where k not in ('provider','external_id','revision','product_label','suggested_sku','seller','seller_kind','amount','currency','vat_basis','vat_percent','unit','package_quantity','presentation','availability','source_url','observed_at','confidence','fx','notes'))
   or length(coalesce(item->>'external_id','')) not between 1 and 120 or jsonb_typeof(item->'revision') is distinct from 'number' or (item->>'revision')::integer not between 1 and 1000000 then raise exception 'Invalid item' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended((item->>'provider')||':'||(item->>'external_id'),0));
  select * into existing from public.market_study_observations where provider=item->>'provider' and external_id=item->>'external_id' and revision=(item->>'revision')::integer;
  if found then
   if existing.origin_integration_id is distinct from integration or existing.payload<>item then raise exception 'Identity conflict' using errcode='23505'; end if;
   duplicates:=duplicates+1;
   receipts:=receipts||jsonb_build_array(jsonb_build_object('observation_id',existing.id,'external_id',item->>'external_id','revision',(item->>'revision')::integer,'disposition','duplicate'));
   continue;
  end if;
  -- Do not append API research to an identity historically owned by a human or another origin.
  if exists(select 1 from public.market_study_observations where provider=item->>'provider' and external_id=item->>'external_id' and origin_integration_id is distinct from integration) then raise exception 'Identity conflict' using errcode='23505'; end if;
  select coalesce(max(revision),0) into latest from public.market_study_observations where provider=item->>'provider' and external_id=item->>'external_id';
  if (item->>'revision')::integer<>latest+1 then raise exception 'Expected consecutive revision' using errcode='40001'; end if;
  if daily+inserted>=1000 then raise exception 'Daily limit' using errcode='P0002'; end if;
  insert into public.market_study_observations(provider,external_id,revision,payload,created_by,origin_integration_id,origin_api_key_id)
  values(item->>'provider',item->>'external_id',(item->>'revision')::integer,item,null,integration,p_key_id) returning id into oid;
  inserted:=inserted+1;
  receipts:=receipts||jsonb_build_array(jsonb_build_object('observation_id',oid,'external_id',item->>'external_id','revision',(item->>'revision')::integer,'disposition','inserted'));
 end loop;
 return jsonb_build_object('inserted',inserted,'duplicates',duplicates,'receipts',receipts);
end $$;
revoke all on function public.market_research_binding_immutable(), public.market_research_origin_check(), public.market_research_access(uuid,text), public.market_research_catalog(uuid), public.market_research_ingest(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.market_research_access(uuid,text), public.market_research_catalog(uuid), public.market_research_ingest(uuid,jsonb), public.market_research_origin_check() to service_role;
commit;
