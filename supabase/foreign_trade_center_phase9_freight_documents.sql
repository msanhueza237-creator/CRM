-- Centro de Comercio Exterior - Fase 9
-- Lectura y costeo auditable de facturas/cotizaciones de transporte.
-- Ejecutar despues de foreign_trade_center_phase8_automatic_reconciliation.sql.

begin;

create or replace function public.confirm_foreign_trade_freight_document(
  p_document_id uuid,
  p_review jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_document public.foreign_trade_documents%rowtype;
  v_operation public.import_shipments%rowtype;
  v_general jsonb;
  v_line jsonb;
  v_category text;
  v_concept text;
  v_currency text;
  v_original numeric(20,6);
  v_rate numeric(18,6);
  v_net numeric(20,2);
  v_vat numeric(20,2);
  v_total numeric(20,2);
  v_cost_amount numeric(20,2);
  v_source_amount numeric(20,6);
  v_source_currency text;
  v_source_rate numeric(18,6);
  v_document_number text;
  v_existing_cost_id uuid;
  v_inserted integer := 0;
  v_linked integer := 0;
  v_skipped integer := 0;
  v_total_cost numeric(20,2) := 0;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage')
     or not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_review, '{}'::jsonb)) <> 'object'
     or p_review->>'document_kind' <> 'freight_document'
     or jsonb_typeof(p_review->'general') <> 'object'
     or jsonb_typeof(p_review->'lines') <> 'array' then
    raise exception 'foreign_trade_invalid_freight_review';
  end if;
  if jsonb_array_length(p_review->'lines') > 100 then
    raise exception 'foreign_trade_too_many_document_lines';
  end if;

  select * into v_document
  from public.foreign_trade_documents
  where id = p_document_id
  for update;
  if not found then raise exception 'foreign_trade_document_not_found'; end if;
  if v_document.document_type <> 'freight_quote' then
    raise exception 'foreign_trade_document_not_freight';
  end if;
  if v_document.parse_status <> 'review_required' then
    raise exception 'foreign_trade_document_not_ready';
  end if;

  select * into v_operation
  from public.import_shipments
  where id = v_document.operation_id
  for update;
  if not found then raise exception 'foreign_trade_operation_not_found'; end if;

  v_general := p_review->'general';
  v_document_number := nullif(trim(v_general->>'document_number'), '');

  for v_line in select value from jsonb_array_elements(p_review->'lines')
  loop
    if coalesce((v_line->>'include')::boolean, true) is false
       or coalesce((v_line->>'include_in_costing')::boolean, true) is false then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_category := coalesce(nullif(trim(v_line->>'cost_category'), ''), 'international_freight');
    v_concept := trim(coalesce(v_line->>'concept', ''));
    v_currency := upper(coalesce(nullif(trim(v_line->>'currency'), ''), 'CLP'));
    v_original := coalesce(nullif(trim(v_line->>'amount_original'), '')::numeric, 0);
    v_rate := case when v_currency = 'CLP' then 1 else nullif(trim(v_line->>'exchange_rate_clp'), '')::numeric end;
    v_net := coalesce(nullif(trim(v_line->>'net_clp'), '')::numeric, 0);
    v_vat := coalesce(nullif(trim(v_line->>'vat_clp'), '')::numeric, 0);
    v_total := coalesce(
      nullif(trim(v_line->>'total_clp'), '')::numeric,
      nullif(v_net + v_vat, 0),
      case when v_original > 0 and v_rate > 0 then round(v_original * v_rate, 2) end,
      0
    );
    v_cost_amount := case
      when coalesce((v_line->>'recoverable_tax')::boolean, false) and v_net > 0 then v_net
      else v_total
    end;

    if v_category not in (
      'origin','international_freight','insurance','chile_port','storage','customs_agency',
      'national_transport','inspection','certificate','supplier_charge','other'
    ) then raise exception 'foreign_trade_invalid_cost_category'; end if;
    if length(v_concept) not between 2 and 180 then raise exception 'foreign_trade_invalid_cost_name'; end if;
    if v_currency !~ '^[A-Z]{3}$' then raise exception 'foreign_trade_invalid_currency'; end if;
    if least(v_original, coalesce(v_rate, 0), v_net, v_vat, v_total, v_cost_amount) < 0
       or v_cost_amount = 0 then raise exception 'foreign_trade_invalid_cost_values'; end if;

    -- Conserva la moneda original cuando su conversión coincide con la base
    -- económica. Si el documento solo trae CLP, utiliza CLP sin inventar TC.
    if v_currency <> 'CLP' and v_original > 0 then
      v_source_rate := coalesce(v_rate, round(v_cost_amount / v_original, 6));
      v_source_amount := v_original;
      v_source_currency := v_currency;
    else
      v_source_rate := null;
      v_source_amount := v_cost_amount;
      v_source_currency := 'CLP';
    end if;

    v_existing_cost_id := null;
    select id into v_existing_cost_id
    from public.foreign_trade_cost_lines
    where operation_id = v_document.operation_id
      and category = v_category
      and source_type = 'real'
      and coalesce((metadata->>'excluded_from_costing')::boolean, false) is false
      and abs(coalesce(amount_clp, -1) - v_cost_amount) <= 1
      and (
        (coalesce(nullif(trim(v_line->>'document_number'), ''), v_document_number) is not null
          and metadata->>'document_number' = coalesce(nullif(trim(v_line->>'document_number'), ''), v_document_number))
        or regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(v_concept), '[^a-z0-9]', '', 'g')
      )
    order by updated_at desc
    limit 1;

    if v_existing_cost_id is not null then
      update public.foreign_trade_cost_lines
      set metadata = metadata || jsonb_build_object(
            'freight_supporting_document_id', v_document.id,
            'freight_extraction_version', p_review->>'extraction_version'
          ),
          updated_by = auth.uid()
      where id = v_existing_cost_id;
      v_linked := v_linked + 1;
    else
      insert into public.foreign_trade_cost_lines(
        operation_id, category, name, amount_original, currency, exchange_rate_clp, amount_clp,
        allocation_method, source_type, recoverable_tax, notes, metadata, created_by, updated_by
      ) values (
        v_document.operation_id, v_category, v_concept,
        v_source_amount, v_source_currency, v_source_rate, v_cost_amount,
        case when v_category = 'international_freight' then 'cbm' else 'fob_value' end,
        'real', coalesce((v_line->>'recoverable_tax')::boolean, false),
        concat_ws(' · ', nullif(trim(v_line->>'provider_name'), ''), coalesce(nullif(trim(v_line->>'document_number'), ''), v_document_number)),
        jsonb_build_object(
          'amount_basis', case when coalesce((v_line->>'recoverable_tax')::boolean, false) and v_net > 0 then 'net' else 'gross' end,
          'vat_amount_clp', v_vat,
          'gross_amount_clp', v_total,
          'source_original_amount', v_original,
          'source_currency', v_currency,
          'source_exchange_rate_clp', v_rate,
          'source_document_id', v_document.id,
          'source_document_type', 'freight_quote',
          'source_index', nullif(trim(v_line->>'source_index'), '')::integer,
          'source_page', nullif(trim(v_line->>'source_page'), '')::integer,
          'document_number', coalesce(nullif(trim(v_line->>'document_number'), ''), v_document_number),
          'bill_of_lading', nullif(trim(v_general->>'bill_of_lading'), ''),
          'route_origin', nullif(trim(v_general->>'origin_port'), ''),
          'route_destination', nullif(trim(v_general->>'destination_port'), ''),
          'confidence', nullif(trim(v_line->>'confidence'), '')::numeric,
          'extraction_version', p_review->>'extraction_version',
          'excluded_from_costing', false
        ), auth.uid(), auth.uid()
      );
      v_inserted := v_inserted + 1;
    end if;
    v_total_cost := v_total_cost + v_cost_amount;
  end loop;

  if v_inserted + v_linked = 0 then raise exception 'foreign_trade_freight_without_costs'; end if;

  update public.import_shipments
  set origin_port = coalesce(nullif(trim(v_general->>'origin_port'), ''), origin_port),
      destination_port = coalesce(nullif(trim(v_general->>'destination_port'), ''), destination_port),
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
        'freight_document_id', v_document.id,
        'freight_document_number', v_document_number,
        'freight_bill_of_lading', nullif(trim(v_general->>'bill_of_lading'), ''),
        'freight_carrier', nullif(trim(v_general->>'carrier_name'), ''),
        'freight_reference', nullif(trim(v_general->>'reference'), '')
      )),
      updated_by = auth.uid()
  where id = v_document.operation_id;

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
    'inserted_costs', v_inserted,
    'linked_existing_costs', v_linked,
    'skipped_lines', v_skipped,
    'total_cost_clp', v_total_cost,
    'status', 'confirmed'
  );
end
$$;

revoke all on function public.confirm_foreign_trade_freight_document(uuid,jsonb) from public;
grant execute on function public.confirm_foreign_trade_freight_document(uuid,jsonb) to authenticated, service_role;

comment on function public.confirm_foreign_trade_freight_document(uuid,jsonb) is
  'Confirma una factura/cotizacion de transporte revisada y crea costos logisticos reales, evitando duplicados por documento, categoria y monto.';

commit;
