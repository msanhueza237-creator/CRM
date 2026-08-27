-- Centro de Comercio Exterior - Fase 19
-- Inteligencia de inventario, proyecciones y contrato seguro para el agente.
--
-- Principios:
-- - import_shipments y foreign_trade_operation_lines siguen siendo la fuente oficial.
-- - Facto se consume en modo solo lectura desde integration_records.
-- - Las recomendaciones no modifican stock, compras, documentos ni costos oficiales.
-- - Solo el agente foreign_trade con una tarea arrendada puede obtener el contexto sensible.

alter table public.import_shipments
  add column if not exists inventory_mode text not null default 'historical';

alter table public.import_shipments
  drop constraint if exists import_shipments_inventory_mode_check;

alter table public.import_shipments
  add constraint import_shipments_inventory_mode_check
  check (inventory_mode in ('current', 'future', 'historical'));

update public.import_shipments
set inventory_mode = case
  when status in ('production', 'ready', 'in_transit', 'customs', 'delayed') then 'future'
  when status = 'received' then 'current'
  else 'historical'
end
where inventory_mode = 'historical'
  and status in ('production', 'ready', 'in_transit', 'customs', 'delayed', 'received');

create table if not exists public.foreign_trade_intelligence_scenarios (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid references public.import_shipments(id) on delete cascade,
  name text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  parameters jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(name)) between 3 and 120),
  check (jsonb_typeof(parameters) = 'object')
);

create table if not exists public.foreign_trade_intelligence_snapshots (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid references public.import_shipments(id) on delete cascade,
  scenario_id uuid references public.foreign_trade_intelligence_scenarios(id) on delete set null,
  task_id uuid references public.business_agent_tasks(id) on delete set null,
  scope text not null default 'portfolio' check (scope in ('portfolio', 'operation')),
  as_of_date date not null default current_date,
  assumptions jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  source_observed_at timestamptz,
  input_fingerprint text not null,
  confidence numeric(7,6) not null default 0 check (confidence between 0 and 1),
  agent_type text not null default 'foreign_trade' check (agent_type = 'foreign_trade'),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(assumptions) = 'object'),
  check (jsonb_typeof(summary) = 'object')
);

create index if not exists foreign_trade_intelligence_snapshots_operation_idx
  on public.foreign_trade_intelligence_snapshots(operation_id, created_at desc);
create index if not exists foreign_trade_intelligence_snapshots_created_idx
  on public.foreign_trade_intelligence_snapshots(created_at desc);

-- La tabla ya existia en Agent Hub. Se amplia para mantener una sola fuente de
-- recomendaciones y conservar compatibilidad con el worker actual.
alter table public.replenishment_recommendations
  add column if not exists task_id uuid references public.business_agent_tasks(id) on delete set null,
  add column if not exists snapshot_id uuid references public.foreign_trade_intelligence_snapshots(id) on delete cascade,
  add column if not exists operation_id uuid references public.import_shipments(id) on delete cascade,
  add column if not exists product_name text,
  add column if not exists available_units numeric(18,6) not null default 0,
  add column if not exists committed_units numeric(18,6) not null default 0,
  add column if not exists confirmed_inbound_units numeric(18,6) not null default 0,
  add column if not exists current_operation_units numeric(18,6) not null default 0,
  add column if not exists average_daily_demand numeric(18,8) not null default 0,
  add column if not exists monthly_demand numeric(18,6) not null default 0,
  add column if not exists lead_time_days integer not null default 0,
  add column if not exists safety_stock_units numeric(18,6) not null default 0,
  add column if not exists reorder_point_units numeric(18,6) not null default 0,
  add column if not exists target_units numeric(18,6) not null default 0,
  add column if not exists projected_stock_at_arrival numeric(18,6) not null default 0,
  add column if not exists coverage_days numeric(18,4),
  add column if not exists recommended_units numeric(18,6) not null default 0,
  add column if not exists recommended_value_usd numeric(20,6) not null default 0,
  add column if not exists required_order_date date,
  add column if not exists projected_stockout_date date,
  add column if not exists severity text not null default 'low',
  add column if not exists purchase_policy text not null default 'analysis_only',
  add column if not exists confidence numeric(7,6) not null default 0,
  add column if not exists confidence_level text not null default 'low',
  add column if not exists data_quality jsonb not null default '{}'::jsonb,
  add column if not exists rationale jsonb not null default '{}'::jsonb,
  add column if not exists warnings jsonb not null default '[]'::jsonb,
  add column if not exists status text not null default 'pending',
  add column if not exists updated_at timestamptz not null default now();

