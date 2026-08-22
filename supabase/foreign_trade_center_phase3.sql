-- Centro de Comercio Exterior - Fase 3
-- Documentos privados, extraccion asistida y revision humana obligatoria.
-- Ejecutar despues de foreign_trade_center_phase2.sql.

begin;

alter table public.foreign_trade_documents
  add column if not exists extraction_model text,
  add column if not exists extraction_request_id text,
  add column if not exists extraction_started_at timestamptz,
  add column if not exists extraction_completed_at timestamptz,
  add column if not exists extraction_error text,
  add column if not exists review_result jsonb not null default '{}'::jsonb,
  add column if not exists review_version integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'foreign_trade_documents_review_result_object'
  ) then
    alter table public.foreign_trade_documents
      add constraint foreign_trade_documents_review_result_object
      check (jsonb_typeof(review_result) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'foreign_trade_documents_review_version_positive'
  ) then
    alter table public.foreign_trade_documents
      add constraint foreign_trade_documents_review_version_positive
      check (review_version > 0);
  end if;
end
$$;

alter table public.foreign_trade_operation_lines
  add column if not exists source_document_id uuid,
  add column if not exists source_line_index integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'foreign_trade_lines_source_document_fk'
  ) then
    alter table public.foreign_trade_operation_lines
      add constraint foreign_trade_lines_source_document_fk
      foreign key (source_document_id) references public.foreign_trade_documents(id) on delete set null;
  end if;
end
$$;

create unique index if not exists foreign_trade_lines_document_line_idx
  on public.foreign_trade_operation_lines(source_document_id, source_line_index)
  where source_document_id is not null and source_line_index is not null;

