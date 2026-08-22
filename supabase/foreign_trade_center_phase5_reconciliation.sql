-- Centro de Comercio Exterior - Fase 5
-- Conciliacion de provisiones, rendiciones de agencia y saldos por devolver.
-- Ejecutar despues de foreign_trade_center_phase4_costing.sql.

begin;

do $$
declare
  v_constraint text;
begin
  select conname into v_constraint
  from pg_constraint
  where conrelid = 'public.foreign_trade_documents'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%document_type%';

  if v_constraint is not null then
    execute format('alter table public.foreign_trade_documents drop constraint %I', v_constraint);
  end if;

  alter table public.foreign_trade_documents
    add constraint foreign_trade_documents_document_type_check
    check (document_type in (
      'proforma','purchase_order','commercial_invoice','packing_list','bill_of_lading',
      'certificate_of_origin','customs_document','payment_receipt','freight_quote',
      'fund_request','agency_settlement','other'
    ));
end
$$;

-- La fase 3 validaba una lista cerrada. Se amplía el registro sin cambiar
-- su contrato para poder conservar provisiones y rendiciones como tales.
create or replace function public.register_foreign_trade_document(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
  v_operation_id uuid := nullif(trim(p_payload->>'operation_id'), '')::uuid;
  v_supplier_id uuid := nullif(trim(p_payload->>'supplier_id'), '')::uuid;
  v_operation_supplier_id uuid;
  v_document_type text := coalesce(nullif(trim(p_payload->>'document_type'), ''), 'proforma');
  v_file_name text := trim(coalesce(p_payload->>'original_file_name', ''));
  v_storage_path text := trim(coalesce(p_payload->>'storage_path', ''));
  v_mime_type text := lower(trim(coalesce(p_payload->>'mime_type', '')));
  v_file_size bigint := nullif(trim(p_payload->>'file_size'), '')::bigint;
  v_file_hash text := lower(nullif(trim(p_payload->>'file_hash'), ''));
  v_extension text;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;

  select supplier_id into v_operation_supplier_id
  from public.import_shipments
  where id = v_operation_id;
  if not found then raise exception 'foreign_trade_operation_not_found'; end if;

  v_supplier_id := coalesce(v_supplier_id, v_operation_supplier_id);
  if v_supplier_id is not null and not exists (select 1 from public.suppliers where id = v_supplier_id) then
    raise exception 'foreign_trade_supplier_not_found';
  end if;
  if v_operation_supplier_id is not null and v_supplier_id is distinct from v_operation_supplier_id then
    raise exception 'foreign_trade_document_supplier_mismatch';
  end if;

  if length(v_file_name) < 3 or length(v_file_name) > 240 then raise exception 'foreign_trade_invalid_document_name'; end if;
  v_extension := lower(regexp_replace(v_file_name, '^.*\.', ''));
  if v_extension not in ('pdf', 'xls', 'xlsx') then raise exception 'foreign_trade_invalid_document_type'; end if;
  if v_mime_type not in (
    'application/pdf','application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then raise exception 'foreign_trade_invalid_document_mime'; end if;
  if v_file_size is null or v_file_size <= 0 or v_file_size > 26214400 then raise exception 'foreign_trade_invalid_document_size'; end if;
  if v_storage_path = '' or position(v_operation_id::text || '/' in v_storage_path) <> 1 then raise exception 'foreign_trade_invalid_storage_path'; end if;
  if v_file_hash is not null and v_file_hash !~ '^[0-9a-f]{64}$' then raise exception 'foreign_trade_invalid_file_hash'; end if;
  if v_document_type not in (
    'proforma','purchase_order','commercial_invoice','packing_list','bill_of_lading',
    'certificate_of_origin','customs_document','payment_receipt','freight_quote',
    'fund_request','agency_settlement','other'
  ) then raise exception 'foreign_trade_invalid_document_type'; end if;

  insert into public.foreign_trade_documents(
    id, operation_id, supplier_id, document_type, original_file_name,
    storage_bucket, storage_path, mime_type, file_size, file_hash,
    parse_status, uploaded_by
  ) values (
    v_id, v_operation_id, v_supplier_id, v_document_type, v_file_name,
    'foreign-trade-orders', v_storage_path, v_mime_type, v_file_size, v_file_hash,
    case when v_document_type in ('proforma','purchase_order','commercial_invoice','packing_list') then 'queued' else 'uploaded' end,
    auth.uid()
  );
  return v_id;
end
$$;

create or replace function public.update_foreign_trade_document_type(
  p_document_id uuid,
  p_document_type text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_document_type text := lower(trim(coalesce(p_document_type, '')));
  v_extractable boolean;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if v_document_type not in (
    'proforma','purchase_order','commercial_invoice','packing_list','bill_of_lading',
    'certificate_of_origin','customs_document','payment_receipt','freight_quote',
    'fund_request','agency_settlement','other'
  ) then raise exception 'foreign_trade_invalid_document_type'; end if;

  v_extractable := v_document_type in ('proforma','purchase_order','commercial_invoice','packing_list');
  update public.foreign_trade_documents
  set document_type = v_document_type,
      parse_status = case when v_extractable then 'failed' else 'uploaded' end,
      extraction_result = '{}'::jsonb,
      review_result = '{}'::jsonb,
      review_version = 1,
      extraction_confidence = null,
      review_warnings = '[]'::jsonb,
      extraction_model = null,
      extraction_request_id = null,
      extraction_started_at = null,
      extraction_completed_at = null,
      extraction_error = case when v_extractable then 'Tipo actualizado. Inicia nuevamente el análisis.' else null end
  where id = p_document_id and parse_status <> 'confirmed';

  if not found then raise exception 'foreign_trade_document_not_found_or_confirmed'; end if;
end
$$;

-- Evita que una respuesta tardía de una extracción cancelada o reemplazada
-- vuelva a modificar el documento. El request id funciona como token de versión.
create or replace function public.set_foreign_trade_document_extraction(
  p_document_id uuid,
  p_status text,
  p_payload jsonb default '{}'::jsonb,
  p_confidence numeric default null,
  p_warnings jsonb default '[]'::jsonb,
  p_error text default null,
  p_model text default null,
  p_request_id text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('extracting', 'review_required', 'failed') then
    raise exception 'foreign_trade_invalid_parse_status';
  end if;
  if jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_warnings, '[]'::jsonb)) <> 'array' then
    raise exception 'foreign_trade_invalid_extraction_payload';
  end if;
  if p_confidence is not null and (p_confidence < 0 or p_confidence > 1) then
    raise exception 'foreign_trade_invalid_extraction_confidence';
  end if;
  if p_status = 'review_required' and (
    jsonb_typeof(p_payload->'general') <> 'object'
    or jsonb_typeof(p_payload->'lines') <> 'array'
  ) then
    raise exception 'foreign_trade_incomplete_extraction';
  end if;

  if p_status = 'extracting' then
    update public.foreign_trade_documents
    set parse_status = 'extracting',
        extraction_request_id = p_request_id,
        extraction_started_at = now(),
        extraction_completed_at = null,
        extraction_error = null
    where id = p_document_id and parse_status <> 'confirmed';
  else
    update public.foreign_trade_documents
    set parse_status = p_status,
        extraction_result = case when p_status = 'review_required' then p_payload else extraction_result end,
        extraction_confidence = case when p_status = 'review_required' then p_confidence else extraction_confidence end,
        review_warnings = case when p_status = 'review_required' then p_warnings else review_warnings end,
        extraction_model = coalesce(p_model, extraction_model),
        extraction_completed_at = now(),
        extraction_error = case when p_status = 'failed' then left(coalesce(p_error, 'Error de extraccion'), 2000) else null end
    where id = p_document_id
      and parse_status <> 'confirmed'
      and (
        extraction_request_id = p_request_id
        or (extraction_request_id is null and parse_status = 'queued')
      );
  end if;

  if not found then raise exception 'foreign_trade_document_request_stale_or_unavailable'; end if;
end
$$;

create or replace function public.cancel_foreign_trade_document_extraction(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;

  update public.foreign_trade_documents
  set parse_status = 'failed',
      extraction_request_id = 'cancelled:' || gen_random_uuid()::text,
      extraction_completed_at = now(),
      extraction_error = 'Analisis detenido por el usuario.'
  where id = p_document_id and parse_status <> 'confirmed';

  if not found then raise exception 'foreign_trade_document_not_found_or_confirmed'; end if;
end
$$;

create or replace function public.delete_foreign_trade_document(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_document record;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;

  delete from public.foreign_trade_documents
  where id = p_document_id and parse_status <> 'confirmed'
  returning storage_bucket, storage_path, original_file_name
  into v_document;

  if not found then raise exception 'foreign_trade_document_not_found_or_confirmed'; end if;
  return jsonb_build_object(
    'storage_bucket', v_document.storage_bucket,
    'storage_path', v_document.storage_path,
    'original_file_name', v_document.original_file_name
  );
end
$$;

create table if not exists public.foreign_trade_expense_reconciliations (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.import_shipments(id) on delete cascade,
  title text not null default 'Conciliacion de agencia',
  agency_name text,
  provision_document_id uuid references public.foreign_trade_documents(id) on delete set null,
  final_document_id uuid references public.foreign_trade_documents(id) on delete set null,
  general_estimate_cost_line_id uuid references public.foreign_trade_cost_lines(id) on delete set null,
  provision_reference text,
  final_reference text,
  agency_invoice_number text,
  remittance_date date,
  final_invoice_date date,
  remittance_amount_clp numeric(20,2) not null default 0 check (remittance_amount_clp >= 0),
  refund_received_clp numeric(20,2) not null default 0 check (refund_received_clp >= 0),
  refund_received_at date,
  status text not null default 'draft'
    check (status in ('draft','reviewed','applied','refund_pending','settled')),
  identity_confirmed boolean not null default false,
  notes text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  applied_by uuid references public.profiles(id) on delete set null,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(title)) between 2 and 180)
);

create table if not exists public.foreign_trade_expense_reconciliation_lines (
  id uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references public.foreign_trade_expense_reconciliations(id) on delete cascade,
  operation_id uuid not null references public.import_shipments(id) on delete cascade,
  position integer not null default 0 check (position >= 0),
  line_type text not null check (line_type in (
    'operating_expense','agency_fee','customs_duty','import_vat','adjustment'
  )),
  cost_category text not null check (cost_category in (
    'origin','international_freight','insurance','chile_port','storage','customs_agency',
    'national_transport','inspection','certificate','duties','taxes','supplier_charge','other'
  )),
  concept text not null,
  provider_name text,
  document_number text,
  document_date date,
  source_page integer check (source_page is null or source_page > 0),
  provision_cost_line_id uuid references public.foreign_trade_cost_lines(id) on delete set null,
  applied_cost_line_id uuid references public.foreign_trade_cost_lines(id) on delete set null,
  provision_net_clp numeric(20,2) not null default 0 check (provision_net_clp >= 0),
  provision_vat_clp numeric(20,2) not null default 0 check (provision_vat_clp >= 0),
  provision_total_clp numeric(20,2) not null default 0 check (provision_total_clp >= 0),
  provision_amount_original numeric(20,6) not null default 0 check (provision_amount_original >= 0),
  provision_currency text not null default 'CLP',
  provision_exchange_rate_clp numeric(18,6),
  actual_net_clp numeric(20,2) not null default 0 check (actual_net_clp >= 0),
  actual_vat_clp numeric(20,2) not null default 0 check (actual_vat_clp >= 0),
  actual_total_clp numeric(20,2) not null default 0 check (actual_total_clp >= 0),
  actual_amount_original numeric(20,6) not null default 0 check (actual_amount_original >= 0),
  actual_currency text not null default 'CLP',
  actual_exchange_rate_clp numeric(18,6),
  recoverable_tax boolean not null default false,
  include_in_costing boolean not null default true,
  notes text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(concept)) between 2 and 180)
);

