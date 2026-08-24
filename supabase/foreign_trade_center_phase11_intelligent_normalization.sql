-- Centro de Comercio Exterior - Fase 11
-- Versionado canonico, memoria logistica y ciclo de vida administrativo seguro.
-- Ejecutar despues de foreign_trade_center_phase10_product_reconciliation.sql.

begin;

create table if not exists public.foreign_trade_document_processing_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.foreign_trade_documents(id) on delete cascade,
  operation_id uuid not null references public.import_shipments(id) on delete cascade,
  version integer not null check (version > 0),
  extraction_version text not null,
  classification text not null,
  status text not null default 'review_required'
    check (status in ('processing','review_required','confirmed','superseded','failed')),
  canonical_header jsonb not null default '{}'::jsonb,
  canonical_lines jsonb not null default '[]'::jsonb,
  validation_summary jsonb not null default '{}'::jsonb,
  global_confidence numeric(7,6) check (global_confidence between 0 and 1),
  extraction_model text,
  extraction_request_id text,
  rules_version text not null default 'canonical_v1',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(document_id, version),
  check (jsonb_typeof(canonical_header) = 'object'),
  check (jsonb_typeof(canonical_lines) = 'array'),
  check (jsonb_typeof(validation_summary) = 'object')
);

create index if not exists foreign_trade_processing_document_idx
  on public.foreign_trade_document_processing_versions(document_id, version desc);

create table if not exists public.foreign_trade_document_exceptions (
  id uuid primary key default gen_random_uuid(),
  processing_version_id uuid not null references public.foreign_trade_document_processing_versions(id) on delete cascade,
  document_id uuid not null references public.foreign_trade_documents(id) on delete cascade,
  operation_id uuid not null references public.import_shipments(id) on delete cascade,
  source_index integer,
  field_name text,
  code text not null,
  severity text not null default 'warning' check (severity in ('info','warning','error')),
  message text not null,
  proposed_value jsonb,
  confidence numeric(7,6) check (confidence between 0 and 1),
  status text not null default 'open' check (status in ('open','accepted','corrected','rejected','resolved')),
  resolution jsonb not null default '{}'::jsonb,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check (proposed_value is null or jsonb_typeof(proposed_value) in ('object','array','string','number','boolean','null')),
  check (jsonb_typeof(resolution) = 'object')
);

create index if not exists foreign_trade_exceptions_open_idx
  on public.foreign_trade_document_exceptions(operation_id, status, severity, created_at desc);

create table if not exists public.foreign_trade_product_logistics_profiles (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.suppliers(id) on delete cascade,
  supplier_scope text generated always as (coalesce(supplier_id::text, 'global')) stored,
  content_product_id uuid references public.content_products(id) on delete cascade,
  normalized_key text not null,
  supplier_product_code text,
  supplier_sku text,
  normalized_description text,
  unit_weight_kg numeric(18,9),
  gross_weight_kg numeric(18,9),
  net_weight_kg numeric(18,9),
  length_cm numeric(18,9),
  width_cm numeric(18,9),
  height_cm numeric(18,9),
  units_per_carton numeric(18,9),
  cbm_per_carton numeric(18,12),
  cbm_per_unit numeric(18,12),
  observations_count integer not null default 1 check (observations_count > 0),
  confidence numeric(7,6) not null default 0.8 check (confidence between 0 and 1),
  calculation_method text not null default 'document_direct',
  source_document_id uuid references public.foreign_trade_documents(id) on delete set null,
  source_operation_id uuid references public.import_shipments(id) on delete set null,
  source_line_id uuid references public.foreign_trade_operation_lines(id) on delete set null,
  confirmed boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  last_observed_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(supplier_scope, normalized_key),
  check (jsonb_typeof(metadata) = 'object')
);

create index if not exists foreign_trade_logistics_product_idx
  on public.foreign_trade_product_logistics_profiles(content_product_id, confidence desc, last_observed_at desc);

