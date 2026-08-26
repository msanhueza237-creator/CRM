-- Centro de Comercio Exterior - Fase 4
-- Motor de costos, tributos chilenos configurables y escenarios de precio.
-- Ejecutar despues de foreign_trade_center_phase2.sql y phase3.sql.

begin;

insert into public.foreign_trade_cost_parameters (
  code, name, category, value_type, numeric_value, currency, applies_to,
  source_label, valid_from, notes, metadata
)
values
  (
    'cl_general_ad_valorem', 'Derecho ad valorem general', 'duties', 'percentage', 6, null,
    'customs_cif', 'Servicio Nacional de Aduanas de Chile', date '2020-11-16',
    'Tasa general referencial sobre CIF. Puede ser reducida o exenta por tratado y origen; confirmar por partida arancelaria.',
    jsonb_build_object('url', 'https://www.aduana.cl/cuales-son-los-impuestos-que-debo-pagar-al-importar/aduana/2020-11-16/110804.html')
  ),
  (
    'cl_import_vat', 'IVA de importacion', 'taxes', 'percentage', 19, null,
    'cif_plus_duties', 'Servicio Nacional de Aduanas de Chile', date '2020-11-16',
    'Se calcula sobre CIF mas derecho ad valorem. Su recuperabilidad tributaria depende del caso del contribuyente.',
    jsonb_build_object('url', 'https://www.aduana.cl/cuales-son-los-impuestos-que-debo-pagar-al-importar/aduana/2020-11-16/110804.html')
  ),
  (
    'cl_sales_vat', 'IVA de venta', 'taxes', 'percentage', 19, null,
    'net_sale', 'Servicio de Impuestos Internos', date '2025-06-09',
    'Parametro de presentacion del precio final; se mantiene versionado y fuera del frontend.',
    jsonb_build_object('url', 'https://www.sii.cl/preguntas_frecuentes/impuestos_mensuales/001_130_0702.htm')
  )
