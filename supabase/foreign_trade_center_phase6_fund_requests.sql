-- Extraccion y confirmacion segura de solicitudes/provisiones de fondos.
-- Ejecutar despues de foreign_trade_center_phase5_reconciliation.sql.

begin;

create or replace function public.confirm_foreign_trade_fund_request_document(
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
  v_general jsonb;
  v_line jsonb;
  v_reconciliation_id uuid;
  v_reference text;
  v_title text;
  v_line_type text;
  v_category text;
  v_concept text;
  v_currency text;
  v_original numeric(20,6);
  v_rate numeric(18,6);
  v_net numeric(20,2);
  v_vat numeric(20,2);
  v_total numeric(20,2);
  v_remittance numeric(20,2);
  v_declared_total numeric(20,2);
  v_inserted integer := 0;
  v_skipped integer := 0;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage')
     or not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_review, '{}'::jsonb)) <> 'object'
     or p_review->>'document_kind' <> 'fund_request'
     or jsonb_typeof(p_review->'general') <> 'object'
     or jsonb_typeof(p_review->'lines') <> 'array' then
    raise exception 'foreign_trade_invalid_fund_request_review';
  end if;
  if jsonb_array_length(p_review->'lines') > 300 then
    raise exception 'foreign_trade_too_many_document_lines';
  end if;

  select * into v_document
  from public.foreign_trade_documents
  where id = p_document_id
  for update;
  if not found then raise exception 'foreign_trade_document_not_found'; end if;
  if v_document.document_type <> 'fund_request' then
    raise exception 'foreign_trade_document_not_fund_request';
  end if;
  if v_document.parse_status <> 'review_required' then
    raise exception 'foreign_trade_document_not_ready';
  end if;

  v_general := p_review->'general';
  v_reference := nullif(trim(v_general->>'reference'), '');
  v_title := left(coalesce('Provision ' || v_reference, 'Provision de fondos'), 180);
  v_remittance := nullif(trim(v_general->>'remittance_amount_clp'), '')::numeric;
  v_declared_total := nullif(trim(v_general->>'declared_total_clp'), '')::numeric;
  if least(coalesce(v_remittance, 0), coalesce(v_declared_total, 0)) < 0 then
    raise exception 'foreign_trade_invalid_reconciliation_amount';
  end if;

  insert into public.foreign_trade_expense_reconciliations(
    operation_id, title, agency_name, provision_document_id, provision_reference,
    remittance_date, remittance_amount_clp, status, identity_confirmed, notes,
    metadata, created_by, updated_by
  ) values (
    v_document.operation_id,
    v_title,
    nullif(trim(v_general->>'agency_name'), ''),
    v_document.id,
    v_reference,
    nullif(trim(v_general->>'document_date'), '')::date,
    coalesce(v_remittance, v_declared_total, 0),
    'reviewed',
    false,
    nullif(trim(v_general->>'observations'), ''),
    jsonb_build_object(
      'source', 'fund_request_document',
      'source_document_id', v_document.id,
      'extraction_version', p_review->>'extraction_version',
      'declared_total_clp', v_declared_total
    ),
    auth.uid(),
    auth.uid()
  ) returning id into v_reconciliation_id;

  for v_line in select value from jsonb_array_elements(p_review->'lines')
  loop
    if coalesce((v_line->>'include')::boolean, true) is false then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_line_type := coalesce(nullif(trim(v_line->>'line_type'), ''), 'operating_expense');
    v_category := coalesce(nullif(trim(v_line->>'cost_category'), ''), 'other');
    v_concept := trim(coalesce(v_line->>'concept', ''));
    v_currency := upper(coalesce(nullif(trim(v_line->>'currency'), ''), 'CLP'));
    v_original := coalesce(nullif(trim(v_line->>'amount_original'), '')::numeric, 0);
    v_rate := case when v_currency = 'CLP' then 1 else nullif(trim(v_line->>'exchange_rate_clp'), '')::numeric end;
    v_net := coalesce(nullif(trim(v_line->>'provision_net_clp'), '')::numeric, 0);
    v_vat := coalesce(nullif(trim(v_line->>'provision_vat_clp'), '')::numeric, 0);
    v_total := coalesce(
      nullif(trim(v_line->>'provision_total_clp'), '')::numeric,
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
    if nullif(trim(v_line->>'source_page'), '') is not null
       and nullif(trim(v_line->>'source_page'), '')::integer <= 0 then
      raise exception 'foreign_trade_invalid_source_page';
    end if;

    insert into public.foreign_trade_expense_reconciliation_lines(
      reconciliation_id, operation_id, position, line_type, cost_category, concept,
      provider_name, document_number, document_date, source_page,
      provision_net_clp, provision_vat_clp, provision_total_clp,
      provision_amount_original, provision_currency, provision_exchange_rate_clp,
      actual_net_clp, actual_vat_clp, actual_total_clp,
      actual_amount_original, actual_currency, actual_exchange_rate_clp,
      recoverable_tax, include_in_costing, notes, metadata
    ) values (
      v_reconciliation_id,
      v_document.operation_id,
      v_inserted,
      v_line_type,
      v_category,
      v_concept,
      nullif(trim(v_line->>'provider_name'), ''),
      nullif(trim(v_line->>'document_number'), ''),
      nullif(trim(v_line->>'document_date'), '')::date,
      nullif(trim(v_line->>'source_page'), '')::integer,
      v_net,
      v_vat,
      v_total,
      v_original,
      v_currency,
      v_rate,
      0, 0, 0, 0, 'CLP', 1,
      coalesce((v_line->>'recoverable_tax')::boolean, false),
      coalesce((v_line->>'include_in_costing')::boolean, true),
      case when jsonb_typeof(v_line->'warnings') = 'array' and jsonb_array_length(v_line->'warnings') > 0
        then left((v_line->'warnings')::text, 2000)
        else null
      end,
      jsonb_build_object(
        'source_document_id', v_document.id,
        'source_index', nullif(trim(v_line->>'source_index'), '')::integer,
        'confidence', nullif(trim(v_line->>'confidence'), '')::numeric
      )
    );
    v_inserted := v_inserted + 1;
  end loop;

  if v_inserted = 0 then raise exception 'foreign_trade_fund_request_without_lines'; end if;

  if coalesce(v_remittance, v_declared_total, 0) = 0 then
    update public.foreign_trade_expense_reconciliations
    set remittance_amount_clp = (
      select coalesce(sum(provision_total_clp), 0)
      from public.foreign_trade_expense_reconciliation_lines
      where reconciliation_id = v_reconciliation_id
    )
    where id = v_reconciliation_id;
  end if;

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
    'reconciliation_id', v_reconciliation_id,
    'inserted_lines', v_inserted,
    'skipped_lines', v_skipped,
    'status', 'confirmed'
  );
end
$$;

revoke all on function public.confirm_foreign_trade_fund_request_document(uuid,jsonb) from public;
grant execute on function public.confirm_foreign_trade_fund_request_document(uuid,jsonb) to authenticated, service_role;

comment on function public.confirm_foreign_trade_fund_request_document(uuid,jsonb) is
  'Confirma una provision revisada y crea atomicamente su conciliacion de gastos y tributos.';

commit;
