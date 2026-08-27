-- Clima Activa CRM - Comercio Exterior fase 18
-- Recuperacion y persistencia de identidad en lineas importadas.
-- Ejecutar despues de foreign_trade_center_phase17_supplier_product_matching.sql.

begin;

create or replace function public.foreign_trade_extract_product_code(p_line jsonb)
returns text
language plpgsql
immutable
parallel safe
set search_path = public, pg_temp
as $$
declare
  v_explicit text;
  v_text text;
  v_match text[];
begin
  v_explicit := coalesce(
    nullif(trim(p_line->>'supplier_product_code'), ''),
    nullif(trim(p_line->>'supplier_sku'), ''),
    nullif(trim(p_line->>'supplier_reference'), ''),
    nullif(trim(p_line->>'model'), ''),
    nullif(trim(p_line->>'sku'), '')
  );
  if v_explicit is not null then return upper(v_explicit); end if;

  v_text := upper(concat_ws(' ',
    p_line->>'item', p_line->>'description_original', p_line->>'description',
    p_line->>'product_name', p_line->>'specification', p_line->>'part_number',
    p_line->>'reference'
  ));
  v_match := regexp_match(
    v_text,
    '\m([A-Z][A-Z0-9]{0,7}[- ][A-Z0-9-]*[0-9][A-Z0-9-]*|[A-Z]{1,8}[0-9][A-Z0-9-]{1,}|[A-Z]{2,8}-[A-Z]{2,8})\M'
  );
  return case when v_match is null then null else trim(v_match[1]) end;
end
$$;

create or replace function public.foreign_trade_hydrate_operation_line_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_catalog_sku text;
  v_supplier_code text;
begin
  if new.content_product_id is not null then
    select nullif(trim(product.sku), '')
    into v_catalog_sku
    from public.content_products product
    where product.id = new.content_product_id;
  end if;

  v_supplier_code := coalesce(
    nullif(trim(new.supplier_sku), ''),
    nullif(trim(new.source_snapshot->>'supplier_product_code'), ''),
    nullif(trim(new.source_snapshot->>'supplier_sku'), ''),
    nullif(trim(new.source_snapshot->>'supplier_reference'), ''),
    case when new.content_product_id is null and new.data_source = 'document' then nullif(trim(new.sku), '') end,
    public.foreign_trade_extract_product_code(coalesce(new.source_snapshot, '{}'::jsonb))
  );

  new.sku := case
    when new.content_product_id is not null then coalesce(v_catalog_sku, nullif(trim(new.sku), ''))
    when new.data_source = 'document' then null
    else nullif(trim(new.sku), '')
  end;
  new.supplier_sku := v_supplier_code;
  new.supplier_model := coalesce(
    nullif(trim(new.supplier_model), ''),
    nullif(trim(new.source_snapshot->>'model'), ''),
    nullif(trim(new.source_snapshot->>'supplier_model'), '')
  );
  if new.content_product_id is not null then
    new.temporary_product := false;
  end if;

  new.source_snapshot := coalesce(new.source_snapshot, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'recognized_supplier_code', new.supplier_sku,
    'recognized_supplier_model', new.supplier_model,
    'recognized_crm_sku', new.sku
  ));
  if new.sku is not null or new.supplier_sku is not null or new.supplier_model is not null then
    new.missing_fields := array_remove(coalesce(new.missing_fields, '{}'::text[]), 'sku');
  end if;
  return new;
end
$$;

drop trigger if exists hydrate_foreign_trade_operation_line_identity on public.foreign_trade_operation_lines;
create trigger hydrate_foreign_trade_operation_line_identity
before insert or update of content_product_id, sku, supplier_sku, supplier_model, source_snapshot
on public.foreign_trade_operation_lines
for each row execute function public.foreign_trade_hydrate_operation_line_identity();