alter table public.replenishment_recommendations
  drop constraint if exists replenishment_recommendations_severity_check;
alter table public.replenishment_recommendations
  add constraint replenishment_recommendations_severity_check
  check (severity in ('low', 'medium', 'high', 'critical'));
alter table public.replenishment_recommendations
  drop constraint if exists replenishment_recommendations_confidence_level_check;
alter table public.replenishment_recommendations
  add constraint replenishment_recommendations_confidence_level_check
  check (confidence_level in ('low', 'medium', 'high'));
alter table public.replenishment_recommendations
  drop constraint if exists replenishment_recommendations_status_check;
alter table public.replenishment_recommendations
  add constraint replenishment_recommendations_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired'));

create index if not exists replenishment_recommendations_snapshot_idx
  on public.replenishment_recommendations(snapshot_id, severity, recommended_units desc);

create or replace function public.foreign_trade_safe_numeric(p_value text)
returns numeric
language plpgsql
immutable
as $$
declare
  v_value text;
begin
  v_value := nullif(trim(coalesce(p_value, '')), '');
  if v_value is null then return null; end if;
  v_value := replace(v_value, ',', '.');
  if v_value !~ '^-?[0-9]+(\.[0-9]+)?$' then return null; end if;
  return v_value::numeric;
exception when others then
  return null;
end
$$;