alter table public.foreign_trade_expense_reconciliation_lines
  add column if not exists provision_amount_original numeric(20,6) not null default 0,
  add column if not exists provision_currency text not null default 'CLP',
  add column if not exists provision_exchange_rate_clp numeric(18,6),
  add column if not exists actual_amount_original numeric(20,6) not null default 0,
  add column if not exists actual_currency text not null default 'CLP',
  add column if not exists actual_exchange_rate_clp numeric(18,6);

update public.foreign_trade_expense_reconciliation_lines
set provision_amount_original = provision_total_clp,
    provision_currency = 'CLP',
    provision_exchange_rate_clp = 1
where provision_amount_original = 0 and provision_total_clp > 0
  and provision_currency = 'CLP' and provision_exchange_rate_clp is null;

update public.foreign_trade_expense_reconciliation_lines
set actual_amount_original = actual_total_clp,
    actual_currency = 'CLP',
    actual_exchange_rate_clp = 1
where actual_amount_original = 0 and actual_total_clp > 0
  and actual_currency = 'CLP' and actual_exchange_rate_clp is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'foreign_trade_reconciliation_provision_currency_check') then
    alter table public.foreign_trade_expense_reconciliation_lines
      add constraint foreign_trade_reconciliation_provision_currency_check check (provision_currency ~ '^[A-Z]{3}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'foreign_trade_reconciliation_actual_currency_check') then
    alter table public.foreign_trade_expense_reconciliation_lines
      add constraint foreign_trade_reconciliation_actual_currency_check check (actual_currency ~ '^[A-Z]{3}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'foreign_trade_reconciliation_provision_rate_check') then
    alter table public.foreign_trade_expense_reconciliation_lines
      add constraint foreign_trade_reconciliation_provision_rate_check check (provision_exchange_rate_clp is null or provision_exchange_rate_clp > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'foreign_trade_reconciliation_actual_rate_check') then
    alter table public.foreign_trade_expense_reconciliation_lines
      add constraint foreign_trade_reconciliation_actual_rate_check check (actual_exchange_rate_clp is null or actual_exchange_rate_clp > 0);
  end if;
end $$;

create index if not exists foreign_trade_reconciliations_operation_idx
  on public.foreign_trade_expense_reconciliations(operation_id, created_at desc);
create index if not exists foreign_trade_reconciliation_lines_parent_idx
  on public.foreign_trade_expense_reconciliation_lines(reconciliation_id, position);

drop trigger if exists set_foreign_trade_reconciliations_updated_at on public.foreign_trade_expense_reconciliations;
create trigger set_foreign_trade_reconciliations_updated_at
before update on public.foreign_trade_expense_reconciliations
for each row execute function public.set_updated_at();

drop trigger if exists set_foreign_trade_reconciliation_lines_updated_at on public.foreign_trade_expense_reconciliation_lines;
create trigger set_foreign_trade_reconciliation_lines_updated_at
before update on public.foreign_trade_expense_reconciliation_lines
for each row execute function public.set_updated_at();

drop trigger if exists audit_foreign_trade_expense_reconciliations on public.foreign_trade_expense_reconciliations;
create trigger audit_foreign_trade_expense_reconciliations
after insert or update or delete on public.foreign_trade_expense_reconciliations
for each row execute function public.foreign_trade_write_audit();

drop trigger if exists audit_foreign_trade_expense_reconciliation_lines on public.foreign_trade_expense_reconciliation_lines;
create trigger audit_foreign_trade_expense_reconciliation_lines
after insert or update or delete on public.foreign_trade_expense_reconciliation_lines
for each row execute function public.foreign_trade_write_audit();

alter table public.foreign_trade_expense_reconciliations enable row level security;
alter table public.foreign_trade_expense_reconciliation_lines enable row level security;

drop policy if exists foreign_trade_reconciliations_read on public.foreign_trade_expense_reconciliations;
create policy foreign_trade_reconciliations_read
on public.foreign_trade_expense_reconciliations
for select to authenticated
using (public.foreign_trade_has_permission('foreign_trade.view'));

drop policy if exists foreign_trade_reconciliation_lines_read on public.foreign_trade_expense_reconciliation_lines;
create policy foreign_trade_reconciliation_lines_read
on public.foreign_trade_expense_reconciliation_lines
for select to authenticated
using (public.foreign_trade_has_permission('foreign_trade.view'));

create or replace function public.foreign_trade_expense_reconciliation_list(p_operation_id uuid)
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

  select coalesce(jsonb_agg(
    to_jsonb(r) || jsonb_build_object(
      'lines', coalesce((
        select jsonb_agg(to_jsonb(l) order by l.position, l.created_at)
        from public.foreign_trade_expense_reconciliation_lines l
        where l.reconciliation_id = r.id
      ), '[]'::jsonb),
      'totals', jsonb_build_object(
        'provision_expenses_clp', coalesce((select sum(l.provision_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and l.line_type not in ('customs_duty','import_vat')), 0),
        'actual_expenses_clp', coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and l.line_type not in ('customs_duty','import_vat')), 0),
        'provision_taxes_clp', coalesce((select sum(l.provision_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and l.line_type in ('customs_duty','import_vat')), 0),
        'actual_taxes_clp', coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and l.line_type in ('customs_duty','import_vat')), 0),
        'provision_total_clp', coalesce((select sum(l.provision_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id), 0),
        'actual_total_clp', coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id), 0),
        'balance_clp', r.remittance_amount_clp - coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id), 0),
        'refund_due_clp', greatest(r.remittance_amount_clp - coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id), 0) - r.refund_received_clp, 0),
        'additional_payment_clp', greatest(coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id), 0) - r.remittance_amount_clp, 0)
      )
    ) order by r.created_at desc
  ), '[]'::jsonb) into v_result
  from public.foreign_trade_expense_reconciliations r
  where r.operation_id = p_operation_id;

  return v_result;
