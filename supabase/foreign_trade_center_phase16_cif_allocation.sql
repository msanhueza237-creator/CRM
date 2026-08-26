-- Centro de Comercio Exterior - Fase 16
-- Permite distribuir CIF y gastos operativos por la participacion CIF de cada producto.

begin;

alter table public.foreign_trade_scenarios
  drop constraint if exists foreign_trade_scenarios_allocation_method_check;
alter table public.foreign_trade_scenarios
  add constraint foreign_trade_scenarios_allocation_method_check
  check (allocation_method in ('fob_value','cif_value','units','weight','cbm','manual','combined'));

alter table public.foreign_trade_cost_lines
  drop constraint if exists foreign_trade_cost_lines_allocation_method_check;
alter table public.foreign_trade_cost_lines
  add constraint foreign_trade_cost_lines_allocation_method_check
  check (allocation_method in ('operation','fob_value','cif_value','units','weight','cbm','manual','combined'));

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
      coalesce(nullif(trim(p_payload->>'calculation_version'), ''), 'cl_import_cost_v2'), now(), auth.uid(), auth.uid()
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
        calculation_version = coalesce(nullif(trim(p_payload->>'calculation_version'), ''), 'cl_import_cost_v2'),
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
  'Guarda escenarios auditables y permite distribuir CIF y gastos por participacion CIF de cada producto.';

commit;