create or replace function public.foreign_trade_setting_numeric(p_key text, p_default numeric)
returns numeric
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select coalesce(
    public.foreign_trade_safe_numeric((select value #>> '{}' from public.business_settings where key = p_key)),
    p_default
  )
$$;

create or replace function public.foreign_trade_safe_boolean(p_value text, p_default boolean default true)
returns boolean
language sql
immutable
as $$
  select case lower(trim(coalesce(p_value, '')))
    when 'true' then true
    when 't' then true
    when '1' then true
    when 'yes' then true
    when 'si' then true
    when 'false' then false
    when 'f' then false
    when '0' then false
    when 'no' then false
    else p_default
  end
$$;

create or replace function public.foreign_trade_safe_uuid(p_value text)
returns uuid
language plpgsql
immutable
as $$
declare
  v_value text := nullif(trim(coalesce(p_value, '')), '');
begin
  if v_value is null or v_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_value::uuid;
exception when others then
  return null;
end
$$;

create or replace function public.foreign_trade_safe_date(p_value text, p_default date default current_date)
returns date
language plpgsql
stable
as $$
declare
  v_value text := nullif(trim(coalesce(p_value, '')), '');
begin
  if v_value is null or v_value !~ '^\d{4}-\d{2}-\d{2}$' then
    return p_default;
  end if;
  return v_value::date;
exception when others then
  return p_default;
end
$$;

create or replace function public.run_foreign_trade_intelligence(
  p_operation_id uuid default null,
  p_parameters jsonb default '{}'::jsonb,
  p_task_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_snapshot_id uuid;
  v_as_of date := public.foreign_trade_safe_date(p_parameters->>'as_of', current_date);
  v_production_days integer := greatest(0, coalesce(public.foreign_trade_safe_numeric(p_parameters->>'production_days'), public.foreign_trade_setting_numeric('foreign_trade.production_days', 45)))::integer;
  v_sea_days integer := greatest(0, coalesce(public.foreign_trade_safe_numeric(p_parameters->>'sea_travel_days'), public.foreign_trade_setting_numeric('foreign_trade.sea_travel_days', 45)))::integer;
  v_customs_days integer := greatest(0, coalesce(public.foreign_trade_safe_numeric(p_parameters->>'customs_delay_days'), public.foreign_trade_setting_numeric('foreign_trade.customs_delay_days', 5)))::integer;
  v_delay_days integer := greatest(0, coalesce(public.foreign_trade_safe_numeric(p_parameters->>'additional_delay_days'), 0))::integer;
  v_safety_days integer := greatest(0, coalesce(public.foreign_trade_safe_numeric(p_parameters->>'safety_stock_days'), public.foreign_trade_setting_numeric('foreign_trade.safety_stock_days', 30)))::integer;
  v_target_days integer := greatest(1, coalesce(public.foreign_trade_safe_numeric(p_parameters->>'target_coverage_days'), public.foreign_trade_setting_numeric('foreign_trade.target_coverage_days', 155)))::integer;
  v_demand_factor numeric := greatest(0, 1 + coalesce(public.foreign_trade_safe_numeric(p_parameters->>'demand_change_percent'), 0) / 100);
  v_lead_days integer;
  v_effective_target_days integer;
  v_source_observed_at timestamptz;
  v_record record;
  v_available numeric;
  v_current_units numeric;
  v_inbound numeric;
  v_demand numeric;
  v_coverage numeric;
  v_safety_units numeric;
  v_target_units numeric;
  v_projected_arrival numeric;
  v_recommended numeric;
  v_stockout date;
  v_required date;
  v_severity text;
  v_confidence numeric;
  v_warnings jsonb;
  v_count integer := 0;
  v_critical integer := 0;
  v_high integer := 0;
  v_total_recommended numeric := 0;
  v_avg_confidence numeric := 0;
begin
  if auth.role() <> 'service_role' and not public.foreign_trade_has_permission('foreign_trade.view') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if p_operation_id is not null and not exists (select 1 from public.import_shipments where id = p_operation_id) then
    raise exception 'foreign_trade_operation_not_found';
  end if;
  if p_task_id is not null and not exists (
    select 1 from public.business_agent_tasks
    where id = p_task_id and agent_type = 'foreign_trade'
  ) then
    raise exception 'foreign_trade_invalid_agent_task' using errcode = '42501';
  end if;

  v_lead_days := v_production_days + v_sea_days + v_customs_days + v_delay_days;
  v_effective_target_days := greatest(v_target_days, v_lead_days + v_safety_days);
  select max(updated_at) into v_source_observed_at
  from public.integration_records
  where provider = 'facto' and resource = 'inventory_snapshots';

  insert into public.foreign_trade_intelligence_snapshots(
    operation_id, task_id, scope, as_of_date, assumptions, source_observed_at,
    input_fingerprint, agent_type, created_by
  ) values (
    p_operation_id, p_task_id,
    case when p_operation_id is null then 'portfolio' else 'operation' end,
    v_as_of,
    jsonb_build_object(
      'production_days', v_production_days,
      'sea_travel_days', v_sea_days,
      'customs_delay_days', v_customs_days,
      'additional_delay_days', v_delay_days,
      'lead_time_days', v_lead_days,
      'safety_stock_days', v_safety_days,
      'target_coverage_days', v_target_days,
      'effective_target_days', v_effective_target_days,
      'demand_change_percent', (v_demand_factor - 1) * 100,
      'formula', 'max(target_coverage, lead_time + safety_stock) * daily_demand - current_stock - confirmed_inbound'
    ),
    v_source_observed_at,
    md5(coalesce(p_operation_id::text, 'portfolio') || '|' || p_parameters::text || '|' || coalesce(v_source_observed_at::text, 'no-facto')),
    'foreign_trade',
    case when auth.role() = 'service_role' then null else auth.uid() end
  ) returning id into v_snapshot_id;

  for v_record in
    with latest_inventory as (
      select distinct on (upper(trim(payload->>'sku')))
        upper(trim(payload->>'sku')) as sku_key,
        trim(payload->>'sku') as sku,
        coalesce(nullif(trim(payload->>'name'), ''), nullif(trim(payload->>'product_name'), ''), trim(payload->>'sku')) as product_name,
        payload,
        updated_at
      from public.integration_records
      where provider = 'facto'
        and resource = 'inventory_snapshots'
        and nullif(trim(payload->>'sku'), '') is not null
      order by upper(trim(payload->>'sku')), updated_at desc
    ), operation_units as (
      select
        upper(trim(coalesce(nullif(line.sku, ''), nullif(product.sku, ''), nullif(line.supplier_sku, ''), 'LINE:' || line.id::text))) as sku_key,
        max(coalesce(nullif(line.sku, ''), nullif(product.sku, ''), nullif(line.supplier_sku, ''), 'LINE:' || line.id::text)) as sku,
        max(coalesce(nullif(line.product_name, ''), product.name, 'Producto sin identificar')) as product_name,
        (array_agg(line.content_product_id) filter (where line.content_product_id is not null))[1] as content_product_id,
        sum(case when operation.inventory_mode = 'current' and operation.status <> 'cancelled' then line.quantity else 0 end) as current_units,
        sum(case when operation.inventory_mode = 'future' and operation.status <> 'cancelled' then line.quantity else 0 end) as future_units,
        min(case when operation.inventory_mode = 'future' and operation.status <> 'cancelled' then operation.estimated_arrival end) as earliest_arrival,
        max(coalesce(line.unit_factory_cost, case when line.quantity > 0 then coalesce(line.fob_total, line.exw_total, line.cif_total) / line.quantity end, 0)) as unit_cost_usd
      from public.foreign_trade_operation_lines line
      join public.import_shipments operation on operation.id = line.operation_id
      left join public.content_products product on product.id = line.content_product_id
      where p_operation_id is null or line.operation_id = p_operation_id
      group by upper(trim(coalesce(nullif(line.sku, ''), nullif(product.sku, ''), nullif(line.supplier_sku, ''), 'LINE:' || line.id::text)))
    ), selected_skus as (
      select distinct upper(trim(coalesce(nullif(line.sku, ''), nullif(product.sku, ''), nullif(line.supplier_sku, ''), 'LINE:' || line.id::text))) as sku_key
      from public.foreign_trade_operation_lines line
      left join public.content_products product on product.id = line.content_product_id
      where p_operation_id is not null and line.operation_id = p_operation_id
    ), keys as (
      select sku_key from latest_inventory where p_operation_id is null or sku_key in (select sku_key from selected_skus)
      union
      select sku_key from operation_units
    )
    select
      keys.sku_key,
      coalesce(inventory.sku, units.sku, keys.sku_key) as sku,
      coalesce(inventory.product_name, units.product_name, keys.sku_key) as product_name,
      units.content_product_id,
      inventory.payload,
      inventory.updated_at as inventory_updated_at,
      coalesce(units.current_units, 0) as current_units,
      coalesce(units.future_units, 0) as future_units,
      units.earliest_arrival,
      coalesce(units.unit_cost_usd, 0) as unit_cost_usd
    from keys
    left join latest_inventory inventory on inventory.sku_key = keys.sku_key
    left join operation_units units on units.sku_key = keys.sku_key
    order by coalesce(inventory.product_name, units.product_name, keys.sku_key)
  loop
    v_available := coalesce(
      public.foreign_trade_safe_numeric(v_record.payload->>'available_units'),
      public.foreign_trade_safe_numeric(v_record.payload->>'stock'),
      public.foreign_trade_safe_numeric(v_record.payload->>'quantity'),
      public.foreign_trade_safe_numeric(v_record.payload->>'existence'),
      0
    );
    v_current_units := v_available + v_record.current_units;
    v_inbound := v_record.future_units;
    v_demand := coalesce(
      public.foreign_trade_safe_numeric(v_record.payload->>'average_daily_demand'),
      case
        when public.foreign_trade_safe_numeric(v_record.payload->>'demand_observation_days') > 0
        then public.foreign_trade_safe_numeric(v_record.payload->>'units_sold_observed') /
             public.foreign_trade_safe_numeric(v_record.payload->>'demand_observation_days')
      end,
      0
    ) * v_demand_factor;
    v_coverage := case when v_demand > 0 then v_current_units / v_demand else null end;
    v_safety_units := ceil(v_demand * v_safety_days);
    v_target_units := ceil(v_demand * v_effective_target_days);
    v_projected_arrival := greatest(0, v_current_units - v_demand * greatest(0, coalesce(v_record.earliest_arrival - v_as_of, v_lead_days))) + v_inbound;
    v_recommended := ceil(greatest(0, v_target_units - v_current_units - v_inbound));
    v_stockout := case when v_demand > 0 then v_as_of + floor(v_current_units / v_demand)::integer else null end;
    v_required := case when v_stockout is not null then v_stockout - v_lead_days else null end;
    v_severity := case
      when v_demand <= 0 then 'medium'
      when v_projected_arrival <= 0 or coalesce(v_coverage, 0) < v_lead_days then 'critical'
      when coalesce(v_coverage, 0) < v_lead_days + v_safety_days then 'high'
      when coalesce(v_coverage, 0) < v_effective_target_days then 'medium'
      else 'low'
    end;
    v_confidence := least(1,
      0.15 +
      case when v_record.payload is not null and public.foreign_trade_safe_boolean(v_record.payload->>'stock_known', true) then 0.30 else 0 end +
      case when v_demand > 0 then 0.30 else 0 end +
      case when v_record.content_product_id is not null or v_record.sku_key not like 'LINE:%' then 0.15 else 0 end +
      case when v_record.inventory_updated_at >= now() - interval '7 days' then 0.10 else 0 end
    );
    v_warnings := '[]'::jsonb;
    if v_record.payload is null then v_warnings := v_warnings || '"Sin snapshot de inventario Facto"'::jsonb; end if;
    if v_demand <= 0 then v_warnings := v_warnings || '"Sin demanda histórica suficiente"'::jsonb; end if;
    if v_record.sku_key like 'LINE:%' then v_warnings := v_warnings || '"Producto sin SKU homologado"'::jsonb; end if;
    if v_record.inventory_updated_at is not null and v_record.inventory_updated_at < now() - interval '7 days' then
      v_warnings := v_warnings || '"Inventario Facto desactualizado"'::jsonb;
    end if;
    if v_record.current_units > 0 then
      v_warnings := v_warnings || '"La operación está en modo inventario actual; confirmar que Facto aún no la incluya para evitar doble conteo"'::jsonb;
    end if;

    insert into public.replenishment_recommendations(
      task_id, snapshot_id, operation_id, sku, product_name,
      available_units, committed_units, confirmed_inbound_units, current_operation_units,
      average_daily_demand, monthly_demand, lead_time_days, safety_stock_units,
      reorder_point_units, target_units, projected_stock_at_arrival, coverage_days,
      recommended_units, recommended_value_usd, required_order_date,
      projected_stockout_date, severity, purchase_policy, confidence,
      confidence_level, data_quality, rationale, warnings, status, updated_at
    ) values (
      p_task_id, v_snapshot_id, p_operation_id, v_record.sku, v_record.product_name,
      v_available, 0, v_inbound, v_record.current_units,
      v_demand, v_demand * 30, v_lead_days, v_safety_units,
      ceil(v_demand * (v_lead_days + v_safety_days)), v_target_units,
      v_projected_arrival, v_coverage, v_recommended,
      v_recommended * coalesce(v_record.unit_cost_usd, 0), v_required,
      v_stockout, v_severity, 'analysis_only_no_automatic_purchase', v_confidence,
      case when v_confidence >= 0.8 then 'high' when v_confidence >= 0.55 then 'medium' else 'low' end,
      jsonb_build_object(
        'stock_known', v_record.payload is not null,
        'demand_known', v_demand > 0,
        'inventory_observed_at', v_record.inventory_updated_at,
        'sku_homologated', v_record.sku_key not like 'LINE:%'
      ),
      jsonb_build_object(
        'formula', 'target_units - current_stock - confirmed_inbound',
        'target_days', v_effective_target_days,
        'current_stock', v_current_units,
        'facto_stock', v_available,
        'current_operation_units', v_record.current_units,
        'confirmed_inbound', v_inbound,
        'daily_demand', v_demand,
        'source', 'Facto read-only + official foreign trade operations'
      ),
      v_warnings, 'pending', now()
    );

    v_count := v_count + 1;
    if v_severity = 'critical' then v_critical := v_critical + 1; end if;
    if v_severity = 'high' then v_high := v_high + 1; end if;
    v_total_recommended := v_total_recommended + v_recommended;
    v_avg_confidence := v_avg_confidence + v_confidence;
  end loop;

  update public.foreign_trade_intelligence_snapshots
  set summary = jsonb_build_object(
        'products_analyzed', v_count,
        'critical_products', v_critical,
        'high_risk_products', v_high,
        'recommended_units', v_total_recommended,
        'products_with_data_gaps', (select count(*) from public.replenishment_recommendations r where r.snapshot_id = v_snapshot_id and jsonb_array_length(r.warnings) > 0),
        'automatic_actions', false,
        'source', 'Facto read-only + Centro de Comercio Exterior'
      ),
      confidence = case when v_count > 0 then v_avg_confidence / v_count else 0 end
  where id = v_snapshot_id;

  insert into public.foreign_trade_audit_log(
    operation_id, entity_type, record_id, action, new_values, origin, actor_id, agent_type
  ) values (
    p_operation_id, 'foreign_trade_intelligence_snapshot', v_snapshot_id,
    'simulate',
    jsonb_build_object(
      'event', 'analysis_created',
      'products', v_count,
      'critical', v_critical,
      'recommended_units', v_total_recommended
    ),
    case when p_task_id is null then 'user' else 'agent' end,
    case when auth.role() = 'service_role' then null else auth.uid() end,
    case when p_task_id is null then null else 'foreign_trade' end
  );

  return v_snapshot_id;
end
$$;

-- Contexto normalizado para el worker. La tarea debe estar arrendada, vigente y
-- pertenecer al agente de Comercio Exterior; una tarea comercial nunca pasa esta validacion.
create or replace function public.foreign_trade_agent_context(
  p_task_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_operation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.business_agent_tasks%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'foreign_trade_agent_context_service_only' using errcode = '42501';
  end if;
  select * into v_task
  from public.business_agent_tasks
  where id = p_task_id
    and agent_type = 'foreign_trade'
    and status = 'in_progress'
    and worker_id = p_worker_id
    and lease_token = p_lease_token
    and lease_expires_at > now();
  if not found or not public.foreign_trade_agent_has_permission('foreign_trade', 'foreign_trade.read') then
    raise exception 'foreign_trade_agent_context_forbidden' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'contract', 'foreign_trade_intelligence_v1',
    'read_only', true,
    'automatic_actions', false,
    'operation', case when p_operation_id is null then null else (
      select to_jsonb(operation) - 'created_by' - 'updated_by'
      from public.import_shipments operation where operation.id = p_operation_id
    ) end,
    'operation_lines', coalesce((
      select jsonb_agg(to_jsonb(line) - 'created_by' - 'updated_by' order by line.line_number)
      from public.foreign_trade_operation_lines line
      where line.operation_id = coalesce(
        p_operation_id,
        public.foreign_trade_safe_uuid(v_task.payload->>'operation_id')
      )
    ), '[]'::jsonb),
    'inventory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', record.payload->>'sku',
        'name', coalesce(record.payload->>'name', record.payload->>'product_name'),
        'available_units', coalesce(record.payload->'available_units', record.payload->'stock', record.payload->'quantity', record.payload->'existence'),
        'average_daily_demand', record.payload->'average_daily_demand',
        'units_sold_observed', record.payload->'units_sold_observed',
        'demand_observation_days', record.payload->'demand_observation_days',
        'observed_at', record.updated_at
      ))
      from (
        select distinct on (upper(trim(source.payload->>'sku')))
          source.payload,
          source.updated_at
        from public.integration_records source
        where source.provider = 'facto'
          and source.resource = 'inventory_snapshots'
          and nullif(trim(source.payload->>'sku'), '') is not null
        order by upper(trim(source.payload->>'sku')), source.updated_at desc
        limit 5000
      ) record
    ), '[]'::jsonb),
    'latest_snapshot', (
      select jsonb_build_object('id', snapshot.id, 'summary', snapshot.summary, 'assumptions', snapshot.assumptions, 'created_at', snapshot.created_at)
      from public.foreign_trade_intelligence_snapshots snapshot
      where p_operation_id is null or snapshot.operation_id = p_operation_id
      order by snapshot.created_at desc limit 1
    )
  );