create or replace function public.record_foreign_trade_document_processing_version(
  p_document_id uuid,
  p_payload jsonb,
  p_confidence numeric default null,
  p_warnings jsonb default '[]'::jsonb,
  p_model text default null,
  p_request_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_document public.foreign_trade_documents%rowtype;
  v_id uuid;
  v_version integer;
  v_warning jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage')
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_payload->'lines', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_warnings, '[]'::jsonb)) <> 'array' then
    raise exception 'foreign_trade_invalid_canonical_payload';
  end if;

  select * into v_document from public.foreign_trade_documents where id = p_document_id;
  if not found then raise exception 'foreign_trade_document_not_found'; end if;

  select coalesce(max(version), 0) + 1 into v_version
  from public.foreign_trade_document_processing_versions where document_id = p_document_id;

  update public.foreign_trade_document_processing_versions
  set status = 'superseded'
  where document_id = p_document_id and status <> 'confirmed';

  insert into public.foreign_trade_document_processing_versions(
    document_id, operation_id, version, extraction_version, classification, status,
    canonical_header, canonical_lines, validation_summary, global_confidence,
    extraction_model, extraction_request_id, created_by
  ) values (
    p_document_id, v_document.operation_id, v_version,
    coalesce(nullif(trim(p_payload->>'extraction_version'), ''), 'legacy'),
    v_document.document_type, 'review_required',
    coalesce(p_payload->'general', '{}'::jsonb),
    coalesce(p_payload->'lines', '[]'::jsonb),
    jsonb_build_object(
      'document_totals', coalesce(p_payload->'document_totals', p_payload->'totals', '{}'::jsonb),
      'warning_count', jsonb_array_length(coalesce(p_warnings, '[]'::jsonb)),
      'line_count', jsonb_array_length(coalesce(p_payload->'lines', '[]'::jsonb)),
      'source', 'normalized_edge_function'
    ), p_confidence, p_model, p_request_id, auth.uid()
  ) returning id into v_id;

  for v_warning in select value from jsonb_array_elements(coalesce(p_warnings, '[]'::jsonb))
  loop
    insert into public.foreign_trade_document_exceptions(
      processing_version_id, document_id, operation_id, source_index, field_name,
      code, severity, message, confidence
    ) values (
      v_id, p_document_id, v_document.operation_id,
      nullif(trim(v_warning->>'line_index'), '')::integer,
      nullif(trim(v_warning->>'field_name'), ''),
      coalesce(nullif(trim(v_warning->>'code'), ''), 'document_warning'),
      case when v_warning->>'severity' in ('info','warning','error') then v_warning->>'severity' else 'warning' end,
      left(coalesce(nullif(trim(v_warning->>'message'), ''), 'Dato que requiere revisión.'), 1000),
      p_confidence
    );
  end loop;

  return v_id;
end
$$;

create or replace function public.foreign_trade_capture_logistics_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_supplier_id uuid;
  v_key text;
  v_cbm_per_unit numeric(18,12);
  v_method text;
  v_confidence numeric(7,6);
