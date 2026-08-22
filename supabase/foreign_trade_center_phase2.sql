-- Clima Activa CRM - Centro de Comercio Exterior (Fase 2)
-- Ejecutar despues de foreign_trade_center.sql.
-- Proveedores, lineas de producto y gastos operativos con escritura auditada.

begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'foreign_trade_lines_nonnegative_values'
  ) then
    alter table public.foreign_trade_operation_lines
      add constraint foreign_trade_lines_nonnegative_values check (
        coalesce(unit_factory_cost, 0) >= 0
        and coalesce(exw_total, 0) >= 0
        and coalesce(fob_total, 0) >= 0
        and coalesce(cif_total, 0) >= 0
        and coalesce(discount_total, 0) >= 0
        and coalesce(supplier_charges_total, 0) >= 0
        and coalesce(quantity_per_box, 0) >= 0
        and coalesce(box_count, 0) >= 0
        and coalesce(cbm_per_box, 0) >= 0
        and coalesce(cbm_total, 0) >= 0
        and coalesce(gross_weight_kg, 0) >= 0
        and coalesce(net_weight_kg, 0) >= 0
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'foreign_trade_cost_lines_nonnegative_values'
  ) then
    alter table public.foreign_trade_cost_lines
      add constraint foreign_trade_cost_lines_nonnegative_values check (
        amount_original >= 0
        and coalesce(exchange_rate_clp, 0) >= 0
        and coalesce(amount_clp, 0) >= 0
      ) not valid;
  end if;
end
$$;

