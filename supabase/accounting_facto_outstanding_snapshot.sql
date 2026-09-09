-- Finanzas - aplica una foto completa de documentos impagos informada por Facto.
-- La ausencia de un documento en la foto significa saldo operativo cero, pero no
-- reemplaza la evidencia bancaria ni crea conciliaciones automáticas.

create or replace function public.accounting_apply_facto_outstanding_snapshot(
  p_entity_id uuid,
  p_batch_id uuid,
  p_as_of date,
  p_receivable_ids uuid[] default '{}'::uuid[],
  p_payable_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch public.accounting_import_batches%rowtype;
  v_from_date date;
  v_receivables_closed integer := 0;
  v_payables_closed integer := 0;
  v_receivables_complete boolean;
  v_payables_complete boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Esta operación requiere service_role';
  end if;

  select * into v_batch
  from public.accounting_import_batches b
  where b.id = p_batch_id
    and b.entity_id = p_entity_id
    and b.source_type = 'COLLECTIONS'
    and b.import_profile = 'facto_unpaid_documents'
  for update;

  if v_batch.id is null then
    raise exception 'La foto de documentos impagos Facto no existe o no corresponde a la empresa';
  end if;
  if coalesce((v_batch.summary->>'portfolio_complete')::boolean, false) is not true then
    raise exception 'El respaldo Facto no fue validado como una cartera completa';
  end if;
  if coalesce(v_batch.error_count, 0) > 0 then
    raise exception 'El archivo tiene errores y no puede cerrar saldos';
  end if;
  -- Missing sections are not evidence of a zero portfolio. Old batches may not
  -- carry the new flags, so require actual detail for either direction.
  v_receivables_complete := coalesce((v_batch.summary->>'receivables_complete')::boolean,
    coalesce((v_batch.summary->>'receivables_documents')::integer, cardinality(p_receivable_ids), 0) > 0);
  v_payables_complete := coalesce((v_batch.summary->>'payables_complete')::boolean,
    coalesce((v_batch.summary->>'payables_documents')::integer, cardinality(p_payable_ids), 0) > 0);

  v_from_date := coalesce(
    nullif(v_batch.summary->>'coverage_from', '')::date,
    date_trunc('year', p_as_of)::date
  );
  if p_as_of is null or v_from_date > p_as_of then
    raise exception 'La cobertura temporal de la foto Facto es inválida';
  end if;

  update public.accounting_receivables r
  set reported_paid_amount_clp = r.original_amount_clp,
      reported_balance_clp = 0,
      reported_at = now(),
      reported_source_batch_id = p_batch_id,
      status = 'paid',
      updated_at = now()
  where r.entity_id = p_entity_id
    and v_receivables_complete
    and r.status <> 'written_off'
    and not (r.id = any(coalesce(p_receivable_ids, '{}'::uuid[])))
    and exists (
      select 1
      from public.accounting_source_documents d
      where d.id = r.source_document_id
        and d.entity_id = p_entity_id
        and d.source_type = 'FACTO'
        and d.document_type like 'sales_%'
        and d.issued_on between v_from_date and p_as_of
    );
  get diagnostics v_receivables_closed = row_count;

  update public.accounting_payables p
  set reported_paid_amount_clp = p.original_amount_clp,
      reported_balance_clp = 0,
      reported_at = now(),
      reported_source_batch_id = p_batch_id,
      status = 'paid',
      updated_at = now()
  where p.entity_id = p_entity_id
    and v_payables_complete
    and p.status <> 'voided'
    and not (p.id = any(coalesce(p_payable_ids, '{}'::uuid[])))
    and exists (
      select 1
      from public.accounting_source_documents d
      where d.id = p.source_document_id
        and d.entity_id = p_entity_id
        and d.source_type = 'FACTO'
        and d.document_type like 'purchase_%'
        and d.issued_on between v_from_date and p_as_of
    );
  get diagnostics v_payables_closed = row_count;

  return jsonb_build_object(
    'receivables_closed', v_receivables_closed,
    'payables_closed', v_payables_closed,
    'receivables_updated', v_receivables_complete,
    'payables_updated', v_payables_complete,
    'coverage_from', v_from_date,
    'as_of', p_as_of,
    'batch_id', p_batch_id
  );
end;
$$;

revoke all on function public.accounting_apply_facto_outstanding_snapshot(uuid,uuid,date,uuid[],uuid[]) from public;
grant execute on function public.accounting_apply_facto_outstanding_snapshot(uuid,uuid,date,uuid[],uuid[]) to service_role;

comment on function public.accounting_apply_facto_outstanding_snapshot(uuid,uuid,date,uuid[],uuid[]) is
  'Aplica una foto completa de impagos Facto. No crea evidencia ni conciliaciones bancarias.';