end
$$;

create or replace function public.save_foreign_trade_expense_reconciliation(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(trim(p_payload->>'id'), '')::uuid;
  v_operation_id uuid := nullif(trim(p_payload->>'operation_id'), '')::uuid;
  v_general_estimate_id uuid := nullif(trim(p_payload->>'general_estimate_cost_line_id'), '')::uuid;
  v_provision_document_id uuid := nullif(trim(p_payload->>'provision_document_id'), '')::uuid;
  v_final_document_id uuid := nullif(trim(p_payload->>'final_document_id'), '')::uuid;
  v_title text := trim(coalesce(p_payload->>'title', 'Conciliacion de agencia'));
  v_provision_reference text := nullif(trim(p_payload->>'provision_reference'), '');
  v_final_reference text := nullif(trim(p_payload->>'final_reference'), '');
  v_identity_confirmed boolean := coalesce((p_payload->>'identity_confirmed')::boolean, false);
  v_status text := coalesce(nullif(trim(p_payload->>'status'), ''), 'draft');
  v_lines jsonb := coalesce(p_payload->'lines', '[]'::jsonb);
  v_line jsonb;
  v_line_id uuid;
  v_kept_ids uuid[] := array[]::uuid[];
  v_line_type text;
  v_category text;
  v_concept text;
  v_provision_total numeric(20,2);
  v_actual_total numeric(20,2);
  v_provision_amount numeric(20,6);
  v_provision_currency text;
  v_provision_rate numeric(18,6);
  v_actual_amount numeric(20,6);
  v_actual_currency text;
  v_actual_rate numeric(18,6);
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.import_shipments where id = v_operation_id) then
    raise exception 'foreign_trade_operation_not_found';
  end if;
  if length(v_title) not between 2 and 180 then raise exception 'foreign_trade_invalid_reconciliation_title'; end if;
  if v_status not in ('draft','reviewed') then raise exception 'foreign_trade_invalid_reconciliation_status'; end if;
  if jsonb_typeof(v_lines) <> 'array' then raise exception 'foreign_trade_invalid_reconciliation_lines'; end if;
  if v_provision_reference is not null and v_final_reference is not null
     and lower(v_provision_reference) <> lower(v_final_reference) and not v_identity_confirmed then
    raise exception 'foreign_trade_reconciliation_identity_mismatch';
  end if;
  if v_general_estimate_id is not null and not exists (
    select 1 from public.foreign_trade_cost_lines where id = v_general_estimate_id and operation_id = v_operation_id
  ) then raise exception 'foreign_trade_invalid_estimate_cost_line'; end if;
  if v_provision_document_id is not null and not exists (
    select 1 from public.foreign_trade_documents where id = v_provision_document_id and operation_id = v_operation_id
  ) then raise exception 'foreign_trade_invalid_provision_document'; end if;
  if v_final_document_id is not null and not exists (
    select 1 from public.foreign_trade_documents where id = v_final_document_id and operation_id = v_operation_id
  ) then raise exception 'foreign_trade_invalid_final_document'; end if;

  if v_id is null then
    insert into public.foreign_trade_expense_reconciliations(
      operation_id, title, agency_name, provision_document_id, final_document_id,
      general_estimate_cost_line_id, provision_reference, final_reference, agency_invoice_number,
      remittance_date, final_invoice_date, remittance_amount_clp, refund_received_clp,
      refund_received_at, status, identity_confirmed, notes, metadata, created_by, updated_by
    ) values (
      v_operation_id, v_title, nullif(trim(p_payload->>'agency_name'), ''), v_provision_document_id, v_final_document_id,
      v_general_estimate_id, v_provision_reference, v_final_reference, nullif(trim(p_payload->>'agency_invoice_number'), ''),
      nullif(trim(p_payload->>'remittance_date'), '')::date, nullif(trim(p_payload->>'final_invoice_date'), '')::date,
      coalesce(nullif(trim(p_payload->>'remittance_amount_clp'), '')::numeric, 0),
      coalesce(nullif(trim(p_payload->>'refund_received_clp'), '')::numeric, 0),
      nullif(trim(p_payload->>'refund_received_at'), '')::date,
      v_status, v_identity_confirmed,
      nullif(trim(p_payload->>'notes'), ''), coalesce(p_payload->'metadata', '{}'::jsonb), auth.uid(), auth.uid()
    ) returning id into v_id;
  else
    update public.foreign_trade_expense_reconciliations
    set title = v_title,
        agency_name = nullif(trim(p_payload->>'agency_name'), ''),
        provision_document_id = v_provision_document_id,
        final_document_id = v_final_document_id,
        general_estimate_cost_line_id = v_general_estimate_id,
        provision_reference = v_provision_reference,
        final_reference = v_final_reference,
        agency_invoice_number = nullif(trim(p_payload->>'agency_invoice_number'), ''),
        remittance_date = nullif(trim(p_payload->>'remittance_date'), '')::date,
        final_invoice_date = nullif(trim(p_payload->>'final_invoice_date'), '')::date,
        remittance_amount_clp = coalesce(nullif(trim(p_payload->>'remittance_amount_clp'), '')::numeric, 0),
        refund_received_clp = coalesce(nullif(trim(p_payload->>'refund_received_clp'), '')::numeric, 0),
        refund_received_at = nullif(trim(p_payload->>'refund_received_at'), '')::date,
        status = v_status,
        identity_confirmed = v_identity_confirmed,
        notes = nullif(trim(p_payload->>'notes'), ''),
        metadata = coalesce(p_payload->'metadata', '{}'::jsonb),
        updated_by = auth.uid()
    where id = v_id and operation_id = v_operation_id;
    if not found then raise exception 'foreign_trade_reconciliation_not_found'; end if;
  end if;

  for v_line in select value from jsonb_array_elements(v_lines)
  loop
    v_line_id := nullif(trim(v_line->>'id'), '')::uuid;
    v_line_type := coalesce(nullif(trim(v_line->>'line_type'), ''), 'operating_expense');
    v_category := coalesce(nullif(trim(v_line->>'cost_category'), ''), 'other');
    v_concept := trim(coalesce(v_line->>'concept', ''));
    v_provision_amount := coalesce(nullif(trim(v_line->>'provision_amount_original'), '')::numeric, 0);
    v_provision_currency := upper(coalesce(nullif(trim(v_line->>'provision_currency'), ''), 'CLP'));
    v_provision_rate := case when v_provision_currency = 'CLP' then 1 else nullif(trim(v_line->>'provision_exchange_rate_clp'), '')::numeric end;
    v_actual_amount := coalesce(nullif(trim(v_line->>'actual_amount_original'), '')::numeric, 0);
    v_actual_currency := upper(coalesce(nullif(trim(v_line->>'actual_currency'), ''), 'CLP'));
    v_actual_rate := case when v_actual_currency = 'CLP' then 1 else nullif(trim(v_line->>'actual_exchange_rate_clp'), '')::numeric end;
    v_provision_total := coalesce(
      nullif(coalesce(nullif(trim(v_line->>'provision_total_clp'), '')::numeric, 0), 0),
      nullif(coalesce(nullif(trim(v_line->>'provision_net_clp'), '')::numeric, 0) + coalesce(nullif(trim(v_line->>'provision_vat_clp'), '')::numeric, 0), 0),
      case when v_provision_amount > 0 and v_provision_rate > 0 then round(v_provision_amount * v_provision_rate, 2) end,
      0
    );
    v_actual_total := coalesce(
      nullif(coalesce(nullif(trim(v_line->>'actual_total_clp'), '')::numeric, 0), 0),
      nullif(coalesce(nullif(trim(v_line->>'actual_net_clp'), '')::numeric, 0) + coalesce(nullif(trim(v_line->>'actual_vat_clp'), '')::numeric, 0), 0),
      case when v_actual_amount > 0 and v_actual_rate > 0 then round(v_actual_amount * v_actual_rate, 2) end,
      0
    );

    if v_line_type not in ('operating_expense','agency_fee','customs_duty','import_vat','adjustment') then raise exception 'foreign_trade_invalid_reconciliation_line_type'; end if;
    if v_category not in ('origin','international_freight','insurance','chile_port','storage','customs_agency','national_transport','inspection','certificate','duties','taxes','supplier_charge','other') then raise exception 'foreign_trade_invalid_cost_category'; end if;
    if v_provision_currency !~ '^[A-Z]{3}$' or v_actual_currency !~ '^[A-Z]{3}$' then raise exception 'foreign_trade_invalid_reconciliation_currency'; end if;
    if length(v_concept) not between 2 and 180 then raise exception 'foreign_trade_invalid_reconciliation_concept'; end if;
    if nullif(trim(v_line->>'provision_cost_line_id'), '') is not null and not exists (
      select 1 from public.foreign_trade_cost_lines
      where id = nullif(trim(v_line->>'provision_cost_line_id'), '')::uuid and operation_id = v_operation_id
    ) then raise exception 'foreign_trade_invalid_estimate_cost_line'; end if;
    if least(
      coalesce(nullif(trim(v_line->>'provision_net_clp'), '')::numeric, 0),
      coalesce(nullif(trim(v_line->>'provision_vat_clp'), '')::numeric, 0), v_provision_total,
      v_provision_amount, coalesce(v_provision_rate, 0),
      coalesce(nullif(trim(v_line->>'actual_net_clp'), '')::numeric, 0),
      coalesce(nullif(trim(v_line->>'actual_vat_clp'), '')::numeric, 0), v_actual_total,
      v_actual_amount, coalesce(v_actual_rate, 0)
    ) < 0 then raise exception 'foreign_trade_invalid_reconciliation_amount'; end if;

    if v_line_id is null then
      insert into public.foreign_trade_expense_reconciliation_lines(
        reconciliation_id, operation_id, position, line_type, cost_category, concept, provider_name,
        document_number, document_date, source_page, provision_cost_line_id,
        provision_net_clp, provision_vat_clp, provision_total_clp,
        provision_amount_original, provision_currency, provision_exchange_rate_clp,
        actual_net_clp, actual_vat_clp, actual_total_clp,
        actual_amount_original, actual_currency, actual_exchange_rate_clp,
        recoverable_tax, include_in_costing, notes, metadata
      ) values (
        v_id, v_operation_id, coalesce(nullif(trim(v_line->>'position'), '')::integer, 0), v_line_type, v_category, v_concept,
        nullif(trim(v_line->>'provider_name'), ''), nullif(trim(v_line->>'document_number'), ''),
        nullif(trim(v_line->>'document_date'), '')::date, nullif(trim(v_line->>'source_page'), '')::integer,
        nullif(trim(v_line->>'provision_cost_line_id'), '')::uuid,
        coalesce(nullif(trim(v_line->>'provision_net_clp'), '')::numeric, 0),
        coalesce(nullif(trim(v_line->>'provision_vat_clp'), '')::numeric, 0), v_provision_total,
        v_provision_amount, v_provision_currency, v_provision_rate,
        coalesce(nullif(trim(v_line->>'actual_net_clp'), '')::numeric, 0),
        coalesce(nullif(trim(v_line->>'actual_vat_clp'), '')::numeric, 0), v_actual_total,
        v_actual_amount, v_actual_currency, v_actual_rate,
        coalesce((v_line->>'recoverable_tax')::boolean, false),
        coalesce((v_line->>'include_in_costing')::boolean, true),
        nullif(trim(v_line->>'notes'), ''), coalesce(v_line->'metadata', '{}'::jsonb)
      ) returning id into v_line_id;
    else
      update public.foreign_trade_expense_reconciliation_lines
      set position = coalesce(nullif(trim(v_line->>'position'), '')::integer, 0),
          line_type = v_line_type, cost_category = v_category, concept = v_concept,
          provider_name = nullif(trim(v_line->>'provider_name'), ''),
          document_number = nullif(trim(v_line->>'document_number'), ''),
          document_date = nullif(trim(v_line->>'document_date'), '')::date,
          source_page = nullif(trim(v_line->>'source_page'), '')::integer,
          provision_cost_line_id = nullif(trim(v_line->>'provision_cost_line_id'), '')::uuid,
          provision_net_clp = coalesce(nullif(trim(v_line->>'provision_net_clp'), '')::numeric, 0),
          provision_vat_clp = coalesce(nullif(trim(v_line->>'provision_vat_clp'), '')::numeric, 0),
          provision_total_clp = v_provision_total,
          provision_amount_original = v_provision_amount,
          provision_currency = v_provision_currency,
          provision_exchange_rate_clp = v_provision_rate,
          actual_net_clp = coalesce(nullif(trim(v_line->>'actual_net_clp'), '')::numeric, 0),
          actual_vat_clp = coalesce(nullif(trim(v_line->>'actual_vat_clp'), '')::numeric, 0),
          actual_total_clp = v_actual_total,
          actual_amount_original = v_actual_amount,
          actual_currency = v_actual_currency,
          actual_exchange_rate_clp = v_actual_rate,
          recoverable_tax = coalesce((v_line->>'recoverable_tax')::boolean, false),
          include_in_costing = coalesce((v_line->>'include_in_costing')::boolean, true),
          notes = nullif(trim(v_line->>'notes'), ''),
          metadata = coalesce(v_line->'metadata', '{}'::jsonb)
      where id = v_line_id and reconciliation_id = v_id;
      if not found then raise exception 'foreign_trade_reconciliation_line_not_found'; end if;
    end if;
    v_kept_ids := array_append(v_kept_ids, v_line_id);
  end loop;

  if exists (
    select 1 from public.foreign_trade_expense_reconciliation_lines
    where reconciliation_id = v_id and not (id = any(v_kept_ids)) and applied_cost_line_id is not null
  ) then raise exception 'foreign_trade_cannot_remove_applied_reconciliation_line'; end if;

  delete from public.foreign_trade_expense_reconciliation_lines
  where reconciliation_id = v_id and not (id = any(v_kept_ids));

  return v_id;