begin
  if new.cbm_total is null and new.cbm_per_box is null
     and (new.box_length_cm is null or new.box_width_cm is null or new.box_height_cm is null)
     and new.unit_weight_kg is null then
    return new;
  end if;

  select supplier_id into v_supplier_id from public.import_shipments where id = new.operation_id;
  v_key := coalesce(
    public.normalize_foreign_trade_product_code(new.supplier_sku),
    public.normalize_foreign_trade_product_code(new.sku),
    case when new.content_product_id is not null then 'PRODUCT:' || new.content_product_id::text end,
    'DESCRIPTION:' || md5(coalesce(public.normalize_foreign_trade_product_text(new.product_name), new.id::text))
  );
  v_cbm_per_unit := case
    when new.cbm_total > 0 and new.quantity > 0 then round(new.cbm_total / new.quantity, 12)
    when new.cbm_per_box > 0 and new.quantity_per_box > 0 then round(new.cbm_per_box / new.quantity_per_box, 12)
    when new.box_length_cm > 0 and new.box_width_cm > 0 and new.box_height_cm > 0 and new.quantity_per_box > 0
      then round((new.box_length_cm * new.box_width_cm * new.box_height_cm / 1000000) / new.quantity_per_box, 12)
    else null
  end;
  v_method := case
    when new.cbm_total > 0 then 'document_direct'
    when new.cbm_per_box > 0 then 'master_carton'
    when new.box_length_cm > 0 and new.box_width_cm > 0 and new.box_height_cm > 0 then 'dimensions'
    else 'weight_reference'
  end;
  v_confidence := case v_method when 'document_direct' then 1 when 'dimensions' then 0.9 when 'master_carton' then 0.9 else 0.6 end;

  insert into public.foreign_trade_product_logistics_profiles(
    supplier_id, content_product_id, normalized_key, supplier_sku, normalized_description,
    unit_weight_kg, gross_weight_kg, net_weight_kg, length_cm, width_cm, height_cm,
    units_per_carton, cbm_per_carton, cbm_per_unit, confidence, calculation_method,
    source_document_id, source_operation_id, source_line_id, confirmed, metadata,
    created_by, updated_by
  ) values (
    v_supplier_id, new.content_product_id, v_key, new.supplier_sku,
    public.normalize_foreign_trade_product_text(new.product_name),
    new.unit_weight_kg, new.gross_weight_kg, new.net_weight_kg,
    new.box_length_cm, new.box_width_cm, new.box_height_cm,
    new.quantity_per_box, new.cbm_per_box, v_cbm_per_unit, v_confidence, v_method,
    new.source_document_id, new.operation_id, new.id,
    new.data_source in ('real','configured'),
    jsonb_build_object('data_source', new.data_source, 'source_snapshot', new.source_snapshot),
    auth.uid(), auth.uid()
  )
  on conflict (supplier_scope, normalized_key) do update set
    content_product_id = coalesce(excluded.content_product_id, public.foreign_trade_product_logistics_profiles.content_product_id),
    supplier_sku = coalesce(excluded.supplier_sku, public.foreign_trade_product_logistics_profiles.supplier_sku),
    normalized_description = coalesce(excluded.normalized_description, public.foreign_trade_product_logistics_profiles.normalized_description),
    unit_weight_kg = coalesce(excluded.unit_weight_kg, public.foreign_trade_product_logistics_profiles.unit_weight_kg),
    gross_weight_kg = coalesce(excluded.gross_weight_kg, public.foreign_trade_product_logistics_profiles.gross_weight_kg),
    net_weight_kg = coalesce(excluded.net_weight_kg, public.foreign_trade_product_logistics_profiles.net_weight_kg),
    length_cm = coalesce(excluded.length_cm, public.foreign_trade_product_logistics_profiles.length_cm),
    width_cm = coalesce(excluded.width_cm, public.foreign_trade_product_logistics_profiles.width_cm),
    height_cm = coalesce(excluded.height_cm, public.foreign_trade_product_logistics_profiles.height_cm),
    units_per_carton = coalesce(excluded.units_per_carton, public.foreign_trade_product_logistics_profiles.units_per_carton),
    cbm_per_carton = coalesce(excluded.cbm_per_carton, public.foreign_trade_product_logistics_profiles.cbm_per_carton),
    cbm_per_unit = coalesce(excluded.cbm_per_unit, public.foreign_trade_product_logistics_profiles.cbm_per_unit),
    observations_count = public.foreign_trade_product_logistics_profiles.observations_count + 1,
    confidence = greatest(public.foreign_trade_product_logistics_profiles.confidence, excluded.confidence),
    calculation_method = case when excluded.confidence >= public.foreign_trade_product_logistics_profiles.confidence then excluded.calculation_method else public.foreign_trade_product_logistics_profiles.calculation_method end,
    source_document_id = coalesce(excluded.source_document_id, public.foreign_trade_product_logistics_profiles.source_document_id),
    source_operation_id = excluded.source_operation_id,
    source_line_id = excluded.source_line_id,
    confirmed = public.foreign_trade_product_logistics_profiles.confirmed or excluded.confirmed,
    metadata = public.foreign_trade_product_logistics_profiles.metadata || excluded.metadata,
    last_observed_at = now(), updated_by = auth.uid(), updated_at = now();
  return new;
end
$$;

drop trigger if exists capture_foreign_trade_logistics_profile on public.foreign_trade_operation_lines;
create trigger capture_foreign_trade_logistics_profile
after insert or update of content_product_id, supplier_sku, sku, product_name, quantity,
  quantity_per_box, box_count, unit_weight_kg, gross_weight_kg, net_weight_kg,
  box_length_cm, box_width_cm, box_height_cm, cbm_per_box, cbm_total, data_source
on public.foreign_trade_operation_lines
for each row execute function public.foreign_trade_capture_logistics_profile();