create or replace function public.foreign_trade_repair_operation_product_identities_internal(
  p_operation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer := 0;
  v_recognized integer := 0;
  v_linked integer := 0;
begin
  with identity_candidates as (
    select
      line.id,
      line.content_product_id,
      coalesce(
        nullif(trim(line.supplier_sku), ''),
        nullif(trim(line.source_snapshot->>'supplier_product_code'), ''),
        nullif(trim(line.source_snapshot->>'supplier_sku'), ''),
        nullif(trim(line.source_snapshot->>'supplier_reference'), ''),
        case when line.content_product_id is null and line.data_source = 'document' then nullif(trim(line.sku), '') end,
        public.foreign_trade_extract_product_code(coalesce(line.source_snapshot, '{}'::jsonb))
      ) as supplier_code,
      coalesce(
        nullif(trim(line.supplier_model), ''),
        nullif(trim(line.source_snapshot->>'model'), ''),
        nullif(trim(line.source_snapshot->>'supplier_model'), '')
      ) as supplier_model
    from public.foreign_trade_operation_lines line
    where p_operation_id is null or line.operation_id = p_operation_id
  ), hydrated as (
    select
      candidate.*,
      nullif(trim(product.sku), '') as catalog_sku
    from identity_candidates candidate
    left join public.content_products product on product.id = candidate.content_product_id
  )
  update public.foreign_trade_operation_lines line
  set content_product_id = hydrated.content_product_id,
      sku = case
        when hydrated.content_product_id is not null then coalesce(hydrated.catalog_sku, nullif(trim(line.sku), ''))
        when line.data_source = 'document' then null
        else nullif(trim(line.sku), '')
      end,
      supplier_sku = hydrated.supplier_code,
      supplier_model = hydrated.supplier_model,
      temporary_product = hydrated.content_product_id is null,
      missing_fields = case
        when coalesce(hydrated.catalog_sku, hydrated.supplier_code, hydrated.supplier_model, nullif(trim(line.sku), '')) is not null
          then array_remove(coalesce(line.missing_fields, '{}'::text[]), 'sku')
        else coalesce(line.missing_fields, '{}'::text[])
      end,
      source_snapshot = coalesce(line.source_snapshot, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
        'recognized_supplier_code', hydrated.supplier_code,
        'recognized_supplier_model', hydrated.supplier_model,
        'recognized_crm_sku', case when hydrated.content_product_id is not null then coalesce(hydrated.catalog_sku, nullif(trim(line.sku), '')) else null end
      )),
      updated_at = now()
  from hydrated
  where line.id = hydrated.id
    and (
      line.content_product_id is distinct from hydrated.content_product_id
      or nullif(trim(line.sku), '') is distinct from case
        when hydrated.content_product_id is not null then coalesce(hydrated.catalog_sku, nullif(trim(line.sku), ''))
        when line.data_source = 'document' then null
        else nullif(trim(line.sku), '')
      end
      or nullif(trim(line.supplier_sku), '') is distinct from hydrated.supplier_code
      or nullif(trim(line.supplier_model), '') is distinct from hydrated.supplier_model
      or line.temporary_product is distinct from (hydrated.content_product_id is null)
      or ('sku' = any(coalesce(line.missing_fields, '{}'::text[]))
          and coalesce(hydrated.catalog_sku, hydrated.supplier_code, hydrated.supplier_model, nullif(trim(line.sku), '')) is not null)
    );
  get diagnostics v_updated = row_count;

  select
    count(*) filter (where coalesce(nullif(trim(line.sku), ''), nullif(trim(line.supplier_sku), ''), nullif(trim(line.supplier_model), '')) is not null),
    count(*) filter (where line.content_product_id is not null)
  into v_recognized, v_linked
  from public.foreign_trade_operation_lines line
  where p_operation_id is null or line.operation_id = p_operation_id;

  return jsonb_build_object(
    'operation_id', p_operation_id,
    'updated_lines', v_updated,
    'recognized_lines', v_recognized,
    'catalog_linked_lines', v_linked
  );
end
$$;

create or replace function public.repair_foreign_trade_operation_product_identities(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.foreign_trade_has_permission('foreign_trade.operations.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.import_shipments where id = p_operation_id) then
    raise exception 'foreign_trade_operation_not_found';
  end if;
  return public.foreign_trade_repair_operation_product_identities_internal(p_operation_id);
end
$$;

-- Repara lineas historicas al aplicar la migracion. Solo completa vacios y
-- conserva separados el SKU oficial del CRM y el codigo del proveedor.
select public.foreign_trade_repair_operation_product_identities_internal(null);

revoke all on function public.foreign_trade_hydrate_operation_line_identity() from public;
revoke all on function public.foreign_trade_extract_product_code(jsonb) from public;
revoke all on function public.foreign_trade_repair_operation_product_identities_internal(uuid) from public;
revoke all on function public.repair_foreign_trade_operation_product_identities(uuid) from public;
grant execute on function public.repair_foreign_trade_operation_product_identities(uuid) to authenticated, service_role;
grant execute on function public.foreign_trade_extract_product_code(jsonb) to authenticated, service_role;

comment on function public.repair_foreign_trade_operation_product_identities(uuid) is
  'Recupera SKU CRM, codigo y modelo de proveedor desde documentos y conciliaciones sin alterar el catalogo maestro.';

commit;
