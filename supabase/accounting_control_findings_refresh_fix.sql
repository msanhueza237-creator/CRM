-- Finanzas y Contabilidad - refresco idempotente de alertas de control
-- Ejecutar despues de supabase/accounting_center.sql.

create or replace function public.accounting_refresh_controls(p_entity_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if not public.accounting_has_permission('accounting.ledger.view') and auth.role() <> 'service_role' then
    raise exception 'No tienes permiso para ejecutar controles contables.';
  end if;

  -- La restriccion unica incluye el estado. Antes de resolver una alerta
  -- recurrente, elimina solamente su version resuelta anterior para evitar
  -- que el UPDATE choque con ella. La alerta abierta actual conserva su ID.
  delete from public.accounting_control_findings previous
  using public.accounting_control_findings current_finding
  where previous.entity_id=p_entity_id
    and previous.status='resolved'
    and current_finding.entity_id=previous.entity_id
    and current_finding.status='open'
    and current_finding.control_code=previous.control_code
    and current_finding.entity_type is not distinct from previous.entity_type
    and current_finding.entity_reference is not distinct from previous.entity_reference
    and current_finding.control_code in (
      'bank_unmatched','source_unposted','receivable_overdue','payable_overdue','missing_exchange_rate'
    );

  update public.accounting_control_findings
  set status='resolved', resolved_at=now(), resolved_by=auth.uid()
  where entity_id=p_entity_id and status='open' and control_code in (
    'bank_unmatched','source_unposted','receivable_overdue','payable_overdue','missing_exchange_rate'
  );

  insert into public.accounting_control_findings(
    entity_id, control_code, severity, title, detail, entity_type, entity_reference, amount_clp
  )
  select p_entity_id, 'bank_unmatched', 'review', 'Movimiento bancario sin conciliar',
         description, 'bank_transaction', id::text, abs(amount_clp)
  from public.accounting_bank_transactions
  where entity_id=p_entity_id and reconciliation_status='unmatched'
  on conflict do nothing;

  insert into public.accounting_control_findings(
    entity_id, control_code, severity, title, detail, entity_type, entity_reference, amount_clp
  )
  select p_entity_id, 'source_unposted', 'review', 'Documento fuente sin contabilizar',
         coalesce(document_type,'Documento') || ' ' || coalesce(folio,source_key),
         'source_document', id::text, total_clp
  from public.accounting_source_documents
  where entity_id=p_entity_id and status in ('pending','validated','inconsistent')
  on conflict do nothing;

  select count(*) into v_count
  from public.accounting_control_findings
  where entity_id=p_entity_id and status='open';

  return v_count;
end;
$$;

revoke all on function public.accounting_refresh_controls(uuid) from public;
grant execute on function public.accounting_refresh_controls(uuid) to authenticated, service_role;