create or replace function public.delete_foreign_trade_document_admin(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_document public.foreign_trade_documents%rowtype;
  v_reconciliation_id uuid;
  v_storage jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage')
     or not public.foreign_trade_has_permission('foreign_trade.operations.manage')
     or not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;

  select * into v_document from public.foreign_trade_documents where id = p_document_id for update;
  if not found then raise exception 'foreign_trade_document_not_found'; end if;
  v_storage := jsonb_build_object(
    'storage_bucket', v_document.storage_bucket,
    'storage_path', v_document.storage_path,
    'original_file_name', v_document.original_file_name,
    'was_confirmed', v_document.parse_status = 'confirmed'
  );

  -- Productos importados exclusivamente desde el documento.
  delete from public.foreign_trade_operation_lines
  where source_document_id = p_document_id;

  -- Costos de flete o respaldos creados/vinculados por el documento.
  delete from public.foreign_trade_cost_lines
  where operation_id = v_document.operation_id
    and (
      metadata->>'source_document_id' = p_document_id::text
      or metadata->>'freight_supporting_document_id' = p_document_id::text
      or exists (
        select 1 from public.foreign_trade_expense_reconciliation_lines line
        where line.applied_cost_line_id = foreign_trade_cost_lines.id
          and line.metadata->>'actual_source_document_id' = p_document_id::text
      )
    );

  -- Revierte solo el lado respaldado por el documento; conserva el otro para revisión.
  for v_reconciliation_id in
    select id from public.foreign_trade_expense_reconciliations
    where provision_document_id = p_document_id or final_document_id = p_document_id
  loop
    if exists (
      select 1 from public.foreign_trade_expense_reconciliations
      where id = v_reconciliation_id and provision_document_id = p_document_id
    ) then
      update public.foreign_trade_expense_reconciliation_lines
      set provision_net_clp = 0, provision_vat_clp = 0, provision_total_clp = 0,
          provision_amount_original = 0, provision_currency = 'CLP', provision_exchange_rate_clp = 1,
          provision_cost_line_id = null,
          metadata = metadata - 'provision_source_document_id' - 'provision_source_index'
      where reconciliation_id = v_reconciliation_id;
      update public.foreign_trade_expense_reconciliations
      set provision_document_id = null, provision_reference = null, remittance_amount_clp = 0,
          status = 'draft', applied_at = null, applied_by = null, updated_by = auth.uid()
      where id = v_reconciliation_id;
    end if;
    if exists (
      select 1 from public.foreign_trade_expense_reconciliations
      where id = v_reconciliation_id and final_document_id = p_document_id
    ) then
      update public.foreign_trade_expense_reconciliation_lines
      set actual_net_clp = 0, actual_vat_clp = 0, actual_total_clp = 0,
          actual_amount_original = 0, actual_currency = 'CLP', actual_exchange_rate_clp = 1,
          applied_cost_line_id = null,
          metadata = metadata - 'actual_source_document_id' - 'actual_source_index'
      where reconciliation_id = v_reconciliation_id
        and metadata->>'actual_source_document_id' = p_document_id::text;
      update public.foreign_trade_expense_reconciliations
      set final_document_id = null, final_reference = null, agency_invoice_number = null,
          final_invoice_date = null, status = case when provision_document_id is null then 'draft' else 'reviewed' end,
          applied_at = null, applied_by = null, updated_by = auth.uid()
      where id = v_reconciliation_id;
    end if;
  end loop;

  delete from public.foreign_trade_documents where id = p_document_id;
  return v_storage;
end
$$;

create or replace function public.delete_foreign_trade_operation(
  p_operation_id uuid,
  p_confirmation_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_operation public.import_shipments%rowtype;
  v_documents jsonb;
  v_counts jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.operations.manage')
     or not public.foreign_trade_has_permission('foreign_trade.documents.manage')
     or not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  select * into v_operation from public.import_shipments where id = p_operation_id for update;
  if not found then raise exception 'foreign_trade_operation_not_found'; end if;
  if upper(trim(coalesce(p_confirmation_reference, ''))) <> upper(v_operation.reference) then
    raise exception 'foreign_trade_operation_confirmation_mismatch';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'storage_bucket', storage_bucket, 'storage_path', storage_path,
    'original_file_name', original_file_name
  )), '[]'::jsonb) into v_documents
  from public.foreign_trade_documents where operation_id = p_operation_id;

  select jsonb_build_object(
    'documents', (select count(*) from public.foreign_trade_documents where operation_id = p_operation_id),
    'products', (select count(*) from public.foreign_trade_operation_lines where operation_id = p_operation_id),
    'costs', (select count(*) from public.foreign_trade_cost_lines where operation_id = p_operation_id),
    'reconciliations', (select count(*) from public.foreign_trade_expense_reconciliations where operation_id = p_operation_id)
  ) into v_counts;

  insert into public.foreign_trade_audit_log(
    operation_id, entity_type, record_id, action, old_values, new_values, origin, actor_id
  ) values (
    p_operation_id, 'import_shipments', p_operation_id, 'delete',
    to_jsonb(v_operation) || jsonb_build_object('related_counts', v_counts), '{}'::jsonb,
    'crm_admin_delete', auth.uid()
  );

  delete from public.import_shipments where id = p_operation_id;
  return jsonb_build_object(
    'operation_id', p_operation_id,
    'reference', v_operation.reference,
    'documents', v_documents,
    'deleted_counts', v_counts
  );
