-- Alinea la cartera operativa del CRM con la foto autoritativa más reciente de Facto.
-- No modifica abonos bancarios, conciliaciones ni asientos contables.

begin;

do $$
declare
  v_entity uuid;
  v_snapshot_id uuid;
  v_payload jsonb;
  v_collections jsonb;
  v_updated_at timestamptz;
  v_as_of date;
  v_from date := date '2026-01-01';
  v_examined numeric;
  v_with_pdf numeric;
  v_with_balance numeric;
  v_percent numeric;
  v_detail_count integer;
  v_observed numeric(20,4);
  v_result numeric(20,4);
  v_updated integer := 0;
  v_cleared integer := 0;
begin
  select id into v_entity
  from public.accounting_entities
  where active = true
  order by created_at
  limit 1;

  select id, payload, updated_at
  into v_snapshot_id, v_payload, v_updated_at
  from public.integration_records
  where provider = 'facto' and resource = 'financial_snapshots'
  order by updated_at desc
  limit 1;

  if v_entity is null or v_snapshot_id is null then
    raise exception 'No existe empresa activa o foto financiera Facto.';
  end if;

  v_collections := coalesce(v_payload->'collections', '{}'::jsonb);
  if coalesce((v_collections->>'authoritative')::boolean, false) is not true then
    raise exception 'La foto de cobranza Facto no está marcada como autoritativa.';
  end if;

  v_as_of := coalesce(nullif(v_collections->>'as_of', '')::date, v_updated_at::date);
  v_examined := coalesce((v_collections->'pdf_coverage'->>'documents_examined')::numeric, 0);
  v_with_pdf := coalesce((v_collections->'pdf_coverage'->>'documents_with_pdf')::numeric, 0);
  v_with_balance := coalesce((v_collections->'pdf_coverage'->>'documents_with_balance')::numeric, 0);
  v_percent := coalesce((v_collections->'pdf_coverage'->>'percent')::numeric, 0);
  v_detail_count := jsonb_array_length(coalesce(v_collections->'documents_detail', '[]'::jsonb));
  v_observed := coalesce((v_collections->>'observed_amount')::numeric, 0);

  if coalesce((v_collections->>'portfolio_complete')::boolean, false) is not true
     and not (
       v_collections->>'mode' = 'facto_document_pdf'
       and v_examined > 0
       and v_with_pdf >= v_examined
       and v_percent >= 0.999
       and v_with_balance = v_detail_count
       and v_collections->>'classification_status' = 'complete'
       and coalesce((v_collections->>'unclassified_documents')::numeric, 0) = 0
     ) then
    raise exception 'La cobertura Facto no permite cerrar saldos ausentes de forma segura.';
  end if;

  with details as (
    select value as item
    from jsonb_array_elements(coalesce(v_collections->'documents_detail', '[]'::jsonb))
  )
  update public.accounting_receivables r
  set reported_paid_amount_clp = greatest(0, r.original_amount_clp - (d.item->>'observed_amount')::numeric),
      reported_balance_clp = (d.item->>'observed_amount')::numeric,
      reported_at = v_updated_at,
      updated_at = now()
  from public.accounting_source_documents s, details d
  where r.source_document_id = s.id
    and s.entity_id = v_entity
    and s.source_type = 'FACTO'
    and s.issued_on between v_from and v_as_of
    and (
      s.external_id = nullif(d.item->>'document_id', '')
      or s.folio = nullif(d.item->>'document_number', '')
    )
    and (d.item->>'observed_amount')::numeric between 0 and r.original_amount_clp;
  get diagnostics v_updated = row_count;

  with details as (
    select value as item
    from jsonb_array_elements(coalesce(v_collections->'documents_detail', '[]'::jsonb))
  )
  update public.accounting_receivables r
  set reported_paid_amount_clp = r.original_amount_clp,
      reported_balance_clp = 0,
      reported_at = v_updated_at,
      updated_at = now()
  from public.accounting_source_documents s
  where r.source_document_id = s.id
    and s.entity_id = v_entity
    and s.source_type = 'FACTO'
    and s.issued_on between v_from and v_as_of
    and s.document_type in ('sales_invoice', 'sales_receipt')
    and not exists (
      select 1 from details d
      where s.external_id = nullif(d.item->>'document_id', '')
         or s.folio = nullif(d.item->>'document_number', '')
    );
  get diagnostics v_cleared = row_count;

  select coalesce(sum(r.reported_balance_clp), 0)
  into v_result
  from public.accounting_receivables r
  join public.accounting_source_documents s on s.id = r.source_document_id
  where s.entity_id = v_entity
    and s.source_type = 'FACTO'
    and s.issued_on between v_from and v_as_of;

  if abs(v_result - v_observed) > 0.5 then
    raise exception 'La cartera Facto no cuadró: resultado %, esperado %.', v_result, v_observed;
  end if;

  insert into public.accounting_audit_events(
    entity_id, action, entity_type, entity_id_text, reason, new_value
  ) values (
    v_entity,
    'facto.live_receivables_snapshot_applied',
    'integration_record',
    v_snapshot_id::text,
    'Alineación operativa solicitada; no altera conciliaciones ni abonos bancarios.',
    jsonb_build_object(
      'snapshot_updated_at', v_updated_at,
      'snapshot_as_of', v_as_of,
      'reported_amount_clp', v_observed,
      'result_amount_clp', v_result,
      'documents_updated', v_updated,
      'documents_cleared', v_cleared,
      'bank_allocations_unchanged', true
    )
  );

  perform public.accounting_refresh_controls(v_entity);
end
$$;

commit;