end
$$;

-- Los workers pueden reclamar solamente tareas de su propio agente. Se mantiene
-- la funcion historica para compatibilidad, pero el endpoint nuevo usa este contrato.
create or replace function public.claim_business_agent_task_for_agent(
  p_worker_id text,
  p_agent_type text,
  p_lease_seconds integer default 120
)
returns table(task jsonb, lease_token uuid, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.business_agent_tasks%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then
    raise exception 'agent_task_claim_service_only' using errcode = '42501';
  end if;
  if p_agent_type not in ('commercial', 'marketing', 'finance', 'collections', 'logistics', 'foreign_trade', 'executive') then
    raise exception 'invalid_agent_type';
  end if;

  select bat.* into v_task
  from public.business_agent_tasks bat
  where bat.agent_type = p_agent_type
    and (bat.status = 'pending' or (bat.status = 'in_progress' and bat.lease_expires_at < now()))
  order by bat.priority desc, bat.created_at
  for update skip locked
  limit 1;
  if not found then return; end if;

  update public.business_agent_tasks bat
  set status = 'in_progress',
      worker_id = p_worker_id,
      lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => greatest(30, least(600, p_lease_seconds))),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where bat.id = v_task.id
  returning to_jsonb(bat.*), bat.lease_token, bat.lease_expires_at
  into task, lease_token, lease_expires_at;
  return next;