end
$$;

alter table public.foreign_trade_document_processing_versions enable row level security;
alter table public.foreign_trade_document_exceptions enable row level security;
alter table public.foreign_trade_product_logistics_profiles enable row level security;

drop policy if exists "foreign trade read processing versions" on public.foreign_trade_document_processing_versions;
create policy "foreign trade read processing versions" on public.foreign_trade_document_processing_versions
for select to authenticated using (public.foreign_trade_has_permission('foreign_trade.view'));
drop policy if exists "foreign trade manage processing versions" on public.foreign_trade_document_processing_versions;
create policy "foreign trade manage processing versions" on public.foreign_trade_document_processing_versions
for all to authenticated using (public.foreign_trade_has_permission('foreign_trade.documents.manage'))
with check (public.foreign_trade_has_permission('foreign_trade.documents.manage'));

drop policy if exists "foreign trade read document exceptions" on public.foreign_trade_document_exceptions;
create policy "foreign trade read document exceptions" on public.foreign_trade_document_exceptions
for select to authenticated using (public.foreign_trade_has_permission('foreign_trade.view'));
drop policy if exists "foreign trade manage document exceptions" on public.foreign_trade_document_exceptions;
create policy "foreign trade manage document exceptions" on public.foreign_trade_document_exceptions
for all to authenticated using (public.foreign_trade_has_permission('foreign_trade.documents.manage'))
with check (public.foreign_trade_has_permission('foreign_trade.documents.manage'));

drop policy if exists "foreign trade read logistics profiles" on public.foreign_trade_product_logistics_profiles;
create policy "foreign trade read logistics profiles" on public.foreign_trade_product_logistics_profiles
for select to authenticated using (public.foreign_trade_has_permission('foreign_trade.view'));
drop policy if exists "foreign trade manage logistics profiles" on public.foreign_trade_product_logistics_profiles;
create policy "foreign trade manage logistics profiles" on public.foreign_trade_product_logistics_profiles
for all to authenticated using (public.foreign_trade_has_permission('foreign_trade.operations.manage'))
with check (public.foreign_trade_has_permission('foreign_trade.operations.manage'));

revoke all on function public.record_foreign_trade_document_processing_version(uuid,jsonb,numeric,jsonb,text,text) from public;
revoke all on function public.delete_foreign_trade_document_admin(uuid) from public;
revoke all on function public.delete_foreign_trade_operation(uuid,text) from public;
grant execute on function public.record_foreign_trade_document_processing_version(uuid,jsonb,numeric,jsonb,text,text) to authenticated, service_role;
grant execute on function public.delete_foreign_trade_document_admin(uuid) to authenticated, service_role;
grant execute on function public.delete_foreign_trade_operation(uuid,text) to authenticated, service_role;

comment on table public.foreign_trade_document_processing_versions is
  'Versiones inmutables del resultado normalizado de cada documento para reprocesamiento auditable.';
comment on table public.foreign_trade_product_logistics_profiles is
  'Memoria logistica deterministica por producto/proveedor, alimentada por datos revisados y trazables.';
comment on function public.delete_foreign_trade_document_admin(uuid) is
  'Elimina un documento incluso confirmado y revierte datos derivados identificables sin afectar otros respaldos.';
comment on function public.delete_foreign_trade_operation(uuid,text) is
  'Elimina una operacion completa en cascada tras confirmar exactamente su referencia y devuelve rutas privadas para limpiar Storage.';

commit;
