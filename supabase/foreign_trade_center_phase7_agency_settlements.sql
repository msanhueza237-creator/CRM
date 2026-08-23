-- Centro de Comercio Exterior - Fase 7
-- Extraccion y confirmacion atomica de rendiciones finales de agencia.
-- Ejecutar despues de foreign_trade_center_phase6_fund_requests.sql.

begin;

create or replace function public.confirm_foreign_trade_agency_settlement_document(
  p_document_id uuid,
  p_reconciliation_id uuid,
  p_review jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_document public.foreign_trade_documents%rowtype;
  v_reconciliation public.foreign_trade_expense_reconciliations%rowtype;
  v_general jsonb;
  v_line jsonb;
  v_line_id uuid;
  v_seen_line_ids uuid[] := array[]::uuid[];
  v_final_reference text;
  v_identity_confirmed boolean;
  v_line_type text;
  v_category text;
  v_concept text;
  v_currency text;
  v_original numeric(20,6);
  v_rate numeric(18,6);
  v_net numeric(20,2);
  v_vat numeric(20,2);
  v_total numeric(20,2);
  v_next_position integer;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage')
     or not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_review, '{}'::jsonb)) <> 'object'
     or p_review->>'document_kind' <> 'agency_settlement'
     or jsonb_typeof(p_review->'general') <> 'object'
     or jsonb_typeof(p_review->'lines') <> 'array' then
    raise exception 'foreign_trade_invalid_agency_settlement_review';
  end if;
  if jsonb_array_length(p_review->'lines') > 300 then
    raise exception 'foreign_trade_too_many_document_lines';
  end if;

  select * into v_document
  from public.foreign_trade_documents
  where id = p_document_id
  for update;
  if not found then raise exception 'foreign_trade_document_not_found'; end if;
  if v_document.document_type <> 'agency_settlement' then
    raise exception 'foreign_trade_document_not_agency_settlement';
  end if;
  if v_document.parse_status <> 'review_required' then
    raise exception 'foreign_trade_document_not_ready';
  end if;

  select * into v_reconciliation
  from public.foreign_trade_expense_reconciliations
  where id = p_reconciliation_id
    and operation_id = v_document.operation_id
  for update;
  if not found then raise exception 'foreign_trade_reconciliation_not_found'; end if;
  if v_reconciliation.status in ('applied', 'settled') then
    raise exception 'foreign_trade_reconciliation_already_applied';
  end if;
  if v_reconciliation.final_document_id is not null
     and v_reconciliation.final_document_id <> v_document.id then
    raise exception 'foreign_trade_reconciliation_has_final_document';
  end if;

  v_general := p_review->'general';
  v_final_reference := nullif(trim(v_general->>'reference'), '');
  v_identity_confirmed := coalesce(nullif(trim(p_review->>'identity_confirmed'), '')::boolean, false);
  if v_reconciliation.provision_reference is not null
     and v_final_reference is not null
     and regexp_replace(lower(v_reconciliation.provision_reference), '[^a-z0-9]', '', 'g')
       <> regexp_replace(lower(v_final_reference), '[^a-z0-9]', '', 'g')
     and not v_identity_confirmed then
    raise exception 'foreign_trade_reconciliation_identity_mismatch';
  end if;

  select coalesce(max(position), -1) + 1 into v_next_position
  from public.foreign_trade_expense_reconciliation_lines
  where reconciliation_id = p_reconciliation_id;

  for v_line in select value from jsonb_array_elements(p_review->'lines')
  loop
    if coalesce((v_line->>'include')::boolean, true) is false then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_line_id := nullif(trim(v_line->>'reconciliation_line_id'), '')::uuid;
    if v_line_id is not null and v_line_id = any(v_seen_line_ids) then
      raise exception 'foreign_trade_duplicate_reconciliation_line_match';
    end if;
    if v_line_id is not null then v_seen_line_ids := array_append(v_seen_line_ids, v_line_id); end if;

    v_line_type := coalesce(nullif(trim(v_line->>'line_type'), ''), 'operating_expense');
    v_category := coalesce(nullif(trim(v_line->>'cost_category'), ''), 'other');
    v_concept := trim(coalesce(v_line->>'concept', ''));
    v_currency := upper(coalesce(nullif(trim(v_line->>'currency'), ''), 'CLP'));
    v_original := coalesce(nullif(trim(v_line->>'amount_original'), '')::numeric, 0);
    v_rate := case when v_currency = 'CLP' then 1 else nullif(trim(v_line->>'exchange_rate_clp'), '')::numeric end;
    v_net := coalesce(nullif(trim(v_line->>'actual_net_clp'), '')::numeric, 0);
    v_vat := coalesce(nullif(trim(v_line->>'actual_vat_clp'), '')::numeric, 0);
    v_total := coalesce(
      nullif(trim(v_line->>'actual_total_clp'), '')::numeric,
      nullif(v_net + v_vat, 0),
      case when v_original > 0 and v_rate > 0 then round(v_original * v_rate, 2) end,
      0
    );

    if v_line_type not in ('operating_expense','agency_fee','customs_duty','import_vat','adjustment') then
      raise exception 'foreign_trade_invalid_reconciliation_line_type';
    end if;
    if v_category not in ('origin','international_freight','insurance','chile_port','storage','customs_agency','national_transport','inspection','certificate','duties','taxes','supplier_charge','other') then
      raise exception 'foreign_trade_invalid_cost_category';
    end if;
    if length(v_concept) not between 2 and 180 then
      raise exception 'foreign_trade_invalid_reconciliation_concept';
    end if;
    if v_currency !~ '^[A-Z]{3}$' then raise exception 'foreign_trade_invalid_reconciliation_currency'; end if;
    if least(v_original, coalesce(v_rate, 0), v_net, v_vat, v_total) < 0 then
      raise exception 'foreign_trade_invalid_reconciliation_amount';
    end if;

    if v_line_id is not null then
      update public.foreign_trade_expense_reconciliation_lines
      set line_type = v_line_type,
          cost_category = v_category,
          concept = v_concept,
          provider_name = nullif(trim(v_line->>'provider_name'), ''),
          document_number = nullif(trim(v_line->>'document_number'), ''),
          document_date = nullif(trim(v_line->>'document_date'), '')::date,
          source_page = nullif(trim(v_line->>'source_page'), '')::integer,
          actual_net_clp = v_net,
          actual_vat_clp = v_vat,
          actual_total_clp = v_total,
          actual_amount_original = case when v_original > 0 then v_original when v_currency = 'CLP' then v_total else 0 end,
          actual_currency = v_currency,
          actual_exchange_rate_clp = v_rate,
          recoverable_tax = coalesce((v_line->>'recoverable_tax')::boolean, false),
          include_in_costing = coalesce((v_line->>'include_in_costing')::boolean, true),
          metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'actual_source_document_id', v_document.id,
            'actual_source_index', nullif(trim(v_line->>'source_index'), '')::integer,
            'actual_confidence', nullif(trim(v_line->>'confidence'), '')::numeric
          )
      where id = v_line_id
        and reconciliation_id = p_reconciliation_id;
      if not found then raise exception 'foreign_trade_reconciliation_line_not_found'; end if;
      v_updated := v_updated + 1;
    else
      insert into public.foreign_trade_expense_reconciliation_lines(
        reconciliation_id, operation_id, position, line_type, cost_category, concept,
        provider_name, document_number, document_date, source_page,
        provision_net_clp, provision_vat_clp, provision_total_clp,
        provision_amount_original, provision_currency, provision_exchange_rate_clp,
        actual_net_clp, actual_vat_clp, actual_total_clp,
        actual_amount_original, actual_currency, actual_exchange_rate_clp,
        recoverable_tax, include_in_costing, notes, metadata
      ) values (
        p_reconciliation_id, v_document.operation_id, v_next_position + v_inserted,
        v_line_type, v_category, v_concept,
        nullif(trim(v_line->>'provider_name'), ''),
        nullif(trim(v_line->>'document_number'), ''),
        nullif(trim(v_line->>'document_date'), '')::date,
        nullif(trim(v_line->>'source_page'), '')::integer,
        0, 0, 0, 0, 'CLP', 1,
        v_net, v_vat, v_total,
        case when v_original > 0 then v_original when v_currency = 'CLP' then v_total else 0 end,
        v_currency, v_rate,
        coalesce((v_line->>'recoverable_tax')::boolean, false),
        coalesce((v_line->>'include_in_costing')::boolean, true),
        null,
        jsonb_build_object(
          'actual_source_document_id', v_document.id,
          'actual_source_index', nullif(trim(v_line->>'source_index'), '')::integer,
          'actual_confidence', nullif(trim(v_line->>'confidence'), '')::numeric
        )
      );
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  if v_inserted + v_updated = 0 then raise exception 'foreign_trade_agency_settlement_without_lines'; end if;

  update public.foreign_trade_expense_reconciliations
  set final_document_id = v_document.id,
      final_reference = v_final_reference,
      agency_name = coalesce(nullif(trim(v_general->>'agency_name'), ''), agency_name),
      agency_invoice_number = nullif(trim(v_general->>'invoice_number'), ''),
      final_invoice_date = nullif(trim(v_general->>'document_date'), '')::date,
      identity_confirmed = identity_confirmed or v_identity_confirmed
        or (provision_reference is not null and v_final_reference is not null
          and regexp_replace(lower(provision_reference), '[^a-z0-9]', '', 'g')
            = regexp_replace(lower(v_final_reference), '[^a-z0-9]', '', 'g')),
      status = 'reviewed',
      notes = coalesce(nullif(trim(v_general->>'observations'), ''), notes),
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'final_source', 'agency_settlement_document',
        'final_source_document_id', v_document.id,
        'final_extraction_version', p_review->>'extraction_version',
        'final_declared_total_clp', nullif(trim(v_general->>'declared_total_clp'), '')::numeric
      ),
      updated_by = auth.uid()
  where id = p_reconciliation_id;

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
    'reconciliation_id', p_reconciliation_id,
    'inserted_lines', v_inserted,
    'updated_lines', v_updated,
    'skipped_lines', v_skipped,
    'status', 'confirmed'
  );
end
$$;

revoke all on function public.confirm_foreign_trade_agency_settlement_document(uuid,uuid,jsonb) from public;
grant execute on function public.confirm_foreign_trade_agency_settlement_document(uuid,uuid,jsonb) to authenticated, service_role;

comment on function public.confirm_foreign_trade_agency_settlement_document(uuid,uuid,jsonb) is
  'Confirma una rendicion final revisada y carga sus valores reales en una conciliacion existente sin aplicar el costeo.';

commit;
