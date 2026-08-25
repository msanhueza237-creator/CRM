-- Centro de Comercio Exterior - Fase 15
-- Control documental de rendiciones: subtotales, remesa y devolución.
-- Ejecutar despues de foreign_trade_center_phase14_direct_supplier_payments.sql.

begin;

create or replace function public.foreign_trade_is_reconciliation_summary_line(p_concept text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select regexp_replace(translate(lower(coalesce(p_concept, '')), 'áéíóúüñ', 'aeiouun'), '[^a-z0-9]+', '', 'g')
    ~ '^(?:(?:total|subtotal|suma)(?:desembolsos|gastos|rendicion|facturas?|documentos|general|facturaagencia|derechosaduana|aduana)?|honorarios(?:partede)?facturaagencia|remesa|pagodirecto|totalasufavor|saldoasufavor|devolucion)$';
$$;

create or replace function public.foreign_trade_normalize_reconciliation_summary_line()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if public.foreign_trade_is_reconciliation_summary_line(new.concept) then
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'informational_summary', true,
      'documentary_summary_amount_clp', coalesce(new.actual_total_clp, 0),
      'excluded_from_costing', true
    );
    new.include_in_costing := false;
    new.actual_net_clp := 0;
    new.actual_vat_clp := 0;
    new.actual_total_clp := 0;
    new.actual_amount_original := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists normalize_reconciliation_summary_line
on public.foreign_trade_expense_reconciliation_lines;
create trigger normalize_reconciliation_summary_line
before insert or update of concept, actual_net_clp, actual_vat_clp, actual_total_clp, actual_amount_original
on public.foreign_trade_expense_reconciliation_lines
for each row execute function public.foreign_trade_normalize_reconciliation_summary_line();

-- Los resúmenes antiguos permanecen trazables en el documento original, pero
-- dejan de participar como importes conciliables o costos independientes.
update public.foreign_trade_cost_lines c
set metadata = coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object(
      'excluded_from_costing', true,
      'excluded_reason', 'documentary_summary',
      'documentary_summary_migrated_at', now()
    ),
    updated_by = coalesce(auth.uid(), c.updated_by)
from public.foreign_trade_expense_reconciliation_lines l
where c.metadata->>'reconciliation_line_id' = l.id::text
  and public.foreign_trade_is_reconciliation_summary_line(l.concept);

update public.foreign_trade_expense_reconciliation_lines
set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'informational_summary', true,
      'documentary_summary_amount_clp', coalesce(actual_total_clp, 0),
      'excluded_from_costing', true,
      'documentary_summary_migrated_at', now()
    ),
    include_in_costing = false,
    actual_net_clp = 0,
    actual_vat_clp = 0,
    actual_total_clp = 0,
    actual_amount_original = 0
where public.foreign_trade_is_reconciliation_summary_line(concept);

create or replace function public.foreign_trade_capture_documentary_settlement_summary()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reconciliation_id uuid;
  v_totals jsonb := coalesce(new.review_result->'totals', '{}'::jsonb);
  v_general jsonb := coalesce(new.review_result->'general', '{}'::jsonb);
  v_agency_invoice numeric(20,2);
  v_disbursements numeric(20,2);
  v_customs numeric(20,2);
  v_document_total numeric(20,2);
  v_remittance numeric(20,2);
  v_direct_payment numeric(20,2);
  v_refund numeric(20,2);
  v_detail_total numeric(20,2);
