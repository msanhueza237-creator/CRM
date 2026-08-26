-- Clima Activa CRM - Centro de Comercio Exterior (Fase 1)
-- Ejecutar despues de schema.sql, agent_hub.sql, content_center.sql y
-- foreign_trade_actual_orders.sql. La migracion es idempotente.
--
-- Seguridad: los usuarios solo acceden mediante permisos administrativos.
-- Los workers deben validar foreign_trade_agent_has_permission(); el agente
-- commercial queda explicitamente excluido de cualquier dato de este modulo.

begin;

create extension if not exists pgcrypto;

create table if not exists public.foreign_trade_role_permissions (
  role public.app_role not null,
  permission text not null check (permission in (
    'foreign_trade.view',
    'foreign_trade.operations.manage',
    'foreign_trade.suppliers.manage',
    'foreign_trade.costs.manage',
    'foreign_trade.documents.manage',
    'foreign_trade.scenarios.manage',
    'foreign_trade.approve',
    'foreign_trade.settings.manage',
    'foreign_trade.audit.view'
  )),
  allowed boolean not null default true,
  primary key (role, permission)
);

insert into public.foreign_trade_role_permissions(role, permission, allowed)
select 'administrador'::public.app_role, permission, true
from unnest(array[
  'foreign_trade.view',
  'foreign_trade.operations.manage',
  'foreign_trade.suppliers.manage',
  'foreign_trade.costs.manage',
  'foreign_trade.documents.manage',
  'foreign_trade.scenarios.manage',
  'foreign_trade.approve',
  'foreign_trade.settings.manage',
  'foreign_trade.audit.view'
]) as permission
on conflict (role, permission) do update set allowed = excluded.allowed;

create or replace function public.foreign_trade_has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.foreign_trade_role_permissions rp
    where rp.role = public.current_role()
      and rp.permission = p_permission
      and rp.allowed = true
  )
$$;

create table if not exists public.foreign_trade_agent_permissions (
  agent_type text not null,
  permission text not null check (permission in (
    'foreign_trade.read',
    'foreign_trade.analyze',
    'foreign_trade.simulate',
    'foreign_trade.propose'
  )),
  allowed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (agent_type, permission)
);

insert into public.foreign_trade_agent_permissions(agent_type, permission, allowed)
select 'foreign_trade', permission, true
from unnest(array[
  'foreign_trade.read',
  'foreign_trade.analyze',
  'foreign_trade.simulate',
  'foreign_trade.propose'
]) as permission
on conflict (agent_type, permission) do update set allowed = excluded.allowed;

insert into public.foreign_trade_agent_permissions(agent_type, permission, allowed)
select 'commercial', permission, false
from unnest(array[
  'foreign_trade.read',
  'foreign_trade.analyze',
  'foreign_trade.simulate',
  'foreign_trade.propose'
]) as permission
on conflict (agent_type, permission) do update set allowed = excluded.allowed;

create or replace function public.foreign_trade_agent_has_permission(
  p_agent_type text,
  p_permission text
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.foreign_trade_agent_permissions ap
    where ap.agent_type = trim(p_agent_type)
      and ap.permission = p_permission
      and ap.allowed = true
  )
$$;

create table if not exists public.foreign_trade_operation_statuses (
  code text primary key,
  name text not null,
  sort_order integer not null default 100,
  color text not null default 'neutral',
  active boolean not null default true,
  final_state boolean not null default false,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.foreign_trade_operation_statuses(code, name, sort_order, color, final_state, description)
values
  ('quotation', 'Cotizacion', 10, 'neutral', false, 'Producto u operacion en estudio.'),
  ('proforma_received', 'Proforma recibida', 20, 'info', false, 'Documento recibido y pendiente de revision.'),
  ('negotiation', 'En negociacion', 30, 'warning', false, 'Costos o condiciones en negociacion.'),
  ('approved', 'Aprobada', 40, 'success', false, 'Aprobacion interna registrada.'),
  ('purchase_order', 'Orden de compra', 50, 'success', false, 'Orden preparada o emitida.'),
  ('planned', 'Planificada', 55, 'neutral', false, 'Operacion planificada.'),
  ('production', 'Produccion', 60, 'info', false, 'Mercaderia en produccion.'),
  ('ready', 'Lista para embarque', 70, 'info', false, 'Produccion terminada.'),
  ('in_transit', 'En transito', 80, 'info', false, 'Transporte internacional activo.'),
  ('chile_port', 'Puerto Chile', 90, 'warning', false, 'Mercaderia arribada a puerto.'),
  ('customs', 'Aduana', 100, 'warning', false, 'Proceso aduanero en curso.'),
  ('warehouse_transport', 'Transporte a bodega', 110, 'info', false, 'Traslado nacional a bodega.'),
  ('received', 'Recibida', 120, 'success', false, 'Mercaderia recibida en bodega.'),
  ('closed', 'Cerrada', 130, 'success', true, 'Operacion cerrada y conciliada.'),
  ('delayed', 'Atrasada', 140, 'danger', false, 'Operacion con atraso informado.'),
  ('cancelled', 'Cancelada', 150, 'danger', true, 'Operacion cancelada.')
on conflict (code) do update set
  name = excluded.name,
  sort_order = excluded.sort_order,
  color = excluded.color,
  final_state = excluded.final_state,
  description = excluded.description;

-- Reutiliza y amplia proveedores existentes del Agent Hub.
alter table public.suppliers
  add column if not exists company_name text,
  add column if not exists contact_name text,
  add column if not exists email text,
  add column if not exists whatsapp text,
  add column if not exists phone text,
  add column if not exists currency text not null default 'USD',
  add column if not exists usual_incoterms text[] not null default '{}'::text[],
  add column if not exists payment_terms text,
  add column if not exists notes text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_by uuid references public.profiles(id) on delete set null,
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;

alter table public.supplier_products
  add column if not exists content_product_id uuid,
  add column if not exists currency text not null default 'USD',
  add column if not exists supplier_model text,
  add column if not exists supplier_description text,
  add column if not exists quantity_per_box numeric(18,6),
  add column if not exists box_length_cm numeric(18,6),
  add column if not exists box_width_cm numeric(18,6),
  add column if not exists box_height_cm numeric(18,6),
  add column if not exists cbm_per_box numeric(18,6),
  add column if not exists gross_weight_kg numeric(18,6),
  add column if not exists net_weight_kg numeric(18,6),
  add column if not exists hs_code text,
  add column if not exists country_of_origin text,
  add column if not exists source text not null default 'manual',
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if to_regclass('public.content_products') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'supplier_products_content_product_fk'
     ) then
    alter table public.supplier_products
      add constraint supplier_products_content_product_fk
      foreign key (content_product_id) references public.content_products(id) on delete set null;
  end if;