end
$$;

drop trigger if exists set_foreign_trade_intelligence_scenarios_updated_at on public.foreign_trade_intelligence_scenarios;
create trigger set_foreign_trade_intelligence_scenarios_updated_at
before update on public.foreign_trade_intelligence_scenarios
for each row execute function public.set_updated_at();

alter table public.foreign_trade_intelligence_scenarios enable row level security;
alter table public.foreign_trade_intelligence_snapshots enable row level security;

drop policy if exists foreign_trade_intelligence_scenarios_read on public.foreign_trade_intelligence_scenarios;
create policy foreign_trade_intelligence_scenarios_read on public.foreign_trade_intelligence_scenarios
for select to authenticated using (public.foreign_trade_has_permission('foreign_trade.view'));
drop policy if exists foreign_trade_intelligence_scenarios_manage on public.foreign_trade_intelligence_scenarios;
create policy foreign_trade_intelligence_scenarios_manage on public.foreign_trade_intelligence_scenarios
for all to authenticated
using (public.foreign_trade_has_permission('foreign_trade.simulate'))
with check (public.foreign_trade_has_permission('foreign_trade.simulate'));

drop policy if exists foreign_trade_intelligence_snapshots_read on public.foreign_trade_intelligence_snapshots;
create policy foreign_trade_intelligence_snapshots_read on public.foreign_trade_intelligence_snapshots
for select to authenticated using (public.foreign_trade_has_permission('foreign_trade.view'));