create or replace function public.upsert_foreign_trade_supplier(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(trim(p_payload->>'id'), '')::uuid;
  v_name text := trim(coalesce(p_payload->>'name', ''));
  v_country text := upper(coalesce(nullif(trim(p_payload->>'country_code'), ''), 'CN'));
  v_currency text := upper(coalesce(nullif(trim(p_payload->>'currency'), ''), 'USD'));
  v_days integer := coalesce(nullif(trim(p_payload->>'default_production_days'), '')::integer, 45);
  v_incoterms text[] := '{}'::text[];
begin
  if not public.foreign_trade_has_permission('foreign_trade.suppliers.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if length(v_name) < 2 or length(v_name) > 160 then
    raise exception 'foreign_trade_invalid_supplier_name';
  end if;
  if length(v_country) <> 2 or v_country !~ '^[A-Z]{2}$' then
    raise exception 'foreign_trade_invalid_country';
  end if;
  if length(v_currency) <> 3 or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'foreign_trade_invalid_currency';
  end if;
  if v_days < 0 or v_days > 730 then
    raise exception 'foreign_trade_invalid_production_days';
  end if;
  if p_payload ? 'usual_incoterms' then
    if jsonb_typeof(p_payload->'usual_incoterms') <> 'array' then
      raise exception 'foreign_trade_invalid_incoterms';
    end if;
    select coalesce(array_agg(distinct upper(trim(value))) filter (where trim(value) <> ''), '{}'::text[])
      into v_incoterms
    from jsonb_array_elements_text(p_payload->'usual_incoterms');
  end if;

  if v_id is null then
    insert into public.suppliers(
      name, company_name, country_code, factory_city, contact_name, email,
      whatsapp, phone, currency, usual_incoterms, payment_terms,
      default_production_days, notes, active, created_by, updated_by
    ) values (
      v_name, nullif(trim(p_payload->>'company_name'), ''), v_country,
      nullif(trim(p_payload->>'factory_city'), ''), nullif(trim(p_payload->>'contact_name'), ''),
      nullif(lower(trim(p_payload->>'email')), ''), nullif(trim(p_payload->>'whatsapp'), ''),
      nullif(trim(p_payload->>'phone'), ''), v_currency, v_incoterms,
      nullif(trim(p_payload->>'payment_terms'), ''), v_days,
      nullif(trim(p_payload->>'notes'), ''), coalesce((p_payload->>'active')::boolean, true),
      auth.uid(), auth.uid()
    ) returning id into v_id;
  else
    update public.suppliers
    set name = v_name,
        company_name = nullif(trim(p_payload->>'company_name'), ''),
        country_code = v_country,
        factory_city = nullif(trim(p_payload->>'factory_city'), ''),
        contact_name = nullif(trim(p_payload->>'contact_name'), ''),
        email = nullif(lower(trim(p_payload->>'email')), ''),
        whatsapp = nullif(trim(p_payload->>'whatsapp'), ''),
        phone = nullif(trim(p_payload->>'phone'), ''),
        currency = v_currency,
        usual_incoterms = v_incoterms,
        payment_terms = nullif(trim(p_payload->>'payment_terms'), ''),
        default_production_days = v_days,
        notes = nullif(trim(p_payload->>'notes'), ''),
        active = coalesce((p_payload->>'active')::boolean, active),
        updated_by = auth.uid()
    where id = v_id;
    if not found then raise exception 'foreign_trade_supplier_not_found'; end if;
  end if;

  return v_id;
end
$$;

create or replace function public.upsert_foreign_trade_operation_line(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(trim(p_payload->>'id'), '')::uuid;
  v_operation_id uuid := nullif(trim(p_payload->>'operation_id'), '')::uuid;
  v_content_product_id uuid := nullif(trim(p_payload->>'content_product_id'), '')::uuid;
  v_supplier_product_id uuid := nullif(trim(p_payload->>'supplier_product_id'), '')::uuid;
  v_supplier_id uuid;
  v_catalog record;
  v_name text := trim(coalesce(p_payload->>'product_name', ''));
  v_sku text := nullif(trim(p_payload->>'sku'), '');
  v_supplier_sku text := nullif(trim(p_payload->>'supplier_sku'), '');
  v_quantity numeric(18,6) := coalesce(nullif(trim(p_payload->>'quantity'), '')::numeric, 0);
  v_unit_cost numeric(20,6) := nullif(trim(p_payload->>'unit_factory_cost'), '')::numeric;
  v_currency text := upper(coalesce(nullif(trim(p_payload->>'currency'), ''), 'USD'));
  v_quantity_per_box numeric(18,6) := nullif(trim(p_payload->>'quantity_per_box'), '')::numeric;
  v_box_count numeric(18,6) := nullif(trim(p_payload->>'box_count'), '')::numeric;
  v_length numeric(18,6) := nullif(trim(p_payload->>'box_length_cm'), '')::numeric;
  v_width numeric(18,6) := nullif(trim(p_payload->>'box_width_cm'), '')::numeric;
  v_height numeric(18,6) := nullif(trim(p_payload->>'box_height_cm'), '')::numeric;
  v_cbm_per_box numeric(18,6) := nullif(trim(p_payload->>'cbm_per_box'), '')::numeric;
  v_cbm_total numeric(18,6) := nullif(trim(p_payload->>'cbm_total'), '')::numeric;
  v_line_number integer;
  v_snapshot jsonb := '{}'::jsonb;
  v_remember_link boolean := coalesce((p_payload->>'remember_link')::boolean, false);
begin
  if not public.foreign_trade_has_permission('foreign_trade.operations.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  select supplier_id into v_supplier_id from public.import_shipments where id = v_operation_id;
  if not found then raise exception 'foreign_trade_operation_not_found'; end if;

  if v_content_product_id is not null then
    select id, sku, name, category, brand, external_id, source_provider, last_synced_at
      into v_catalog
    from public.content_products
    where id = v_content_product_id;
    if not found then raise exception 'foreign_trade_catalog_product_not_found'; end if;
    v_name := coalesce(nullif(v_name, ''), v_catalog.name);
    v_sku := coalesce(v_sku, nullif(trim(v_catalog.sku), ''));
    v_snapshot := jsonb_build_object(
      'catalog_product_id', v_catalog.id,
      'external_id', v_catalog.external_id,
      'source_provider', v_catalog.source_provider,
      'sku', v_catalog.sku,
      'name', v_catalog.name,
      'category', v_catalog.category,
      'brand', v_catalog.brand,
      'last_synced_at', v_catalog.last_synced_at
    );
  end if;

  if length(v_name) < 2 or length(v_name) > 240 then
    raise exception 'foreign_trade_invalid_product_name';
  end if;
  if length(v_currency) <> 3 or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'foreign_trade_invalid_currency';
  end if;
  if v_quantity < 0 or coalesce(v_unit_cost, 0) < 0
     or coalesce(v_quantity_per_box, 0) < 0 or coalesce(v_box_count, 0) < 0
     or coalesce(v_cbm_per_box, 0) < 0 or coalesce(v_cbm_total, 0) < 0 then
    raise exception 'foreign_trade_invalid_line_values';
  end if;
  if v_cbm_per_box is null and v_length > 0 and v_width > 0 and v_height > 0 then
    v_cbm_per_box := round((v_length * v_width * v_height) / 1000000, 6);
  end if;
  if v_cbm_total is null and v_cbm_per_box is not null and v_box_count is not null then
    v_cbm_total := round(v_cbm_per_box * v_box_count, 6);
  end if;

  if v_supplier_product_id is not null then
    if v_supplier_id is null or not exists (
      select 1 from public.supplier_products sp
      where sp.id = v_supplier_product_id
        and sp.supplier_id = v_supplier_id
        and (
          v_content_product_id is null
          or sp.content_product_id is null
          or sp.content_product_id = v_content_product_id
        )
    ) then
      raise exception 'foreign_trade_supplier_product_not_found';
    end if;
  end if;

  if v_remember_link then
    if not public.foreign_trade_has_permission('foreign_trade.suppliers.manage') then
      raise exception 'foreign_trade_supplier_link_forbidden' using errcode = '42501';
    end if;
    if v_supplier_id is null or v_content_product_id is null or v_sku is null then
      raise exception 'foreign_trade_supplier_link_incomplete';
    end if;
    insert into public.supplier_products(
      supplier_id, sku, supplier_sku, content_product_id, currency,
      supplier_model, supplier_description, source, metadata
    ) values (
      v_supplier_id, v_sku, v_supplier_sku, v_content_product_id,
      v_currency,
      nullif(trim(p_payload->>'supplier_model'), ''), nullif(trim(p_payload->>'description'), ''),
      'manual', jsonb_build_object('linked_from_operation', v_operation_id)
    )
    on conflict (supplier_id, sku) do update set
      supplier_sku = excluded.supplier_sku,
      content_product_id = excluded.content_product_id,
      supplier_model = excluded.supplier_model,
      supplier_description = excluded.supplier_description,
      updated_at = now()
    returning id into v_supplier_product_id;
  end if;

  if v_id is null then
    select coalesce(max(line_number), 0) + 1 into v_line_number
    from public.foreign_trade_operation_lines where operation_id = v_operation_id;

    insert into public.foreign_trade_operation_lines(
      operation_id, supplier_product_id, content_product_id, line_number, sku,
      supplier_sku, product_name, supplier_model, description, temporary_product,
      linked_manually, quantity, quantity_per_box, box_count, currency,
      unit_factory_cost, exw_total, fob_total, cif_total, discount_total,
      supplier_charges_total, unit_weight_kg, gross_weight_kg, net_weight_kg,
      box_length_cm, box_width_cm, box_height_cm, cbm_per_box, cbm_total,
      hs_code, country_of_origin, data_source, source_snapshot, created_by, updated_by
    ) values (
      v_operation_id, v_supplier_product_id, v_content_product_id, v_line_number, v_sku,
      v_supplier_sku, v_name, nullif(trim(p_payload->>'supplier_model'), ''),
      nullif(trim(p_payload->>'description'), ''), coalesce((p_payload->>'temporary_product')::boolean, v_content_product_id is null),
      v_remember_link, v_quantity, v_quantity_per_box, v_box_count,
      v_currency,
      v_unit_cost, nullif(trim(p_payload->>'exw_total'), '')::numeric,
      nullif(trim(p_payload->>'fob_total'), '')::numeric, nullif(trim(p_payload->>'cif_total'), '')::numeric,
      coalesce(nullif(trim(p_payload->>'discount_total'), '')::numeric, 0),
      coalesce(nullif(trim(p_payload->>'supplier_charges_total'), '')::numeric, 0),
      nullif(trim(p_payload->>'unit_weight_kg'), '')::numeric,
      nullif(trim(p_payload->>'gross_weight_kg'), '')::numeric,
      nullif(trim(p_payload->>'net_weight_kg'), '')::numeric,
      v_length, v_width, v_height, v_cbm_per_box, v_cbm_total,
      nullif(trim(p_payload->>'hs_code'), ''), upper(nullif(trim(p_payload->>'country_of_origin'), '')),
      coalesce(nullif(trim(p_payload->>'data_source'), ''), 'configured'),
      v_snapshot, auth.uid(), auth.uid()
    ) returning id into v_id;
  else
    update public.foreign_trade_operation_lines
    set supplier_product_id = v_supplier_product_id,
        content_product_id = v_content_product_id,
        sku = v_sku,
        supplier_sku = v_supplier_sku,
        product_name = v_name,
        supplier_model = nullif(trim(p_payload->>'supplier_model'), ''),
        description = nullif(trim(p_payload->>'description'), ''),
        temporary_product = coalesce((p_payload->>'temporary_product')::boolean, v_content_product_id is null),
        linked_manually = v_remember_link or linked_manually,
        quantity = v_quantity,
        quantity_per_box = v_quantity_per_box,
        box_count = v_box_count,
        currency = v_currency,
        unit_factory_cost = v_unit_cost,
        exw_total = nullif(trim(p_payload->>'exw_total'), '')::numeric,
        fob_total = nullif(trim(p_payload->>'fob_total'), '')::numeric,
        cif_total = nullif(trim(p_payload->>'cif_total'), '')::numeric,
        discount_total = coalesce(nullif(trim(p_payload->>'discount_total'), '')::numeric, 0),
        supplier_charges_total = coalesce(nullif(trim(p_payload->>'supplier_charges_total'), '')::numeric, 0),
        unit_weight_kg = nullif(trim(p_payload->>'unit_weight_kg'), '')::numeric,
        gross_weight_kg = nullif(trim(p_payload->>'gross_weight_kg'), '')::numeric,
        net_weight_kg = nullif(trim(p_payload->>'net_weight_kg'), '')::numeric,
        box_length_cm = v_length, box_width_cm = v_width, box_height_cm = v_height,
        cbm_per_box = v_cbm_per_box, cbm_total = v_cbm_total,
        hs_code = nullif(trim(p_payload->>'hs_code'), ''),
        country_of_origin = upper(nullif(trim(p_payload->>'country_of_origin'), '')),
        data_source = coalesce(nullif(trim(p_payload->>'data_source'), ''), 'configured'),
        source_snapshot = case when v_content_product_id is null then source_snapshot else v_snapshot end,
        updated_by = auth.uid()
    where id = v_id and operation_id = v_operation_id;
    if not found then raise exception 'foreign_trade_operation_line_not_found'; end if;
  end if;

  return v_id;
end
$$;

create or replace function public.delete_foreign_trade_operation_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.foreign_trade_has_permission('foreign_trade.operations.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  delete from public.foreign_trade_operation_lines where id = p_line_id;
  if not found then raise exception 'foreign_trade_operation_line_not_found'; end if;
end
$$;

create or replace function public.upsert_foreign_trade_cost_line(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(trim(p_payload->>'id'), '')::uuid;
  v_operation_id uuid := nullif(trim(p_payload->>'operation_id'), '')::uuid;
  v_scenario_id uuid := nullif(trim(p_payload->>'scenario_id'), '')::uuid;
  v_operation_line_id uuid := nullif(trim(p_payload->>'operation_line_id'), '')::uuid;
  v_name text := trim(coalesce(p_payload->>'name', ''));
  v_category text := coalesce(nullif(trim(p_payload->>'category'), ''), 'other');
  v_currency text := upper(coalesce(nullif(trim(p_payload->>'currency'), ''), 'USD'));
  v_amount numeric(20,6) := coalesce(nullif(trim(p_payload->>'amount_original'), '')::numeric, 0);
  v_rate numeric(18,6) := nullif(trim(p_payload->>'exchange_rate_clp'), '')::numeric;
  v_amount_clp numeric(20,6);
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.import_shipments where id = v_operation_id) then
    raise exception 'foreign_trade_operation_not_found';
  end if;
  if length(v_name) < 2 or length(v_name) > 180 then raise exception 'foreign_trade_invalid_cost_name'; end if;
  if length(v_currency) <> 3 or v_currency !~ '^[A-Z]{3}$' then raise exception 'foreign_trade_invalid_currency'; end if;
  if v_category not in (
    'merchandise','origin','international_freight','insurance','chile_port',
    'storage','customs_agency','national_transport','inspection','certificate',
    'duties','taxes','supplier_charge','other'
  ) then raise exception 'foreign_trade_invalid_cost_category'; end if;
  if v_amount < 0 or coalesce(v_rate, 0) < 0 then raise exception 'foreign_trade_invalid_cost_values'; end if;
  if v_scenario_id is not null and not exists (
    select 1 from public.foreign_trade_scenarios where id = v_scenario_id and operation_id = v_operation_id
  ) then raise exception 'foreign_trade_invalid_cost_scenario'; end if;
  if v_operation_line_id is not null and not exists (
    select 1 from public.foreign_trade_operation_lines where id = v_operation_line_id and operation_id = v_operation_id
  ) then raise exception 'foreign_trade_invalid_cost_product'; end if;

  v_amount_clp := case
    when v_currency = 'CLP' then v_amount
    when v_rate is not null and v_rate > 0 then round(v_amount * v_rate, 6)
    else null
  end;

  if v_id is null then
    insert into public.foreign_trade_cost_lines(
      operation_id, scenario_id, operation_line_id, category, name,
      amount_original, currency, exchange_rate_clp, amount_clp,
      allocation_method, source_type, recoverable_tax, notes, created_by, updated_by
    ) values (
      v_operation_id, v_scenario_id, v_operation_line_id, v_category, v_name,
      v_amount, v_currency, v_rate, v_amount_clp,
      coalesce(nullif(trim(p_payload->>'allocation_method'), ''), 'operation'),
      coalesce(nullif(trim(p_payload->>'source_type'), ''), 'configured'),
      coalesce((p_payload->>'recoverable_tax')::boolean, false),
      nullif(trim(p_payload->>'notes'), ''), auth.uid(), auth.uid()
    ) returning id into v_id;
  else
    update public.foreign_trade_cost_lines
    set scenario_id = v_scenario_id,
        operation_line_id = v_operation_line_id,
        category = v_category,
        name = v_name,
        amount_original = v_amount,
        currency = v_currency,
        exchange_rate_clp = v_rate,
        amount_clp = v_amount_clp,
        allocation_method = coalesce(nullif(trim(p_payload->>'allocation_method'), ''), 'operation'),
        source_type = coalesce(nullif(trim(p_payload->>'source_type'), ''), 'configured'),
        recoverable_tax = coalesce((p_payload->>'recoverable_tax')::boolean, false),
        notes = nullif(trim(p_payload->>'notes'), ''),
        updated_by = auth.uid()
    where id = v_id and operation_id = v_operation_id;
    if not found then raise exception 'foreign_trade_cost_line_not_found'; end if;
  end if;
  return v_id;
end
$$;

create or replace function public.delete_foreign_trade_cost_line(p_cost_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  delete from public.foreign_trade_cost_lines where id = p_cost_id;
  if not found then raise exception 'foreign_trade_cost_line_not_found'; end if;
end
$$;

create or replace function public.foreign_trade_product_catalog(
  p_search text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_term text := '%' || lower(trim(coalesce(p_search, ''))) || '%';
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_result jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.view') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(product_row)), '[]'::jsonb)
    into v_result
  from (
    select id, external_id, sku, name, category, brand, price, stock,
           source_status, sync_status, primary_image_url, last_synced_at
    from public.content_products
    where source_status <> 'deleted'
      and (
        trim(coalesce(p_search, '')) = ''
        or lower(coalesce(sku, '')) like v_term
        or lower(name) like v_term
        or lower(coalesce(category, '')) like v_term
        or lower(coalesce(brand, '')) like v_term
      )
    order by name
    limit v_limit
  ) product_row;
  return v_result;
end
$$;

create or replace function public.foreign_trade_operation_detail(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_result jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.view') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.import_shipments where id = p_operation_id) then
    raise exception 'foreign_trade_operation_not_found';
  end if;

  select jsonb_build_object(
    'operation', to_jsonb(o),
    'supplier', case when s.id is null then null else to_jsonb(s) end,
    'lines', coalesce((
      select jsonb_agg(to_jsonb(line_row) order by line_row.line_number)
      from (
        select l.*, cp.name as catalog_name, cp.primary_image_url, cp.sync_status as catalog_sync_status
        from public.foreign_trade_operation_lines l
        left join public.content_products cp on cp.id = l.content_product_id
        where l.operation_id = p_operation_id
      ) line_row
    ), '[]'::jsonb),
    'costs', coalesce((
      select jsonb_agg(to_jsonb(cost_row) order by cost_row.created_at, cost_row.name)
      from public.foreign_trade_cost_lines cost_row
      where cost_row.operation_id = p_operation_id
    ), '[]'::jsonb),
    'scenarios', coalesce((
      select jsonb_agg(to_jsonb(scenario_row) order by scenario_row.created_at)
      from public.foreign_trade_scenarios scenario_row
      where scenario_row.operation_id = p_operation_id
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'line_count', (select count(*) from public.foreign_trade_operation_lines where operation_id = p_operation_id),
      'units', (select coalesce(sum(quantity), 0) from public.foreign_trade_operation_lines where operation_id = p_operation_id),
      'registered_merchandise', (
        select coalesce(sum(
          coalesce(cif_total, fob_total, exw_total, quantity * unit_factory_cost, 0)
          - coalesce(discount_total, 0) + coalesce(supplier_charges_total, 0)
        ), 0)
        from public.foreign_trade_operation_lines where operation_id = p_operation_id
      ),
      'total_cbm', (select coalesce(sum(cbm_total), 0) from public.foreign_trade_operation_lines where operation_id = p_operation_id),
      'gross_weight_kg', (select coalesce(sum(gross_weight_kg), 0) from public.foreign_trade_operation_lines where operation_id = p_operation_id),
      'costs_clp', (select coalesce(sum(amount_clp), 0) from public.foreign_trade_cost_lines where operation_id = p_operation_id),
      'costs_without_clp', (select count(*) from public.foreign_trade_cost_lines where operation_id = p_operation_id and amount_clp is null)
    )
  ) into v_result
  from public.import_shipments o
  left join public.suppliers s on s.id = o.supplier_id
  where o.id = p_operation_id;

  return v_result;
end
$$;

revoke all on function public.upsert_foreign_trade_supplier(jsonb) from public;
revoke all on function public.upsert_foreign_trade_operation_line(jsonb) from public;
revoke all on function public.delete_foreign_trade_operation_line(uuid) from public;
revoke all on function public.upsert_foreign_trade_cost_line(jsonb) from public;
revoke all on function public.delete_foreign_trade_cost_line(uuid) from public;
revoke all on function public.foreign_trade_product_catalog(text, integer) from public;
revoke all on function public.foreign_trade_operation_detail(uuid) from public;

grant execute on function public.upsert_foreign_trade_supplier(jsonb) to authenticated, service_role;
grant execute on function public.upsert_foreign_trade_operation_line(jsonb) to authenticated, service_role;
grant execute on function public.delete_foreign_trade_operation_line(uuid) to authenticated, service_role;
grant execute on function public.upsert_foreign_trade_cost_line(jsonb) to authenticated, service_role;
grant execute on function public.delete_foreign_trade_cost_line(uuid) to authenticated, service_role;
grant execute on function public.foreign_trade_product_catalog(text, integer) to authenticated, service_role;
grant execute on function public.foreign_trade_operation_detail(uuid) to authenticated, service_role;

comment on function public.foreign_trade_operation_detail(uuid) is
  'Ficha operativa privada. Totales registrados no equivalen a costo puesto en bodega ni rentabilidad.';

commit;