begin
  if new.document_type <> 'agency_settlement'
     or new.parse_status <> 'confirmed'
     or old.parse_status is not distinct from new.parse_status then
    return new;
  end if;

  select id into v_reconciliation_id
  from public.foreign_trade_expense_reconciliations
  where final_document_id = new.id and operation_id = new.operation_id
  order by updated_at desc
  limit 1;
  if v_reconciliation_id is null then return new; end if;

  v_agency_invoice := nullif(trim(v_totals->>'agency_invoice_total_clp'), '')::numeric;
  v_disbursements := nullif(trim(v_totals->>'disbursements_total_clp'), '')::numeric;
  v_customs := nullif(trim(v_totals->>'customs_total_clp'), '')::numeric;
  v_document_total := coalesce(
    nullif(trim(v_totals->>'document_total_clp'), '')::numeric,
    nullif(trim(v_general->>'declared_total_clp'), '')::numeric
  );
  v_remittance := nullif(trim(v_totals->>'remittance_clp'), '')::numeric;
  v_direct_payment := coalesce(nullif(trim(v_totals->>'documentary_direct_payment_clp'), '')::numeric, 0);
  v_refund := abs(nullif(trim(v_totals->>'refund_due_clp'), '')::numeric);

  if v_agency_invoice is not null and v_disbursements is not null and v_customs is not null
     and v_document_total is not null
     and abs(v_agency_invoice + v_disbursements + v_customs - v_document_total) > 1 then
    raise exception 'foreign_trade_documentary_components_mismatch';
  end if;

  select coalesce(sum(actual_total_clp), 0) into v_detail_total
  from public.foreign_trade_expense_reconciliation_lines
  where reconciliation_id = v_reconciliation_id
    and not public.foreign_trade_is_reconciliation_summary_line(concept)
    and public.foreign_trade_is_agency_reconciliation_line(provider_name, metadata);

  if v_document_total is not null and v_detail_total > 0 and abs(v_detail_total - v_document_total) > 1 then
    raise exception 'foreign_trade_documentary_detail_mismatch';
  end if;
  if v_remittance is not null and v_document_total is not null and v_refund is not null
     and abs(greatest(v_remittance + v_direct_payment - v_document_total, 0) - v_refund) > 1 then
    raise exception 'foreign_trade_documentary_refund_mismatch';
  end if;

  update public.foreign_trade_expense_reconciliations
  set remittance_amount_clp = case when coalesce(v_remittance, 0) > 0 then v_remittance else remittance_amount_clp end,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'documentary_summary_version', 'agency_settlement_summary_v2',
        'documentary_summary_source_id', new.id,
        'documentary_summary', jsonb_build_object(
          'agency_invoice_total_clp', v_agency_invoice,
          'disbursements_total_clp', v_disbursements,
          'customs_total_clp', v_customs,
          'document_total_clp', v_document_total,
          'remittance_clp', coalesce(v_remittance, remittance_amount_clp),
          'documentary_direct_payment_clp', v_direct_payment,
          'refund_due_clp', coalesce(v_refund, greatest(coalesce(v_remittance, remittance_amount_clp) + v_direct_payment - coalesce(v_document_total, v_detail_total), 0)),
          'detail_total_clp', v_detail_total,
          'detail_variance_clp', case when v_document_total is null then null else v_detail_total - v_document_total end
        ),
        'documentary_summary_captured_at', now()
      ),
      updated_by = coalesce(auth.uid(), updated_by)
  where id = v_reconciliation_id;

  return new;
end;
$$;

drop trigger if exists a_capture_foreign_trade_documentary_summary
on public.foreign_trade_documents;
create trigger a_capture_foreign_trade_documentary_summary
before update of parse_status on public.foreign_trade_documents
for each row execute function public.foreign_trade_capture_documentary_settlement_summary();

