-- Centro de Comercio Exterior - Fase 12
-- Amplia documentos privados a 50 MB y mantiene la validacion en Storage y PostgreSQL.
-- Ejecutar despues de foreign_trade_center_phase10_product_reconciliation.sql.

begin;

alter table public.foreign_trade_documents
  drop constraint if exists foreign_trade_documents_file_size_check;
alter table public.foreign_trade_documents
  add constraint foreign_trade_documents_file_size_check
  check (file_size is null or (file_size > 0 and file_size <= 52428800));

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'foreign_trade_actual_orders'
      and column_name = 'file_size'
  ) then
    alter table public.foreign_trade_actual_orders
      drop constraint if exists foreign_trade_actual_orders_file_size_check;
    alter table public.foreign_trade_actual_orders
      add constraint foreign_trade_actual_orders_file_size_check
      check (file_size is null or (file_size > 0 and file_size <= 52428800));
  end if;
end
$$;

update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array[
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/csv'
    ]
where id = 'foreign-trade-orders';

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
  select supplier_id into v_operation_supplier_id from public.import_shipments where id = v_operation_id;
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
  if v_extension not in ('pdf','xls','xlsx','csv') then raise exception 'foreign_trade_invalid_document_type'; end if;
  if v_mime_type not in (
    'application/pdf','application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv','application/csv'
  ) then raise exception 'foreign_trade_invalid_document_mime'; end if;
  if v_file_size is null or v_file_size <= 0 or v_file_size > 52428800 then raise exception 'foreign_trade_invalid_document_size'; end if;
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

revoke all on function public.register_foreign_trade_document(jsonb) from public, anon;
grant execute on function public.register_foreign_trade_document(jsonb) to authenticated, service_role;

commit;