create index if not exists foreign_trade_documents_parse_status_idx
  on public.foreign_trade_documents(parse_status, created_at desc);

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

  if length(v_file_name) < 3 or length(v_file_name) > 240 then
    raise exception 'foreign_trade_invalid_document_name';
  end if;
  v_extension := lower(regexp_replace(v_file_name, '^.*\.', ''));
  if v_extension not in ('pdf', 'xls', 'xlsx') then
    raise exception 'foreign_trade_invalid_document_type';
  end if;
  if v_mime_type not in (
    'application/pdf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception 'foreign_trade_invalid_document_mime';
  end if;
  if v_file_size is null or v_file_size <= 0 or v_file_size > 26214400 then
    raise exception 'foreign_trade_invalid_document_size';
  end if;
  if v_storage_path = '' or position(v_operation_id::text || '/' in v_storage_path) <> 1 then
    raise exception 'foreign_trade_invalid_storage_path';
  end if;
  if v_file_hash is not null and v_file_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'foreign_trade_invalid_file_hash';
  end if;
  if v_document_type not in (
    'proforma','purchase_order','commercial_invoice','packing_list','bill_of_lading',
    'certificate_of_origin','customs_document','payment_receipt','freight_quote','other'
  ) then
    raise exception 'foreign_trade_invalid_document_type';
  end if;

  insert into public.foreign_trade_documents(
    id, operation_id, supplier_id, document_type, original_file_name,
    storage_bucket, storage_path, mime_type, file_size, file_hash,
    parse_status, uploaded_by
  ) values (
    v_id, v_operation_id, v_supplier_id, v_document_type, v_file_name,
    'foreign-trade-orders', v_storage_path, v_mime_type, v_file_size, v_file_hash,
    'queued', auth.uid()
  );

  return v_id;
end;
$$;

create or replace function public.foreign_trade_document_list(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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

  select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select id, operation_id, supplier_id, document_type, original_file_name,
      storage_bucket, storage_path, mime_type, file_size, file_hash, parse_status,
      extraction_result, extraction_confidence, review_warnings, review_result,
      review_version, extraction_model, extraction_request_id, extraction_started_at,
      extraction_completed_at, extraction_error, confirmed_at, confirmed_by,
      uploaded_by, created_at, updated_at
    from public.foreign_trade_documents
    where operation_id = p_operation_id
  ) d;
  return v_result;
end;
$$;

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

  update public.foreign_trade_documents
  set parse_status = p_status,
      extraction_result = case when p_status = 'review_required' then p_payload else extraction_result end,
      extraction_confidence = case when p_status = 'review_required' then p_confidence else extraction_confidence end,
      review_warnings = case when p_status = 'review_required' then p_warnings else review_warnings end,
      extraction_model = coalesce(p_model, extraction_model),
      extraction_request_id = coalesce(p_request_id, extraction_request_id),
      extraction_started_at = case when p_status = 'extracting' then now() else extraction_started_at end,
      extraction_completed_at = case when p_status in ('review_required', 'failed') then now() else null end,
      extraction_error = case when p_status = 'failed' then left(coalesce(p_error, 'Error de extraccion'), 2000) else null end
  where id = p_document_id
    and parse_status <> 'confirmed';

  if not found then raise exception 'foreign_trade_document_not_found_or_confirmed'; end if;
end;
$$;

create or replace function public.confirm_foreign_trade_document(p_document_id uuid, p_review jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_document public.foreign_trade_documents%rowtype;
  v_general jsonb;
  v_line jsonb;
  v_operation_supplier_id uuid;
  v_supplier_id uuid;
  v_content_product_id uuid;
  v_supplier_product_id uuid;
  v_line_number integer;
  v_source_index integer;
  v_product_name text;
  v_currency text;
  v_production_days integer;
  v_quantity numeric(18,6);
  v_unit_cost numeric(20,6);
  v_quantity_per_box numeric(18,6);
  v_box_count numeric(18,6);
  v_length numeric(18,6);
  v_width numeric(18,6);
  v_height numeric(18,6);
  v_cbm_per_box numeric(18,6);
  v_cbm_total numeric(18,6);
  v_confidence numeric(7,6);
  v_warnings jsonb;
  v_missing text[];
  v_inserted integer := 0;
  v_skipped integer := 0;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage')
     or not public.foreign_trade_has_permission('foreign_trade.operations.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_review, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(p_review->'general') <> 'object'
     or jsonb_typeof(p_review->'lines') <> 'array' then
    raise exception 'foreign_trade_invalid_review';
  end if;
  if jsonb_array_length(p_review->'lines') > 500 then
    raise exception 'foreign_trade_too_many_document_lines';
  end if;

  select * into v_document
  from public.foreign_trade_documents
  where id = p_document_id
  for update;
  if not found then raise exception 'foreign_trade_document_not_found'; end if;
  if v_document.operation_id is null then raise exception 'foreign_trade_document_without_operation'; end if;
  if v_document.parse_status <> 'review_required' then
    raise exception 'foreign_trade_document_not_ready';
  end if;

  v_general := p_review->'general';
  select supplier_id into v_operation_supplier_id
  from public.import_shipments where id = v_document.operation_id for update;
  if not found then raise exception 'foreign_trade_operation_not_found'; end if;

  v_supplier_id := coalesce(
    nullif(trim(v_general->>'supplier_id'), '')::uuid,
    v_document.supplier_id,
    v_operation_supplier_id
  );
  if v_supplier_id is not null and not exists (select 1 from public.suppliers where id = v_supplier_id) then
    raise exception 'foreign_trade_supplier_not_found';
  end if;

  v_currency := upper(coalesce(nullif(trim(v_general->>'currency'), ''), 'USD'));
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'foreign_trade_invalid_currency'; end if;
  v_production_days := nullif(trim(v_general->>'production_days'), '')::integer;
  if v_production_days is not null and (v_production_days < 0 or v_production_days > 730) then
    raise exception 'foreign_trade_invalid_production_days';
  end if;

  update public.import_shipments
  set supplier_id = coalesce(v_supplier_id, supplier_id),
      supplier_proforma_number = coalesce(nullif(trim(v_general->>'proforma_number'), ''), supplier_proforma_number),
      order_date = coalesce(nullif(trim(v_general->>'document_date'), '')::date, order_date),
      valid_until = coalesce(nullif(trim(v_general->>'valid_until'), '')::date, valid_until),
      base_currency = v_currency,
      incoterm = coalesce(nullif(upper(trim(v_general->>'incoterm')), ''), incoterm),
      origin_port = coalesce(nullif(trim(v_general->>'origin_port'), ''), origin_port),
      destination_port = coalesce(nullif(trim(v_general->>'destination_port'), ''), destination_port),
      payment_terms = coalesce(nullif(trim(v_general->>'payment_terms'), ''), payment_terms),
      production_days = coalesce(v_production_days, production_days),
      notes = case
        when nullif(trim(v_general->>'observations'), '') is null then notes
        when notes is null or trim(notes) = '' then trim(v_general->>'observations')
        else notes || E'\n\nDocumento confirmado: ' || trim(v_general->>'observations')
      end,
      operation_type = case when operation_type in ('simulation','quotation','proforma') then 'proforma' else operation_type end,
      status = case when status = 'quotation' then 'proforma_received' else status end,
      source_label = 'document',
      updated_by = auth.uid()
  where id = v_document.operation_id;

  update public.foreign_trade_documents
  set supplier_id = coalesce(v_supplier_id, supplier_id)
  where id = p_document_id;

  select coalesce(max(line_number), 0) into v_line_number
  from public.foreign_trade_operation_lines
  where operation_id = v_document.operation_id;

  for v_line in select value from jsonb_array_elements(p_review->'lines') loop
    if coalesce((v_line->>'include')::boolean, true) is false then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_source_index := coalesce(nullif(trim(v_line->>'source_index'), '')::integer, v_inserted + v_skipped + 1);
    if exists (
      select 1 from public.foreign_trade_operation_lines
      where source_document_id = p_document_id and source_line_index = v_source_index
    ) then
      raise exception 'foreign_trade_document_line_already_imported';
    end if;

    v_product_name := trim(coalesce(v_line->>'product_name', v_line->>'description', ''));
    if length(v_product_name) < 2 or length(v_product_name) > 240 then
      raise exception 'foreign_trade_invalid_product_name';
    end if;
    v_currency := upper(coalesce(nullif(trim(v_line->>'currency'), ''), nullif(trim(v_general->>'currency'), ''), 'USD'));
    if v_currency !~ '^[A-Z]{3}$' then raise exception 'foreign_trade_invalid_currency'; end if;

    v_quantity := coalesce(nullif(trim(v_line->>'quantity'), '')::numeric, 0);
    v_unit_cost := nullif(trim(v_line->>'unit_price'), '')::numeric;
    v_quantity_per_box := nullif(trim(v_line->>'quantity_per_box'), '')::numeric;
    v_box_count := nullif(trim(v_line->>'box_count'), '')::numeric;
    v_length := nullif(trim(v_line->>'box_length_cm'), '')::numeric;
    v_width := nullif(trim(v_line->>'box_width_cm'), '')::numeric;
    v_height := nullif(trim(v_line->>'box_height_cm'), '')::numeric;
    v_cbm_per_box := nullif(trim(v_line->>'cbm_per_box'), '')::numeric;
    v_cbm_total := nullif(trim(v_line->>'cbm_total'), '')::numeric;
    v_confidence := nullif(trim(v_line->>'confidence'), '')::numeric;
    if v_quantity < 0 or coalesce(v_unit_cost, 0) < 0 or coalesce(v_quantity_per_box, 0) < 0
       or coalesce(v_box_count, 0) < 0 or coalesce(v_cbm_per_box, 0) < 0 or coalesce(v_cbm_total, 0) < 0
       or coalesce(v_confidence, 0) < 0 or coalesce(v_confidence, 0) > 1 then
      raise exception 'foreign_trade_invalid_line_values';
    end if;
    if v_cbm_per_box is null and v_length is not null and v_width is not null and v_height is not null then
      v_cbm_per_box := round((v_length * v_width * v_height) / 1000000, 6);
    end if;
    if v_cbm_total is null and v_cbm_per_box is not null and v_box_count is not null then
      v_cbm_total := round(v_cbm_per_box * v_box_count, 6);
    end if;

    v_content_product_id := nullif(trim(v_line->>'content_product_id'), '')::uuid;
    v_supplier_product_id := null;
    if v_content_product_id is not null and not exists (
      select 1 from public.content_products where id = v_content_product_id
    ) then
      raise exception 'foreign_trade_product_not_found';
    end if;
    if v_content_product_id is null and v_supplier_id is not null and nullif(trim(v_line->>'supplier_sku'), '') is not null then
      select sp.id, sp.content_product_id
      into v_supplier_product_id, v_content_product_id
      from public.supplier_products sp
      where sp.supplier_id = v_supplier_id
        and lower(coalesce(sp.supplier_sku, '')) = lower(trim(v_line->>'supplier_sku'))
      order by sp.updated_at desc
      limit 1;
    end if;
    if v_content_product_id is not null and v_supplier_id is not null
       and coalesce((v_line->>'remember_link')::boolean, false)
       and nullif(trim(v_line->>'sku'), '') is not null then
      insert into public.supplier_products(
        supplier_id, sku, supplier_sku, content_product_id, currency,
        supplier_model, supplier_description, source, metadata
      ) values (
        v_supplier_id, trim(v_line->>'sku'), nullif(trim(v_line->>'supplier_sku'), ''),
        v_content_product_id, v_currency, nullif(trim(v_line->>'model'), ''),
        nullif(trim(v_line->>'description'), ''), 'document',
        jsonb_build_object('source_document_id', p_document_id)
      )
      on conflict (supplier_id, sku) do update set
        supplier_sku = excluded.supplier_sku,
        content_product_id = excluded.content_product_id,
        currency = excluded.currency,
        supplier_model = excluded.supplier_model,
        supplier_description = excluded.supplier_description,
        source = 'document',
        metadata = public.supplier_products.metadata || excluded.metadata,
        updated_at = now()
      returning id into v_supplier_product_id;
    end if;

    v_warnings := case when jsonb_typeof(v_line->'warnings') = 'array' then v_line->'warnings' else '[]'::jsonb end;
    v_missing := array_remove(array[
      case when nullif(trim(v_line->>'sku'), '') is null and nullif(trim(v_line->>'supplier_sku'), '') is null then 'sku' end,
      case when v_quantity = 0 then 'quantity' end,
      case when v_unit_cost is null then 'unit_price' end,
      case when v_cbm_total is null then 'cbm_total' end
    ], null);
    v_line_number := v_line_number + 1;

    insert into public.foreign_trade_operation_lines(
      operation_id, supplier_product_id, content_product_id, line_number,
      sku, supplier_sku, product_name, supplier_model, description,
      temporary_product, linked_manually, quantity, quantity_per_box, box_count,
      currency, unit_factory_cost, exw_total, fob_total, cif_total,
      discount_total, supplier_charges_total, unit_weight_kg, gross_weight_kg,
      net_weight_kg, box_length_cm, box_width_cm, box_height_cm, cbm_per_box,
      cbm_total, hs_code, country_of_origin, data_source, extraction_confidence,
      source_snapshot, missing_fields, warnings, source_document_id, source_line_index,
      created_by, updated_by
    ) values (
      v_document.operation_id, v_supplier_product_id, v_content_product_id, v_line_number,
      nullif(trim(v_line->>'sku'), ''), nullif(trim(v_line->>'supplier_sku'), ''),
      v_product_name, nullif(trim(v_line->>'model'), ''), nullif(trim(v_line->>'description'), ''),
      v_content_product_id is null, coalesce((v_line->>'remember_link')::boolean, false),
      v_quantity, v_quantity_per_box, v_box_count, v_currency, v_unit_cost,
      nullif(trim(v_line->>'exw_total'), '')::numeric,
      nullif(trim(v_line->>'fob_total'), '')::numeric,
      nullif(trim(v_line->>'cif_total'), '')::numeric,
      coalesce(nullif(trim(v_line->>'discount_total'), '')::numeric, 0),
      coalesce(nullif(trim(v_line->>'supplier_charges_total'), '')::numeric, 0),
      nullif(trim(v_line->>'unit_weight_kg'), '')::numeric,
      nullif(trim(v_line->>'gross_weight_kg'), '')::numeric,
      nullif(trim(v_line->>'net_weight_kg'), '')::numeric,
      v_length, v_width, v_height, v_cbm_per_box, v_cbm_total,
      nullif(trim(v_line->>'hs_code'), ''), nullif(upper(trim(v_line->>'country_of_origin')), ''),
      'document', v_confidence, v_line, v_missing, v_warnings,
      p_document_id, v_source_index, auth.uid(), auth.uid()
    );
    v_inserted := v_inserted + 1;
  end loop;

  update public.foreign_trade_documents
  set parse_status = 'confirmed',
      review_result = p_review,
      confirmed_at = now(),
      confirmed_by = auth.uid(),
      extraction_error = null
  where id = p_document_id;

  return jsonb_build_object(
    'document_id', p_document_id,
    'operation_id', v_document.operation_id,
    'inserted_lines', v_inserted,
    'skipped_lines', v_skipped,
    'status', 'confirmed'
  );
end;
$$;

create or replace function public.foreign_trade_write_document_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.foreign_trade_documents%rowtype := case when tg_op = 'DELETE' then old else new end;
  v_old_summary jsonb := '{}'::jsonb;
  v_new_summary jsonb := '{}'::jsonb;
begin
  if tg_op <> 'INSERT' then
    v_old_summary := jsonb_build_object(
      'document_type', old.document_type,
      'original_file_name', old.original_file_name,
      'file_size', old.file_size,
      'file_hash', old.file_hash,
      'parse_status', old.parse_status,
      'extraction_confidence', old.extraction_confidence,
      'warning_count', jsonb_array_length(old.review_warnings),
      'extracted_line_count', case when jsonb_typeof(old.extraction_result->'lines') = 'array' then jsonb_array_length(old.extraction_result->'lines') else 0 end,
      'confirmed_at', old.confirmed_at
    );
  end if;
  if tg_op <> 'DELETE' then
    v_new_summary := jsonb_build_object(
      'document_type', new.document_type,
      'original_file_name', new.original_file_name,
      'file_size', new.file_size,
      'file_hash', new.file_hash,
      'parse_status', new.parse_status,
      'extraction_confidence', new.extraction_confidence,
      'warning_count', jsonb_array_length(new.review_warnings),
      'extracted_line_count', case when jsonb_typeof(new.extraction_result->'lines') = 'array' then jsonb_array_length(new.extraction_result->'lines') else 0 end,
      'confirmed_at', new.confirmed_at
    );
  end if;

  insert into public.foreign_trade_audit_log(
    operation_id, entity_type, record_id, action,
    old_values, new_values, origin, actor_id, agent_type
  ) values (
    case when exists (select 1 from public.import_shipments where id = v_row.operation_id) then v_row.operation_id else null end,
    tg_table_name, v_row.id, lower(tg_op),
    v_old_summary, v_new_summary, 'crm', auth.uid(), null
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists audit_foreign_trade_documents on public.foreign_trade_documents;
create trigger audit_foreign_trade_documents
after insert or update or delete on public.foreign_trade_documents
for each row execute function public.foreign_trade_write_document_audit();

revoke all on function public.register_foreign_trade_document(jsonb) from public;
revoke all on function public.foreign_trade_document_list(uuid) from public;
revoke all on function public.set_foreign_trade_document_extraction(uuid,text,jsonb,numeric,jsonb,text,text,text) from public;
revoke all on function public.confirm_foreign_trade_document(uuid,jsonb) from public;

grant execute on function public.register_foreign_trade_document(jsonb) to authenticated, service_role;
grant execute on function public.foreign_trade_document_list(uuid) to authenticated, service_role;
grant execute on function public.set_foreign_trade_document_extraction(uuid,text,jsonb,numeric,jsonb,text,text,text) to service_role;
grant execute on function public.confirm_foreign_trade_document(uuid,jsonb) to authenticated, service_role;

comment on function public.confirm_foreign_trade_document(uuid,jsonb) is
  'Confirma una revision humana y solo entonces materializa los datos del documento en la operacion.';

commit;
