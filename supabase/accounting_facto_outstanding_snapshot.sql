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
  v_receivables_closed integer := 0;
  v_payables_closed integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Esta operación requiere service_role';
  end if;

  if not exists (
    select 1
    from public.accounting_import_batches b
    where b.id = p_batch_id
      and b.entity_id = p_entity_id
      and b.source_type = 'COLLECTIONS'
      and b.import_profile = 'facto_unpaid_documents'
  ) then
    raise exception 'La foto de documentos impagos Facto no existe o no corresponde a la empresa';
  end if;

  update public.accounting_receivables r
  set reported_paid_amount_clp = r.original_amount_clp,
      reported_balance_clp = 0,
      reported_at = now(),
      reported_source_batch_id = p_batch_id,
      status = 'paid',
      updated_at = now()
  where r.entity_id = p_entity_id
    and not (r.id = any(coalesce(p_receivable_ids, '{}'::uuid[])))
    and exists (
      select 1
      from public.accounting_source_documents d
      where d.id = r.source_document_id
        and d.entity_id = p_entity_id
        and d.source_type = 'FACTO'
        and d.issued_on <= p_as_of
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
    and not (p.id = any(coalesce(p_payable_ids, '{}'::uuid[])))
    and exists (
      select 1
      from public.accounting_source_documents d
      where d.id = p.source_document_id
        and d.entity_id = p_entity_id
        and d.source_type = 'FACTO'
        and d.issued_on <= p_as_of
    );
  get diagnostics v_payables_closed = row_count;

  return jsonb_build_object(
    'receivables_closed', v_receivables_closed,
    'payables_closed', v_payables_closed,
    'as_of', p_as_of,
    'batch_id', p_batch_id
  );
end;
$$;

revoke all on function public.accounting_apply_facto_outstanding_snapshot(uuid,uuid,date,uuid[],uuid[]) from public;
grant execute on function public.accounting_apply_facto_outstanding_snapshot(uuid,uuid,date,uuid[],uuid[]) to service_role;

comment on function public.accounting_apply_facto_outstanding_snapshot(uuid,uuid,date,uuid[],uuid[]) is
  'Aplica una foto completa de impagos Facto. No crea evidencia ni conciliaciones bancarias.';