end
$$;

-- import_shipments sigue siendo la entidad oficial de operacion/importacion.
alter table public.import_shipments drop constraint if exists import_shipments_status_check;
alter table public.import_shipments
  alter column value_usd type numeric(20,6),
  add column if not exists operation_type text not null default 'simulation'
    check (operation_type in ('simulation','quotation','proforma','purchase_order','shipment')),
  add column if not exists title text,
  add column if not exists base_currency text not null default 'USD',
  add column if not exists exchange_rate_clp numeric(18,6),
  add column if not exists exchange_rate_source text not null default 'manual'
    check (exchange_rate_source in ('manual','current','conservative','custom')),
  add column if not exists exchange_rate_observed_at timestamptz,
  add column if not exists incoterm text,
  add column if not exists supplier_proforma_number text,
  add column if not exists valid_until date,
  add column if not exists payment_terms text,
  add column if not exists production_days integer,
  add column if not exists target_container_cbm numeric(18,6),
  add column if not exists notes text,
  add column if not exists source_label text not null default 'configured',
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists created_by uuid references public.profiles(id) on delete set null,
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;

update public.import_shipments
set title = coalesce(nullif(trim(title), ''), reference)
where title is null or trim(title) = '';

alter table public.import_shipments alter column title set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'import_shipments_status_fk'
  ) then
    alter table public.import_shipments
      add constraint import_shipments_status_fk
      foreign key (status) references public.foreign_trade_operation_statuses(code);
  end if;
end
$$;

create table if not exists public.foreign_trade_container_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  transport_type text not null default 'sea',
  reference_capacity_cbm numeric(18,6),
  max_weight_kg numeric(18,6),
  active boolean not null default true,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.foreign_trade_container_types(code, name, reference_capacity_cbm, notes)
values
  ('20_standard', 'Contenedor 20 pies estandar', 33.200000, 'Capacidad referencial configurable.'),
  ('40_standard', 'Contenedor 40 pies estandar', 67.700000, 'Capacidad referencial configurable.'),
  ('40_high_cube', 'Contenedor 40 pies High Cube', 76.400000, 'Capacidad referencial configurable.'),
  ('custom', 'Capacidad personalizada', null, 'Ingresar capacidad objetivo por operacion.')
on conflict (code) do nothing;

alter table public.import_shipments
  add column if not exists container_type_id uuid references public.foreign_trade_container_types(id) on delete set null;

create table if not exists public.foreign_trade_operation_lines (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.import_shipments(id) on delete cascade,
  supplier_product_id uuid references public.supplier_products(id) on delete set null,
  content_product_id uuid,
  line_number integer not null default 1,
  sku text,
  supplier_sku text,
  product_name text not null,
  supplier_model text,
  description text,
  temporary_product boolean not null default false,
  linked_manually boolean not null default false,
  quantity numeric(18,6) not null default 0 check (quantity >= 0),
  quantity_per_box numeric(18,6),
  box_count numeric(18,6),
  currency text not null default 'USD',
  unit_factory_cost numeric(20,6),
  exw_total numeric(20,6),
  fob_total numeric(20,6),
  cif_total numeric(20,6),
  discount_total numeric(20,6),
  supplier_charges_total numeric(20,6),
  unit_weight_kg numeric(18,6),
  gross_weight_kg numeric(18,6),
  net_weight_kg numeric(18,6),
  box_length_cm numeric(18,6),
  box_width_cm numeric(18,6),
  box_height_cm numeric(18,6),
  cbm_per_box numeric(18,6),
  cbm_total numeric(18,6),
  hs_code text,
  country_of_origin text,
  data_source text not null default 'configured'
    check (data_source in ('real','document','configured','estimated','simulated')),
  extraction_confidence numeric(7,6) check (extraction_confidence between 0 and 1),
  source_snapshot jsonb not null default '{}'::jsonb,
  missing_fields text[] not null default '{}'::text[],
  warnings jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operation_id, line_number),
  check (jsonb_typeof(source_snapshot) = 'object'),
  check (jsonb_typeof(warnings) = 'array')
);