end
$$;

create or replace function public.apply_foreign_trade_expense_reconciliation(p_reconciliation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reconciliation public.foreign_trade_expense_reconciliations%rowtype;
  v_line public.foreign_trade_expense_reconciliation_lines%rowtype;
  v_cost_id uuid;
  v_amount numeric(20,2);
  v_actual_total numeric(20,2);
  v_balance numeric(20,2);
  v_refund_due numeric(20,2);
  v_source_amount numeric(20,6);
  v_source_currency text;
  v_source_rate numeric(18,6);
  v_converted_total numeric(20,2);
  v_applied integer := 0;
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage')
     or not public.foreign_trade_has_permission('foreign_trade.approve') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;

  select * into v_reconciliation
  from public.foreign_trade_expense_reconciliations
  where id = p_reconciliation_id;
  if not found then raise exception 'foreign_trade_reconciliation_not_found'; end if;
  if v_reconciliation.provision_reference is not null and v_reconciliation.final_reference is not null
     and lower(v_reconciliation.provision_reference) <> lower(v_reconciliation.final_reference)
     and not v_reconciliation.identity_confirmed then
    raise exception 'foreign_trade_reconciliation_identity_mismatch';
  end if;

  if v_reconciliation.general_estimate_cost_line_id is not null then
    update public.foreign_trade_cost_lines
    set metadata = metadata || jsonb_build_object(
          'excluded_from_costing', true,
          'superseded_by_reconciliation_id', v_reconciliation.id
        ),
        updated_by = auth.uid()
    where id = v_reconciliation.general_estimate_cost_line_id
      and operation_id = v_reconciliation.operation_id;
  end if;

  -- Cada reaplicacion parte desactivando los registros generados por esta
  -- conciliacion. Las filas que sigan incluidas se reactivan mas abajo.
  update public.foreign_trade_cost_lines
  set metadata = metadata || jsonb_build_object('excluded_from_costing', true),
      updated_by = auth.uid()
  where operation_id = v_reconciliation.operation_id
    and metadata->>'reconciliation_id' = v_reconciliation.id::text;

  for v_line in
    select * from public.foreign_trade_expense_reconciliation_lines
    where reconciliation_id = p_reconciliation_id and include_in_costing and actual_total_clp > 0
    order by position, created_at
  loop
    v_amount := case
      when v_line.line_type in ('customs_duty','import_vat') then v_line.actual_total_clp
      when v_line.actual_net_clp > 0 then v_line.actual_net_clp
      else v_line.actual_total_clp
    end;
    v_source_amount := case when v_line.actual_amount_original > 0 then v_line.actual_amount_original else v_amount end;
    v_source_currency := case when v_line.actual_amount_original > 0 then v_line.actual_currency else 'CLP' end;
    v_source_rate := case when v_source_currency = 'CLP' then null else v_line.actual_exchange_rate_clp end;
    v_converted_total := case
      when v_line.actual_amount_original <= 0 then null
      when v_line.actual_currency = 'CLP' then round(v_line.actual_amount_original, 2)
      when v_line.actual_exchange_rate_clp > 0 then round(v_line.actual_amount_original * v_line.actual_exchange_rate_clp, 2)
      else null
    end;

    if v_line.line_type in ('customs_duty','import_vat') then
      update public.foreign_trade_cost_lines
      set metadata = metadata || jsonb_build_object(
            'excluded_from_costing', true,
            'superseded_by_reconciliation_id', v_reconciliation.id
          ),
          updated_by = auth.uid()
      where operation_id = v_reconciliation.operation_id
        and category = v_line.cost_category
        and source_type = 'estimated'
        and id <> coalesce(v_line.applied_cost_line_id, gen_random_uuid());
    end if;

    if v_line.applied_cost_line_id is null then
      insert into public.foreign_trade_cost_lines(
        operation_id, category, name, amount_original, currency, exchange_rate_clp, amount_clp,
        allocation_method, source_type, recoverable_tax, notes, metadata, created_by, updated_by
      ) values (
        v_reconciliation.operation_id, v_line.cost_category, v_line.concept,
        v_source_amount, v_source_currency, v_source_rate, v_amount,
        'fob_value', 'real', v_line.recoverable_tax,
        concat_ws(' · ', nullif(v_line.provider_name, ''), nullif(v_line.document_number, '')),
        jsonb_build_object(
          'amount_basis', case when v_line.line_type in ('customs_duty','import_vat') or v_line.actual_net_clp <= 0 then 'gross' else 'net' end,
          'vat_amount_clp', v_line.actual_vat_clp,
          'gross_amount_clp', v_line.actual_total_clp,
          'source_original_amount', v_line.actual_amount_original,
          'source_currency', v_line.actual_currency,
          'source_exchange_rate_clp', v_line.actual_exchange_rate_clp,
          'implied_exchange_rate_clp', case
            when v_line.actual_currency <> 'CLP' and v_line.actual_amount_original > 0 and v_line.actual_exchange_rate_clp is null
              then round(v_line.actual_total_clp / v_line.actual_amount_original, 6)
            else null
          end,
          'converted_gross_amount_clp', v_converted_total,
          'conversion_variance_clp', case when v_converted_total is null then null else v_line.actual_total_clp - v_converted_total end,
          'reconciliation_id', v_reconciliation.id,
          'reconciliation_line_id', v_line.id,
          'line_type', v_line.line_type,
          'document_number', v_line.document_number,
          'source_page', v_line.source_page,
          'excluded_from_costing', false
        ), auth.uid(), auth.uid()
      ) returning id into v_cost_id;
      update public.foreign_trade_expense_reconciliation_lines
      set applied_cost_line_id = v_cost_id where id = v_line.id;
    else
      v_cost_id := v_line.applied_cost_line_id;
      update public.foreign_trade_cost_lines
      set category = v_line.cost_category,
          name = v_line.concept,
          amount_original = v_source_amount,
          currency = v_source_currency, exchange_rate_clp = v_source_rate, amount_clp = v_amount,
          source_type = 'real', recoverable_tax = v_line.recoverable_tax,
          notes = concat_ws(' · ', nullif(v_line.provider_name, ''), nullif(v_line.document_number, '')),
          metadata = metadata || jsonb_build_object(
            'amount_basis', case when v_line.line_type in ('customs_duty','import_vat') or v_line.actual_net_clp <= 0 then 'gross' else 'net' end,
            'vat_amount_clp', v_line.actual_vat_clp,
            'gross_amount_clp', v_line.actual_total_clp,
            'source_original_amount', v_line.actual_amount_original,
            'source_currency', v_line.actual_currency,
            'source_exchange_rate_clp', v_line.actual_exchange_rate_clp,
            'implied_exchange_rate_clp', case
              when v_line.actual_currency <> 'CLP' and v_line.actual_amount_original > 0 and v_line.actual_exchange_rate_clp is null
                then round(v_line.actual_total_clp / v_line.actual_amount_original, 6)
              else null
            end,
            'converted_gross_amount_clp', v_converted_total,
            'conversion_variance_clp', case when v_converted_total is null then null else v_line.actual_total_clp - v_converted_total end,
            'reconciliation_id', v_reconciliation.id, 'reconciliation_line_id', v_line.id,
            'line_type', v_line.line_type, 'document_number', v_line.document_number,
            'source_page', v_line.source_page, 'excluded_from_costing', false
          ), updated_by = auth.uid()
      where id = v_cost_id and operation_id = v_reconciliation.operation_id;
    end if;
    v_applied := v_applied + 1;
  end loop;

  select coalesce(sum(actual_total_clp), 0) into v_actual_total
  from public.foreign_trade_expense_reconciliation_lines
  where reconciliation_id = p_reconciliation_id;
  v_balance := v_reconciliation.remittance_amount_clp - v_actual_total;
  v_refund_due := greatest(v_balance - v_reconciliation.refund_received_clp, 0);

  update public.foreign_trade_expense_reconciliations
  set status = case
        when v_refund_due > 0 then 'refund_pending'
        when v_balance > 0 and refund_received_clp >= v_balance then 'settled'
        else 'applied'
      end,
      applied_at = now(), applied_by = auth.uid(), updated_by = auth.uid()
  where id = p_reconciliation_id;

  return jsonb_build_object(
    'reconciliation_id', p_reconciliation_id,
    'applied_lines', v_applied,
    'actual_total_clp', v_actual_total,
    'balance_clp', v_balance,
    'refund_due_clp', v_refund_due
  );
end
$$;

-- Evita doble conteo en los totales de la ficha cuando una estimacion fue reemplazada.
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
        select coalesce(sum(coalesce(cif_total, fob_total, exw_total, quantity * unit_factory_cost, 0) - coalesce(discount_total, 0) + coalesce(supplier_charges_total, 0)), 0)
        from public.foreign_trade_operation_lines where operation_id = p_operation_id
      ),
      'total_cbm', (select coalesce(sum(cbm_total), 0) from public.foreign_trade_operation_lines where operation_id = p_operation_id),
      'gross_weight_kg', (select coalesce(sum(gross_weight_kg), 0) from public.foreign_trade_operation_lines where operation_id = p_operation_id),
      'costs_clp', (select coalesce(sum(amount_clp), 0) from public.foreign_trade_cost_lines where operation_id = p_operation_id and coalesce((metadata->>'excluded_from_costing')::boolean, false) = false),
      'costs_without_clp', (select count(*) from public.foreign_trade_cost_lines where operation_id = p_operation_id and amount_clp is null and coalesce((metadata->>'excluded_from_costing')::boolean, false) = false)
    )
  ) into v_result
  from public.import_shipments o
  left join public.suppliers s on s.id = o.supplier_id
  where o.id = p_operation_id;

  return v_result;