grant select, insert, update, delete on public.foreign_trade_intelligence_scenarios to authenticated;
grant select on public.foreign_trade_intelligence_snapshots to authenticated;
grant all on public.foreign_trade_intelligence_scenarios, public.foreign_trade_intelligence_snapshots to service_role;

revoke all on function public.foreign_trade_safe_numeric(text) from public;
revoke all on function public.foreign_trade_setting_numeric(text, numeric) from public;
revoke all on function public.foreign_trade_safe_boolean(text, boolean) from public;
revoke all on function public.foreign_trade_safe_uuid(text) from public;
revoke all on function public.foreign_trade_safe_date(text, date) from public;
revoke all on function public.run_foreign_trade_intelligence(uuid, jsonb, uuid) from public;
revoke all on function public.foreign_trade_agent_context(uuid, text, uuid, uuid) from public;
revoke all on function public.claim_business_agent_task_for_agent(text, text, integer) from public;
grant execute on function public.run_foreign_trade_intelligence(uuid, jsonb, uuid) to authenticated, service_role;
grant execute on function public.foreign_trade_agent_context(uuid, text, uuid, uuid) to service_role;
grant execute on function public.claim_business_agent_task_for_agent(text, text, integer) to service_role;

comment on column public.import_shipments.inventory_mode is
  'current suma unidades al stock operativo; future las considera entrada confirmada; historical solo conserva trazabilidad.';
comment on function public.foreign_trade_agent_context(uuid, text, uuid, uuid) is
  'Contrato privado: exige lease vigente de una tarea foreign_trade. El Agente Comercial no puede obtener este contexto.';
comment on function public.run_foreign_trade_intelligence(uuid, jsonb, uuid) is
  'Motor determinista y explicable. Genera snapshots y recomendaciones; nunca modifica stock, compras ni documentos oficiales.';