-- Recupera el total documental de rendiciones ya confirmadas. Si la versión
-- antigua no guardó el resumen completo, el total declarado y la remesa
-- existente bastan para conservar el saldo firmado por la factura.
with documentary as (
  select
    r.id,
    d.id as document_id,
    coalesce(
      nullif(trim(d.review_result->'totals'->>'document_total_clp'), '')::numeric,
      nullif(trim(d.review_result->'general'->>'declared_total_clp'), '')::numeric
    ) as document_total_clp,
    nullif(trim(d.review_result->'totals'->>'agency_invoice_total_clp'), '')::numeric as agency_invoice_total_clp,
    nullif(trim(d.review_result->'totals'->>'disbursements_total_clp'), '')::numeric as disbursements_total_clp,
    nullif(trim(d.review_result->'totals'->>'customs_total_clp'), '')::numeric as customs_total_clp,
    coalesce(nullif(trim(d.review_result->'totals'->>'remittance_clp'), '')::numeric, r.remittance_amount_clp) as remittance_clp,
    coalesce(nullif(trim(d.review_result->'totals'->>'documentary_direct_payment_clp'), '')::numeric, 0) as direct_payment_clp,
    abs(nullif(trim(d.review_result->'totals'->>'refund_due_clp'), '')::numeric) as documented_refund_clp,
    coalesce((
      select sum(l.actual_total_clp)
      from public.foreign_trade_expense_reconciliation_lines l
      where l.reconciliation_id = r.id
        and not public.foreign_trade_is_reconciliation_summary_line(l.concept)
        and public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)
    ), 0) as detail_total_clp
  from public.foreign_trade_expense_reconciliations r
  join public.foreign_trade_documents d on d.id = r.final_document_id
  where d.document_type = 'agency_settlement' and d.parse_status = 'confirmed'
)
update public.foreign_trade_expense_reconciliations r
set remittance_amount_clp = case when d.remittance_clp > 0 then d.remittance_clp else r.remittance_amount_clp end,
    status = case
      when greatest(d.remittance_clp + d.direct_payment_clp - coalesce(d.document_total_clp, d.detail_total_clp) - r.refund_received_clp, 0) > 0 then 'refund_pending'
      when d.remittance_clp + d.direct_payment_clp - coalesce(d.document_total_clp, d.detail_total_clp) > 0
        and r.refund_received_clp >= d.remittance_clp + d.direct_payment_clp - coalesce(d.document_total_clp, d.detail_total_clp) then 'settled'
      else case when r.status = 'settled' then 'settled' else 'applied' end
    end,
    metadata = coalesce(r.metadata, '{}'::jsonb) || jsonb_build_object(
      'documentary_summary_version', 'agency_settlement_summary_v2',
      'documentary_summary_source_id', d.document_id,
      'documentary_summary', jsonb_build_object(
        'agency_invoice_total_clp', d.agency_invoice_total_clp,
        'disbursements_total_clp', d.disbursements_total_clp,
        'customs_total_clp', d.customs_total_clp,
        'document_total_clp', d.document_total_clp,
        'remittance_clp', d.remittance_clp,
        'documentary_direct_payment_clp', d.direct_payment_clp,
        'refund_due_clp', coalesce(d.documented_refund_clp, greatest(d.remittance_clp + d.direct_payment_clp - coalesce(d.document_total_clp, d.detail_total_clp), 0)),
        'detail_total_clp', d.detail_total_clp,
        'detail_variance_clp', case when d.document_total_clp is null then null else d.detail_total_clp - d.document_total_clp end
      ),
      'documentary_summary_backfilled_at', now()
    ),
    updated_by = coalesce(auth.uid(), r.updated_by)