do $$
begin
  if to_regclass('public.content_products') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'foreign_trade_lines_content_product_fk'
     ) then
    alter table public.foreign_trade_operation_lines
      add constraint foreign_trade_lines_content_product_fk
      foreign key (content_product_id) references public.content_products(id) on delete set null;
  end if;
end
$$;

create index if not exists foreign_trade_lines_operation_idx
  on public.foreign_trade_operation_lines(operation_id, line_number);
create index if not exists foreign_trade_lines_sku_idx
  on public.foreign_trade_operation_lines(sku);

create table if not exists public.foreign_trade_scenarios (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.import_shipments(id) on delete cascade,
  based_on_id uuid references public.foreign_trade_scenarios(id) on delete set null,
  name text not null,
  status text not null default 'draft' check (status in ('draft','baseline','archived')),
  exchange_rate_clp numeric(18,6) not null check (exchange_rate_clp > 0),
  exchange_rate_source text not null default 'manual'
    check (exchange_rate_source in ('manual','current','conservative','custom')),
  allocation_method text not null default 'fob_value'
    check (allocation_method in ('fob_value','cif_value','units','weight','cbm','manual','combined')),
  allocation_weights jsonb not null default '{}'::jsonb,
  target_margin_percent numeric(9,6),
  minimum_margin_percent numeric(9,6),
  merchandise_total_original numeric(20,6),
  merchandise_total_clp numeric(20,6),
  logistics_total_clp numeric(20,6),
  duties_total_clp numeric(20,6),
  taxes_total_clp numeric(20,6),
  landed_total_clp numeric(20,6),
  projected_sales_clp numeric(20,6),
  projected_profit_clp numeric(20,6),
  projected_margin_percent numeric(9,6),
  total_cbm numeric(18,6),
  total_weight_kg numeric(18,6),
  assumptions jsonb not null default '{}'::jsonb,
  missing_inputs text[] not null default '{}'::text[],
  calculation_version text not null default 'pending_engine_v1',
  calculated_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(allocation_weights) = 'object'),
  check (jsonb_typeof(assumptions) = 'object')
);

create unique index if not exists foreign_trade_one_baseline_scenario_idx
  on public.foreign_trade_scenarios(operation_id) where status = 'baseline';

alter table public.import_shipments
  add column if not exists active_scenario_id uuid references public.foreign_trade_scenarios(id) on delete set null;