end
$$;

revoke all on function public.foreign_trade_expense_reconciliation_list(uuid) from public;
revoke all on function public.save_foreign_trade_expense_reconciliation(jsonb) from public;
revoke all on function public.apply_foreign_trade_expense_reconciliation(uuid) from public;
revoke all on function public.register_foreign_trade_document(jsonb) from public;
revoke all on function public.update_foreign_trade_document_type(uuid,text) from public;
revoke all on function public.cancel_foreign_trade_document_extraction(uuid) from public;
revoke all on function public.delete_foreign_trade_document(uuid) from public;
grant execute on function public.foreign_trade_expense_reconciliation_list(uuid) to authenticated, service_role;
grant execute on function public.save_foreign_trade_expense_reconciliation(jsonb) to authenticated, service_role;
grant execute on function public.apply_foreign_trade_expense_reconciliation(uuid) to authenticated, service_role;
grant execute on function public.register_foreign_trade_document(jsonb) to authenticated, service_role;
grant execute on function public.update_foreign_trade_document_type(uuid,text) to authenticated, service_role;
grant execute on function public.cancel_foreign_trade_document_extraction(uuid) to authenticated, service_role;
grant execute on function public.delete_foreign_trade_document(uuid) to authenticated, service_role;

grant select on public.foreign_trade_expense_reconciliations, public.foreign_trade_expense_reconciliation_lines to authenticated;
grant select, insert, update, delete on public.foreign_trade_expense_reconciliations, public.foreign_trade_expense_reconciliation_lines to service_role;

comment on table public.foreign_trade_expense_reconciliations is
  'Conciliacion privada entre fondos provisionados, rendicion final y devolucion de excedentes.';
comment on table public.foreign_trade_expense_reconciliation_lines is
  'Detalle auditable por concepto. Tributos y gastos operativos permanecen separados.';

commit;