from documentary d
where r.id = d.id and coalesce(d.document_total_clp, d.detail_total_clp) > 0;

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
      'lines', coalesce(lines.items, '[]'::jsonb),
      'totals', jsonb_build_object(
        'provision_expenses_clp', sums.provision_expenses_clp,
        'actual_expenses_clp', sums.actual_expenses_clp,
        'provision_taxes_clp', sums.provision_taxes_clp,
        'actual_taxes_clp', sums.actual_taxes_clp,
        'provision_total_clp', sums.provision_total_clp,
        'actual_total_clp', effective.actual_total_clp,
        'detail_total_clp', sums.actual_total_clp,
        'documentary_total_clp', effective.documentary_total_clp,
        'detail_variance_clp', sums.actual_total_clp - effective.actual_total_clp,
        'direct_supplier_total_clp', sums.direct_supplier_total_clp,
        'balance_clp', effective.remittance_clp - effective.actual_total_clp,
        'refund_due_clp', greatest(effective.remittance_clp - effective.actual_total_clp - r.refund_received_clp, 0),
        'additional_payment_clp', greatest(effective.actual_total_clp - effective.remittance_clp, 0),
        'documentary_refund_due_clp', nullif(r.metadata#>>'{documentary_summary,refund_due_clp}', '')::numeric
      )
    ) order by r.created_at desc
  ), '[]'::jsonb) into v_result
  from public.foreign_trade_expense_reconciliations r
  cross join lateral (
    select coalesce(jsonb_agg(to_jsonb(l) order by l.position, l.created_at), '[]'::jsonb) as items
    from public.foreign_trade_expense_reconciliation_lines l
    where l.reconciliation_id = r.id
  ) lines
  cross join lateral (
    select
      coalesce(sum(l.provision_total_clp) filter (where l.line_type not in ('customs_duty','import_vat') and public.foreign_trade_is_agency_reconciliation_line(l.provider_name,l.metadata) and not public.foreign_trade_is_reconciliation_summary_line(l.concept)), 0) as provision_expenses_clp,
      coalesce(sum(l.actual_total_clp) filter (where l.line_type not in ('customs_duty','import_vat') and public.foreign_trade_is_agency_reconciliation_line(l.provider_name,l.metadata) and not public.foreign_trade_is_reconciliation_summary_line(l.concept)), 0) as actual_expenses_clp,
      coalesce(sum(l.provision_total_clp) filter (where l.line_type in ('customs_duty','import_vat') and public.foreign_trade_is_agency_reconciliation_line(l.provider_name,l.metadata) and not public.foreign_trade_is_reconciliation_summary_line(l.concept)), 0) as provision_taxes_clp,
      coalesce(sum(l.actual_total_clp) filter (where l.line_type in ('customs_duty','import_vat') and public.foreign_trade_is_agency_reconciliation_line(l.provider_name,l.metadata) and not public.foreign_trade_is_reconciliation_summary_line(l.concept)), 0) as actual_taxes_clp,
      coalesce(sum(l.provision_total_clp) filter (where public.foreign_trade_is_agency_reconciliation_line(l.provider_name,l.metadata) and not public.foreign_trade_is_reconciliation_summary_line(l.concept)), 0) as provision_total_clp,
      coalesce(sum(l.actual_total_clp) filter (where public.foreign_trade_is_agency_reconciliation_line(l.provider_name,l.metadata) and not public.foreign_trade_is_reconciliation_summary_line(l.concept)), 0) as actual_total_clp,
      coalesce(sum(l.actual_total_clp) filter (where not public.foreign_trade_is_agency_reconciliation_line(l.provider_name,l.metadata) and not public.foreign_trade_is_reconciliation_summary_line(l.concept)), 0) as direct_supplier_total_clp
    from public.foreign_trade_expense_reconciliation_lines l
    where l.reconciliation_id = r.id
  ) sums
  cross join lateral (
    select
      coalesce(nullif(r.metadata#>>'{documentary_summary,document_total_clp}', '')::numeric, sums.actual_total_clp) as actual_total_clp,
      nullif(r.metadata#>>'{documentary_summary,document_total_clp}', '')::numeric as documentary_total_clp,
      coalesce(nullif(r.metadata#>>'{documentary_summary,remittance_clp}', '')::numeric, r.remittance_amount_clp) as remittance_clp
  ) effective
  where r.operation_id = p_operation_id;

  return v_result;
end;
$$;

revoke all on function public.foreign_trade_is_reconciliation_summary_line(text) from public;
grant execute on function public.foreign_trade_is_reconciliation_summary_line(text) to authenticated, service_role;

comment on function public.foreign_trade_is_reconciliation_summary_line(text) is
  'Identifica subtotales, remesas y saldos documentales que no deben duplicarse como costos.';
comment on function public.foreign_trade_expense_reconciliation_list(uuid) is
  'Entrega costos detallados y usa el resumen firmado de la factura como total autoritativo para saldo y devolución.';

commit;