create table if not exists public.foreign_trade_cost_lines (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.import_shipments(id) on delete cascade,
  scenario_id uuid references public.foreign_trade_scenarios(id) on delete cascade,
  operation_line_id uuid references public.foreign_trade_operation_lines(id) on delete cascade,
  category text not null check (category in (
    'merchandise','origin','international_freight','insurance','chile_port',
    'storage','customs_agency','national_transport','inspection','certificate',
    'duties','taxes','supplier_charge','other'
  )),
  name text not null,
  amount_original numeric(20,6) not null default 0,
  currency text not null default 'USD',
  exchange_rate_clp numeric(18,6),
  amount_clp numeric(20,6),
  allocation_method text not null default 'operation'
    check (allocation_method in ('operation','fob_value','cif_value','units','weight','cbm','manual','combined')),
  source_type text not null default 'configured'
    check (source_type in ('real','document','configured','estimated','simulated')),
  recoverable_tax boolean not null default false,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.foreign_trade_cost_parameters (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  category text not null,
  value_type text not null check (value_type in ('percentage','fixed','reference')),
  numeric_value numeric(20,8),
  currency text,
  applies_to text not null default 'operation',
  source_label text not null default 'configured',
  valid_from date not null default current_date,
  valid_until date,
  active boolean not null default true,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (code, valid_from),
  check (valid_until is null or valid_until >= valid_from),
  check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.foreign_trade_documents (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid references public.import_shipments(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  actual_order_id uuid,
  document_type text not null default 'other' check (document_type in (
    'proforma','purchase_order','commercial_invoice','packing_list','bill_of_lading',
    'certificate_of_origin','customs_document','payment_receipt','freight_quote','other'
  )),
  original_file_name text not null,
  storage_bucket text not null default 'foreign-trade-orders',
  storage_path text not null unique,
  mime_type text,
  file_size bigint check (file_size is null or (file_size > 0 and file_size <= 52428800)),
  file_hash text,
  parse_status text not null default 'uploaded'
    check (parse_status in ('uploaded','queued','extracting','review_required','confirmed','failed')),
  extraction_result jsonb not null default '{}'::jsonb,
  extraction_confidence numeric(7,6) check (extraction_confidence between 0 and 1),
  review_warnings jsonb not null default '[]'::jsonb,
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles(id) on delete set null,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(extraction_result) = 'object'),
  check (jsonb_typeof(review_warnings) = 'array')
);

do $$
begin
  if to_regclass('public.foreign_trade_actual_orders') is not null
     and not exists (
       select 1 from pg_constraint where conname = 'foreign_trade_documents_actual_order_fk'
     ) then
    alter table public.foreign_trade_documents
      add constraint foreign_trade_documents_actual_order_fk
      foreign key (actual_order_id) references public.foreign_trade_actual_orders(id) on delete set null;
  end if;
end
$$;

create table if not exists public.foreign_trade_market_references (
  id uuid primary key default gen_random_uuid(),
  content_product_id uuid,
  sku text,
  competitor_name text,
  reference_price_clp numeric(20,6) not null,
  observed_at date not null default current_date,
  source_url text,
  source_type text not null default 'manual' check (source_type in ('manual','document','integration')),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

do $$
begin
  if to_regclass('public.content_products') is not null
     and not exists (
       select 1 from pg_constraint where conname = 'foreign_trade_market_content_product_fk'
     ) then
    alter table public.foreign_trade_market_references
      add constraint foreign_trade_market_content_product_fk
      foreign key (content_product_id) references public.content_products(id) on delete set null;
  end if;
end
$$;

create table if not exists public.foreign_trade_alerts (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid references public.import_shipments(id) on delete cascade,
  operation_line_id uuid references public.foreign_trade_operation_lines(id) on delete cascade,
  scenario_id uuid references public.foreign_trade_scenarios(id) on delete cascade,
  severity text not null default 'warning' check (severity in ('info','warning','high','critical')),
  code text not null,
  title text not null,
  detail text not null,
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  data_source text not null default 'system',
  metadata jsonb not null default '{}'::jsonb,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.foreign_trade_audit_log (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid references public.import_shipments(id) on delete set null,
  entity_type text not null,
  record_id uuid,
  action text not null check (action in ('insert','update','delete','approve','confirm','simulate','extract')),
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  origin text not null default 'crm',
  actor_id uuid references public.profiles(id) on delete set null,
  agent_type text,
  correlation_id uuid,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(old_values) = 'object'),
  check (jsonb_typeof(new_values) = 'object')
);

create index if not exists foreign_trade_operations_status_idx
  on public.import_shipments(status, created_at desc);
create index if not exists foreign_trade_operations_supplier_idx
  on public.import_shipments(supplier_id, created_at desc);
create index if not exists foreign_trade_scenarios_operation_idx
  on public.foreign_trade_scenarios(operation_id, created_at desc);
create index if not exists foreign_trade_cost_lines_operation_idx
  on public.foreign_trade_cost_lines(operation_id, scenario_id);
create index if not exists foreign_trade_documents_operation_idx
  on public.foreign_trade_documents(operation_id, created_at desc);
create index if not exists foreign_trade_alerts_open_idx
  on public.foreign_trade_alerts(status, severity, created_at desc);
create index if not exists foreign_trade_audit_operation_idx
  on public.foreign_trade_audit_log(operation_id, created_at desc);

create or replace function public.foreign_trade_write_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  v_old_changes jsonb := '{}'::jsonb;
  v_new_changes jsonb := '{}'::jsonb;
  v_row jsonb;
  v_record_id uuid;
  v_operation_id uuid;
  v_agent_type text := nullif(current_setting('app.agent_type', true), '');
begin
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into v_old_changes
    from jsonb_each(v_old) entry
    where v_new -> entry.key is distinct from entry.value;

    select coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into v_new_changes
    from jsonb_each(v_new) entry
    where v_old -> entry.key is distinct from entry.value;
  else
    v_old_changes := v_old;
    v_new_changes := v_new;
  end if;

  v_row := case when tg_op = 'DELETE' then v_old else v_new end;
  v_record_id := nullif(v_row->>'id', '')::uuid;
  v_operation_id := case
    when tg_table_name = 'import_shipments' then v_record_id
    else nullif(v_row->>'operation_id', '')::uuid
  end;

  -- Al auditar eliminaciones en cascada, la operacion puede haber dejado de
  -- existir. Conservamos el snapshot en la auditoria sin bloquear el delete.
  if v_operation_id is not null
     and not exists (select 1 from public.import_shipments where id = v_operation_id) then
    v_operation_id := null;
  end if;

  insert into public.foreign_trade_audit_log(
    operation_id, entity_type, record_id, action,
    old_values, new_values, origin, actor_id, agent_type
  ) values (
    v_operation_id, tg_table_name, v_record_id, lower(tg_op),
    v_old_changes, v_new_changes,
    case when v_agent_type is null then 'crm' else 'agent' end,
    auth.uid(), v_agent_type
  );

  return case when tg_op = 'DELETE' then old else new end;
end
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'suppliers','supplier_products','import_shipments',
    'foreign_trade_container_types','foreign_trade_operation_lines',
    'foreign_trade_scenarios','foreign_trade_cost_lines',
    'foreign_trade_cost_parameters','foreign_trade_documents',
    'foreign_trade_market_references','foreign_trade_alerts'
  ] loop
    execute format('drop trigger if exists audit_%I on public.%I', table_name, table_name);
    execute format(
      'create trigger audit_%I after insert or update or delete on public.%I for each row execute function public.foreign_trade_write_audit()',
      table_name, table_name
    );
  end loop;
end
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'suppliers','supplier_products','import_shipments','foreign_trade_operation_statuses',
    'foreign_trade_container_types','foreign_trade_operation_lines','foreign_trade_scenarios',
    'foreign_trade_cost_lines','foreign_trade_cost_parameters','foreign_trade_documents'
  ] loop
    execute format('drop trigger if exists set_%I_updated_at on public.%I', table_name, table_name);
    execute format(
      'create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      table_name, table_name
    );
  end loop;
end
$$;

create or replace function public.foreign_trade_dashboard_summary()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare v_result jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.view') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'operations_in_preparation', (
      select count(*) from public.import_shipments o
      join public.foreign_trade_operation_statuses s on s.code = o.status
      where not s.final_state
    ),
    'proformas', (
      select count(*) from public.foreign_trade_documents where document_type = 'proforma'
    ),
    'purchase_orders', (
      select count(*) from public.import_shipments where operation_type = 'purchase_order'
    ),
    'active_shipments', (
      select count(*) from public.import_shipments
      where status in ('production','ready','in_transit','chile_port','customs','warehouse_transport')
    ),
    'suppliers', (select count(*) from public.suppliers where active),
    'total_purchase_usd', (select coalesce(sum(value_usd), 0) from public.import_shipments where status <> 'cancelled'),
    'projected_import_cost_clp', (
      select coalesce(sum(s.landed_total_clp), 0)
      from public.foreign_trade_scenarios s
      where s.status = 'baseline'
    ),
    'projected_profit_clp', (
      select coalesce(sum(s.projected_profit_clp), 0)
      from public.foreign_trade_scenarios s
      where s.status = 'baseline'
    ),
    'total_cbm', (select coalesce(sum(cbm_total), 0) from public.foreign_trade_operation_lines),
    'product_lines', (select count(*) from public.foreign_trade_operation_lines),
    'open_alerts', (select count(*) from public.foreign_trade_alerts where status = 'open'),
    'recent_simulations', coalesce((
      select jsonb_agg(to_jsonb(recent_row))
      from (
        select id, reference, title, operation_type, status, value_usd,
               exchange_rate_clp, created_at
        from public.import_shipments
        order by created_at desc
        limit 8
      ) recent_row
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end
$$;

create or replace function public.create_foreign_trade_operation(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_scenario_id uuid;
  v_reference text;
  v_title text := trim(coalesce(p_payload->>'title', ''));
  v_operation_type text := coalesce(nullif(trim(p_payload->>'operation_type'), ''), 'simulation');
  v_status text := coalesce(nullif(trim(p_payload->>'status'), ''), 'quotation');
  v_exchange_rate numeric(18,6) := nullif(trim(p_payload->>'exchange_rate_clp'), '')::numeric;
  v_supplier_id uuid := nullif(trim(p_payload->>'supplier_id'), '')::uuid;
begin
  if not public.foreign_trade_has_permission('foreign_trade.operations.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if length(v_title) < 3 or length(v_title) > 180 then
    raise exception 'foreign_trade_invalid_title';
  end if;
  if v_operation_type not in ('simulation','quotation','proforma','purchase_order','shipment') then
    raise exception 'foreign_trade_invalid_operation_type';
  end if;
  if not exists (select 1 from public.foreign_trade_operation_statuses where code = v_status and active) then
    raise exception 'foreign_trade_invalid_status';
  end if;
  if v_exchange_rate is not null and v_exchange_rate <= 0 then
    raise exception 'foreign_trade_invalid_exchange_rate';
  end if;

  v_reference := nullif(upper(trim(p_payload->>'reference')), '');
  if v_reference is null then
    v_reference := upper(left(v_operation_type, 3)) || '-' ||
      to_char(current_date, 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  end if;

  insert into public.import_shipments(
    supplier_id, reference, title, operation_type, transport_type,
    origin_port, destination_port, status, value_usd, base_currency,
    exchange_rate_clp, exchange_rate_source, exchange_rate_observed_at,
    incoterm, target_container_cbm, notes, source_label,
    created_by, updated_by
  ) values (
    v_supplier_id, v_reference, v_title, v_operation_type,
    coalesce(nullif(trim(p_payload->>'transport_type'), ''), 'sea'),
    nullif(trim(p_payload->>'origin_port'), ''),
    nullif(trim(p_payload->>'destination_port'), ''),
    v_status,
    coalesce(nullif(trim(p_payload->>'value_usd'), '')::numeric, 0),
    coalesce(nullif(upper(trim(p_payload->>'base_currency')), ''), 'USD'),
    v_exchange_rate,
    coalesce(nullif(trim(p_payload->>'exchange_rate_source'), ''), 'manual'),
    case when v_exchange_rate is null then null else now() end,
    nullif(upper(trim(p_payload->>'incoterm')), ''),
    nullif(trim(p_payload->>'target_container_cbm'), '')::numeric,
    nullif(trim(p_payload->>'notes'), ''),
    'configured', auth.uid(), auth.uid()
  ) returning id into v_id;

  if v_exchange_rate is not null then
    insert into public.foreign_trade_scenarios(
      operation_id, name, status, exchange_rate_clp, exchange_rate_source,
      assumptions, created_by, updated_by
    ) values (
      v_id, 'Escenario base', 'baseline', v_exchange_rate,
      coalesce(nullif(trim(p_payload->>'exchange_rate_source'), ''), 'manual'),
      jsonb_build_object('source', 'operation_creation'), auth.uid(), auth.uid()
    ) returning id into v_scenario_id;

    update public.import_shipments
    set active_scenario_id = v_scenario_id, updated_by = auth.uid()
    where id = v_id;
  end if;

  return v_id;
end
$$;

-- RLS: todas las entidades de costos y compras requieren permiso gerencial.
alter table public.foreign_trade_role_permissions enable row level security;
alter table public.foreign_trade_agent_permissions enable row level security;
alter table public.foreign_trade_operation_statuses enable row level security;
alter table public.suppliers enable row level security;
alter table public.supplier_products enable row level security;
alter table public.import_shipments enable row level security;
alter table public.shipment_milestones enable row level security;
alter table public.demand_forecasts enable row level security;
alter table public.replenishment_recommendations enable row level security;
alter table public.inventory_risk_alerts enable row level security;
alter table public.foreign_trade_container_types enable row level security;
alter table public.foreign_trade_operation_lines enable row level security;
alter table public.foreign_trade_scenarios enable row level security;
alter table public.foreign_trade_cost_lines enable row level security;
alter table public.foreign_trade_cost_parameters enable row level security;
alter table public.foreign_trade_documents enable row level security;
alter table public.foreign_trade_market_references enable row level security;
alter table public.foreign_trade_alerts enable row level security;
alter table public.foreign_trade_audit_log enable row level security;

drop policy if exists "authenticated read suppliers" on public.suppliers;
drop policy if exists "admins manage suppliers" on public.suppliers;
drop policy if exists "authenticated read supplier_products" on public.supplier_products;
drop policy if exists "admins manage supplier_products" on public.supplier_products;
drop policy if exists "authenticated read import_shipments" on public.import_shipments;
drop policy if exists "admins manage import_shipments" on public.import_shipments;
drop policy if exists "authenticated read shipment_milestones" on public.shipment_milestones;
drop policy if exists "admins manage shipment_milestones" on public.shipment_milestones;
drop policy if exists "authenticated read demand_forecasts" on public.demand_forecasts;
drop policy if exists "admins manage demand_forecasts" on public.demand_forecasts;
drop policy if exists "authenticated read replenishment_recommendations" on public.replenishment_recommendations;
drop policy if exists "admins manage replenishment_recommendations" on public.replenishment_recommendations;
drop policy if exists "authenticated read inventory_risk_alerts" on public.inventory_risk_alerts;
drop policy if exists "admins manage inventory_risk_alerts" on public.inventory_risk_alerts;

do $$
declare
  table_name text;
  manage_permission text;
begin
  foreach table_name in array array[
    'foreign_trade_operation_statuses','suppliers','supplier_products','import_shipments',
    'shipment_milestones','demand_forecasts','replenishment_recommendations','inventory_risk_alerts',
    'foreign_trade_container_types','foreign_trade_operation_lines',
    'foreign_trade_scenarios','foreign_trade_cost_lines','foreign_trade_cost_parameters',
    'foreign_trade_documents','foreign_trade_market_references','foreign_trade_alerts'
  ] loop
    execute format('drop policy if exists foreign_trade_read on public.%I', table_name);
    execute format(
      'create policy foreign_trade_read on public.%I for select to authenticated using (public.foreign_trade_has_permission(''foreign_trade.view''))',
      table_name
    );

    manage_permission := case
      when table_name in ('suppliers', 'supplier_products')
        then 'foreign_trade.suppliers.manage'
      when table_name = 'foreign_trade_documents'
        then 'foreign_trade.documents.manage'
      when table_name = 'foreign_trade_scenarios'
        then 'foreign_trade.scenarios.manage'
      when table_name = 'foreign_trade_cost_lines'
        then 'foreign_trade.costs.manage'
      when table_name in ('foreign_trade_operation_statuses', 'foreign_trade_container_types', 'foreign_trade_cost_parameters')
        then 'foreign_trade.settings.manage'
      else 'foreign_trade.operations.manage'
    end;

    execute format('drop policy if exists foreign_trade_manage on public.%I', table_name);
    execute format(
      'create policy foreign_trade_manage on public.%I for all to authenticated using (public.foreign_trade_has_permission(%L)) with check (public.foreign_trade_has_permission(%L))',
      table_name, manage_permission, manage_permission
    );
  end loop;
end
$$;

drop policy if exists foreign_trade_role_permissions_read on public.foreign_trade_role_permissions;
create policy foreign_trade_role_permissions_read on public.foreign_trade_role_permissions
  for select to authenticated using (public.current_role() = 'administrador');

drop policy if exists foreign_trade_agent_permissions_read on public.foreign_trade_agent_permissions;
create policy foreign_trade_agent_permissions_read on public.foreign_trade_agent_permissions
  for select to authenticated using (public.current_role() = 'administrador');

drop policy if exists foreign_trade_audit_read on public.foreign_trade_audit_log;
create policy foreign_trade_audit_read on public.foreign_trade_audit_log
  for select to authenticated using (public.foreign_trade_has_permission('foreign_trade.audit.view'));

-- El historial solo lo escriben triggers SECURITY DEFINER o service_role.
revoke insert, update, delete on public.foreign_trade_audit_log from authenticated;

-- Cierra los resultados del Agente de Comercio Exterior a usuarios no gerenciales.
drop policy if exists "authenticated read business_agent_tasks" on public.business_agent_tasks;
drop policy if exists "scoped read business_agent_tasks" on public.business_agent_tasks;
create policy "scoped read business_agent_tasks" on public.business_agent_tasks
  for select to authenticated using (
    public.current_role() = 'administrador'
    or (requested_by = auth.uid() and agent_type <> 'foreign_trade')
  );

drop policy if exists "authenticated read agent_task_events" on public.agent_task_events;
drop policy if exists "scoped read agent_task_events" on public.agent_task_events;
create policy "scoped read agent_task_events" on public.agent_task_events
  for select to authenticated using (
    exists (
      select 1 from public.business_agent_tasks task
      where task.id = agent_task_events.task_id
    )
  );

drop policy if exists "authenticated read action_proposals" on public.action_proposals;
drop policy if exists "scoped read action_proposals" on public.action_proposals;
create policy "scoped read action_proposals" on public.action_proposals
  for select to authenticated using (
    public.current_role() = 'administrador'
    or (
      kind <> 'purchase_order'
      and exists (
        select 1 from public.business_agent_tasks task
        where task.id = action_proposals.task_id
          and task.requested_by = auth.uid()
          and task.agent_type <> 'foreign_trade'
      )
    )
  );

drop policy if exists "authenticated read foreign_trade_purchase_drafts" on public.foreign_trade_purchase_drafts;
drop policy if exists "admins manage foreign_trade_purchase_drafts" on public.foreign_trade_purchase_drafts;
drop policy if exists "admin read foreign_trade_purchase_drafts" on public.foreign_trade_purchase_drafts;
drop policy if exists "admin manage foreign_trade_purchase_drafts" on public.foreign_trade_purchase_drafts;
create policy "admin read foreign_trade_purchase_drafts" on public.foreign_trade_purchase_drafts
  for select to authenticated using (public.foreign_trade_has_permission('foreign_trade.view'));
create policy "admin manage foreign_trade_purchase_drafts" on public.foreign_trade_purchase_drafts
  for all to authenticated using (public.foreign_trade_has_permission('foreign_trade.operations.manage'))
  with check (public.foreign_trade_has_permission('foreign_trade.operations.manage'));

drop policy if exists "authenticated read business_settings" on public.business_settings;
drop policy if exists "scoped read business_settings" on public.business_settings;
create policy "scoped read business_settings" on public.business_settings
  for select to authenticated using (
    key not like 'foreign_trade.%' or public.foreign_trade_has_permission('foreign_trade.view')
  );

do $$
begin
  if to_regclass('public.foreign_trade_actual_orders') is not null then
    execute 'drop policy if exists "admins read foreign trade orders" on public.foreign_trade_actual_orders';
    execute 'drop policy if exists "admins insert foreign trade orders" on public.foreign_trade_actual_orders';
    execute 'drop policy if exists "admins update foreign trade orders" on public.foreign_trade_actual_orders';
    execute 'drop policy if exists "admins delete foreign trade orders" on public.foreign_trade_actual_orders';
    execute 'drop policy if exists "foreign trade read actual orders" on public.foreign_trade_actual_orders';
    execute 'drop policy if exists "foreign trade manage actual orders" on public.foreign_trade_actual_orders';
    execute 'create policy "foreign trade read actual orders" on public.foreign_trade_actual_orders for select to authenticated using (public.foreign_trade_has_permission(''foreign_trade.view''))';
    execute 'create policy "foreign trade manage actual orders" on public.foreign_trade_actual_orders for all to authenticated using (public.foreign_trade_has_permission(''foreign_trade.operations.manage'')) with check (public.foreign_trade_has_permission(''foreign_trade.operations.manage''))';
  end if;
end
$$;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'foreign-trade-orders', 'foreign-trade-orders', false, 52428800,
  array[
    'application/pdf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/csv'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "admins read private foreign trade files" on storage.objects;
drop policy if exists "admins upload private foreign trade files" on storage.objects;
drop policy if exists "admins update private foreign trade files" on storage.objects;
drop policy if exists "admins delete private foreign trade files" on storage.objects;
drop policy if exists "authenticated read private foreign trade files" on storage.objects;
drop policy if exists "foreign trade read private files" on storage.objects;
drop policy if exists "foreign trade upload private files" on storage.objects;
drop policy if exists "foreign trade update private files" on storage.objects;
drop policy if exists "foreign trade delete private files" on storage.objects;

create policy "foreign trade read private files" on storage.objects
  for select to authenticated
  using (bucket_id = 'foreign-trade-orders' and public.foreign_trade_has_permission('foreign_trade.view'));
create policy "foreign trade upload private files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'foreign-trade-orders' and public.foreign_trade_has_permission('foreign_trade.documents.manage'));
create policy "foreign trade update private files" on storage.objects
  for update to authenticated
  using (bucket_id = 'foreign-trade-orders' and public.foreign_trade_has_permission('foreign_trade.documents.manage'))
  with check (bucket_id = 'foreign-trade-orders' and public.foreign_trade_has_permission('foreign_trade.documents.manage'));
create policy "foreign trade delete private files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'foreign-trade-orders' and public.foreign_trade_has_permission('foreign_trade.documents.manage'));

grant select on
  public.foreign_trade_role_permissions,
  public.foreign_trade_agent_permissions,
  public.foreign_trade_operation_statuses,
  public.suppliers,
  public.supplier_products,
  public.import_shipments,
  public.shipment_milestones,
  public.demand_forecasts,
  public.replenishment_recommendations,
  public.inventory_risk_alerts,
  public.foreign_trade_container_types,
  public.foreign_trade_operation_lines,
  public.foreign_trade_scenarios,
  public.foreign_trade_cost_lines,
  public.foreign_trade_cost_parameters,
  public.foreign_trade_documents,
  public.foreign_trade_market_references,
  public.foreign_trade_alerts,
  public.foreign_trade_audit_log
to authenticated;

grant insert, update, delete on
  public.foreign_trade_operation_statuses,
  public.suppliers,
  public.supplier_products,
  public.import_shipments,
  public.shipment_milestones,
  public.demand_forecasts,
  public.replenishment_recommendations,
  public.inventory_risk_alerts,
  public.foreign_trade_container_types,
  public.foreign_trade_operation_lines,
  public.foreign_trade_scenarios,
  public.foreign_trade_cost_lines,
  public.foreign_trade_cost_parameters,
  public.foreign_trade_documents,
  public.foreign_trade_market_references,
  public.foreign_trade_alerts
to authenticated;

grant all on
  public.foreign_trade_role_permissions,
  public.foreign_trade_agent_permissions,
  public.foreign_trade_operation_statuses,
  public.foreign_trade_container_types,
  public.foreign_trade_operation_lines,
  public.foreign_trade_scenarios,
  public.foreign_trade_cost_lines,
  public.foreign_trade_cost_parameters,
  public.foreign_trade_documents,
  public.foreign_trade_market_references,
  public.foreign_trade_alerts,
  public.foreign_trade_audit_log
to service_role;

revoke all on function public.foreign_trade_has_permission(text) from public;
revoke all on function public.foreign_trade_agent_has_permission(text, text) from public;
revoke all on function public.foreign_trade_dashboard_summary() from public;
revoke all on function public.create_foreign_trade_operation(jsonb) from public;
grant execute on function public.foreign_trade_has_permission(text) to authenticated, service_role;
grant execute on function public.foreign_trade_agent_has_permission(text, text) to service_role;
grant execute on function public.foreign_trade_dashboard_summary() to authenticated, service_role;
grant execute on function public.create_foreign_trade_operation(jsonb) to authenticated, service_role;

comment on function public.foreign_trade_agent_has_permission(text, text) is
  'Contrato obligatorio para workers: solo foreign_trade puede recibir contexto sensible; commercial siempre debe resultar false.';
comment on table public.foreign_trade_operation_lines is
  'Lineas historicas de proforma/importacion con snapshot; content_product_id solo vincula al catalogo maestro.';
comment on table public.foreign_trade_cost_parameters is
  'Parametros configurables. No codificar tasas legales permanentes en frontend.';
comment on table public.foreign_trade_audit_log is
  'Auditoria privada de cambios sensibles con valores anteriores y nuevos.';

commit;

select
  to_regclass('public.foreign_trade_operation_lines') as operation_lines,
  to_regclass('public.foreign_trade_scenarios') as scenarios,
  to_regclass('public.foreign_trade_audit_log') as audit_log;