on conflict (code, valid_from) do update
set name = excluded.name,
    category = excluded.category,
    value_type = excluded.value_type,
    numeric_value = excluded.numeric_value,
    currency = excluded.currency,
    applies_to = excluded.applies_to,
    source_label = excluded.source_label,
    notes = excluded.notes,
    metadata = excluded.metadata,
    active = true,
    updated_at = now();

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
  v_metadata jsonb := coalesce(p_payload->'metadata', '{}'::jsonb);
  v_amount_basis text;
  v_vat_rate numeric(9,6);
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
  if jsonb_typeof(v_metadata) <> 'object' then raise exception 'foreign_trade_invalid_cost_metadata'; end if;

  v_amount_basis := coalesce(nullif(trim(v_metadata->>'amount_basis'), ''), 'net');
  v_vat_rate := coalesce(nullif(trim(v_metadata->>'vat_rate_percent'), '')::numeric, 0);
  if v_amount_basis not in ('net', 'gross') or v_vat_rate < 0 or v_vat_rate > 100 then
    raise exception 'foreign_trade_invalid_cost_tax_metadata';
  end if;
  v_metadata := v_metadata || jsonb_build_object('amount_basis', v_amount_basis, 'vat_rate_percent', v_vat_rate);

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
      allocation_method, source_type, recoverable_tax, notes, metadata, created_by, updated_by
    ) values (
      v_operation_id, v_scenario_id, v_operation_line_id, v_category, v_name,
      v_amount, v_currency, v_rate, v_amount_clp,
      coalesce(nullif(trim(p_payload->>'allocation_method'), ''), 'operation'),
      coalesce(nullif(trim(p_payload->>'source_type'), ''), 'configured'),
      coalesce((p_payload->>'recoverable_tax')::boolean, false),
      nullif(trim(p_payload->>'notes'), ''), v_metadata, auth.uid(), auth.uid()
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
        metadata = v_metadata,
        updated_by = auth.uid()
    where id = v_id and operation_id = v_operation_id;
    if not found then raise exception 'foreign_trade_cost_line_not_found'; end if;
  end if;
  return v_id;
end
$$;

create or replace function public.save_foreign_trade_costing_scenario(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(trim(p_payload->>'id'), '')::uuid;
  v_operation_id uuid := nullif(trim(p_payload->>'operation_id'), '')::uuid;
  v_name text := trim(coalesce(p_payload->>'name', 'Escenario base'));
  v_status text := coalesce(nullif(trim(p_payload->>'status'), ''), 'draft');
  v_rate numeric(18,6) := nullif(trim(p_payload->>'exchange_rate_clp'), '')::numeric;
  v_rate_source text := coalesce(nullif(trim(p_payload->>'exchange_rate_source'), ''), 'manual');
  v_allocation text := coalesce(nullif(trim(p_payload->>'allocation_method'), ''), 'fob_value');
  v_assumptions jsonb := coalesce(p_payload->'assumptions', '{}'::jsonb);
  v_costing jsonb;
  v_pricing_method text;
  v_target numeric(9,6);
  v_duty numeric(9,6);
  v_import_vat numeric(9,6);
  v_sales_vat numeric(9,6);
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.import_shipments where id = v_operation_id) then
    raise exception 'foreign_trade_operation_not_found';
  end if;
  if length(v_name) < 2 or length(v_name) > 140 then raise exception 'foreign_trade_invalid_scenario_name'; end if;
  if v_status not in ('draft', 'baseline') then raise exception 'foreign_trade_invalid_scenario_status'; end if;
  if v_rate is null or v_rate <= 0 then raise exception 'foreign_trade_invalid_exchange_rate'; end if;
  if v_rate_source not in ('manual','current','conservative','custom') then raise exception 'foreign_trade_invalid_exchange_rate_source'; end if;
  if v_allocation not in ('fob_value','cif_value','units','weight','cbm','combined') then raise exception 'foreign_trade_invalid_allocation'; end if;
  if jsonb_typeof(v_assumptions) <> 'object' then raise exception 'foreign_trade_invalid_assumptions'; end if;

  v_costing := coalesce(v_assumptions->'costing', '{}'::jsonb);
  if jsonb_typeof(v_costing) <> 'object' then raise exception 'foreign_trade_invalid_costing_assumptions'; end if;
  v_pricing_method := coalesce(nullif(trim(v_costing->>'pricing_method'), ''), 'markup_on_cost');
  v_target := coalesce(nullif(trim(v_costing->>'target_percent'), '')::numeric, 0);
  v_duty := coalesce(nullif(trim(v_costing->>'general_duty_percent'), '')::numeric, 0);
  v_import_vat := coalesce(nullif(trim(v_costing->>'import_vat_percent'), '')::numeric, 0);
  v_sales_vat := coalesce(nullif(trim(v_costing->>'sales_vat_percent'), '')::numeric, 0);
  if v_pricing_method not in ('markup_on_cost','margin_on_sale') then raise exception 'foreign_trade_invalid_pricing_method'; end if;
  if v_target < 0 or v_target >= (case when v_pricing_method = 'margin_on_sale' then 100 else 100000 end) then
    raise exception 'foreign_trade_invalid_target_percent';
  end if;
  if v_duty < 0 or v_duty > 100 or v_import_vat < 0 or v_import_vat > 100 or v_sales_vat < 0 or v_sales_vat > 100 then
    raise exception 'foreign_trade_invalid_tax_percent';
  end if;

  if v_id is null and v_status = 'baseline' then
    select id into v_id
    from public.foreign_trade_scenarios
    where operation_id = v_operation_id and status = 'baseline'
    limit 1;
  end if;

  if v_status = 'baseline' and v_id is not null then
    update public.foreign_trade_scenarios
    set status = 'draft', updated_by = auth.uid()
    where operation_id = v_operation_id and status = 'baseline' and id <> v_id;
  end if;

  if v_id is null then
    insert into public.foreign_trade_scenarios (
      operation_id, name, status, exchange_rate_clp, exchange_rate_source, allocation_method,
      target_margin_percent, merchandise_total_original, merchandise_total_clp, logistics_total_clp,
      duties_total_clp, taxes_total_clp, landed_total_clp, projected_sales_clp,
      projected_profit_clp, projected_margin_percent, assumptions, missing_inputs,
      calculation_version, calculated_at, created_by, updated_by
    ) values (
      v_operation_id, v_name, v_status, v_rate, v_rate_source, v_allocation,
      v_target, nullif(trim(p_payload->>'merchandise_total_original'), '')::numeric,
      nullif(trim(p_payload->>'merchandise_total_clp'), '')::numeric,
      nullif(trim(p_payload->>'logistics_total_clp'), '')::numeric,
      nullif(trim(p_payload->>'duties_total_clp'), '')::numeric,
      nullif(trim(p_payload->>'taxes_total_clp'), '')::numeric,
      nullif(trim(p_payload->>'landed_total_clp'), '')::numeric,
      nullif(trim(p_payload->>'projected_sales_clp'), '')::numeric,
      nullif(trim(p_payload->>'projected_profit_clp'), '')::numeric,
      nullif(trim(p_payload->>'projected_margin_percent'), '')::numeric,
      v_assumptions, coalesce(array(select jsonb_array_elements_text(coalesce(p_payload->'missing_inputs', '[]'::jsonb))), '{}'::text[]),
      coalesce(nullif(trim(p_payload->>'calculation_version'), ''), 'cl_import_cost_v1'), now(), auth.uid(), auth.uid()
    ) returning id into v_id;
  else
    update public.foreign_trade_scenarios
    set name = v_name,
        status = v_status,
        exchange_rate_clp = v_rate,
        exchange_rate_source = v_rate_source,
        allocation_method = v_allocation,
        target_margin_percent = v_target,
        merchandise_total_original = nullif(trim(p_payload->>'merchandise_total_original'), '')::numeric,
        merchandise_total_clp = nullif(trim(p_payload->>'merchandise_total_clp'), '')::numeric,
        logistics_total_clp = nullif(trim(p_payload->>'logistics_total_clp'), '')::numeric,
        duties_total_clp = nullif(trim(p_payload->>'duties_total_clp'), '')::numeric,
        taxes_total_clp = nullif(trim(p_payload->>'taxes_total_clp'), '')::numeric,
        landed_total_clp = nullif(trim(p_payload->>'landed_total_clp'), '')::numeric,
        projected_sales_clp = nullif(trim(p_payload->>'projected_sales_clp'), '')::numeric,
        projected_profit_clp = nullif(trim(p_payload->>'projected_profit_clp'), '')::numeric,
        projected_margin_percent = nullif(trim(p_payload->>'projected_margin_percent'), '')::numeric,
        assumptions = v_assumptions,
        missing_inputs = coalesce(array(select jsonb_array_elements_text(coalesce(p_payload->'missing_inputs', '[]'::jsonb))), '{}'::text[]),
        calculation_version = coalesce(nullif(trim(p_payload->>'calculation_version'), ''), 'cl_import_cost_v1'),
        calculated_at = now(),
        updated_by = auth.uid()
    where id = v_id and operation_id = v_operation_id;
    if not found then raise exception 'foreign_trade_scenario_not_found'; end if;
  end if;

  if v_status = 'baseline' then
    update public.import_shipments set active_scenario_id = v_id where id = v_operation_id;
  end if;
  return v_id;
end
$$;

revoke all on function public.save_foreign_trade_costing_scenario(jsonb) from public;
grant execute on function public.save_foreign_trade_costing_scenario(jsonb) to authenticated, service_role;

comment on function public.save_foreign_trade_costing_scenario(jsonb) is
  'Guarda un escenario auditable: tributos separados de gastos, IVA recuperable separado del costo economico y precio por markup o margen.';

commit;
