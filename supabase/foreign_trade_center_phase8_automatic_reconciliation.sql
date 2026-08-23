-- Centro de Comercio Exterior - Fase 8
-- Conciliacion, costeo y refresco automatico desde documentos confirmados.
-- Ejecutar despues de foreign_trade_center_phase7_agency_settlements.sql.

begin;

create or replace function public.auto_finalize_foreign_trade_expense_reconciliation(
  p_reconciliation_id uuid,
  p_apply_costs boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reconciliation public.foreign_trade_expense_reconciliations%rowtype;
  v_provision_document public.foreign_trade_documents%rowtype;
  v_final_document public.foreign_trade_documents%rowtype;
  v_provision_general jsonb := '{}'::jsonb;
  v_final_general jsonb := '{}'::jsonb;
  v_provision_reference text;
  v_final_reference text;
  v_invoice_number text;
  v_agency_name text;
  v_remittance_date date;
  v_final_invoice_date date;
  v_remittance_amount numeric(20,2);
  v_provision_total numeric(20,2);
  v_actual_total numeric(20,2);
  v_actual_lines integer;
  v_cost_lines integer := 0;
  v_references_match boolean := false;
  v_ready boolean := false;
  v_apply_result jsonb := '{}'::jsonb;
  v_status text;
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;

  select * into v_reconciliation
  from public.foreign_trade_expense_reconciliations
  where id = p_reconciliation_id
  for update;
  if not found then raise exception 'foreign_trade_reconciliation_not_found'; end if;

  if v_reconciliation.provision_document_id is not null then
    select * into v_provision_document
    from public.foreign_trade_documents
    where id = v_reconciliation.provision_document_id
      and operation_id = v_reconciliation.operation_id;
    if found then
      v_provision_general := coalesce(v_provision_document.review_result->'general', '{}'::jsonb);
    end if;
  end if;

  if v_reconciliation.final_document_id is not null then
    select * into v_final_document
    from public.foreign_trade_documents
    where id = v_reconciliation.final_document_id
      and operation_id = v_reconciliation.operation_id;
    if found then
      v_final_general := coalesce(v_final_document.review_result->'general', '{}'::jsonb);
    end if;
  end if;

  select
    coalesce(sum(provision_total_clp), 0),
    coalesce(sum(actual_total_clp), 0),
    count(*) filter (where actual_total_clp > 0)
  into v_provision_total, v_actual_total, v_actual_lines
  from public.foreign_trade_expense_reconciliation_lines
  where reconciliation_id = p_reconciliation_id;

  v_provision_reference := coalesce(
    nullif(trim(v_reconciliation.provision_reference), ''),
    nullif(trim(v_provision_general->>'reference'), '')
  );
  v_final_reference := coalesce(
    nullif(trim(v_reconciliation.final_reference), ''),
    nullif(trim(v_final_general->>'reference'), '')
  );
  v_invoice_number := coalesce(
    nullif(trim(v_final_general->>'invoice_number'), ''),
    nullif(trim(v_reconciliation.agency_invoice_number), '')
  );
  v_agency_name := coalesce(
    nullif(trim(v_final_general->>'agency_name'), ''),
    nullif(trim(v_provision_general->>'agency_name'), ''),
    nullif(trim(v_reconciliation.agency_name), '')
  );
  v_remittance_date := coalesce(
    nullif(trim(v_provision_general->>'document_date'), '')::date,
    v_reconciliation.remittance_date
  );
  v_final_invoice_date := coalesce(
    nullif(trim(v_final_general->>'document_date'), '')::date,
    v_reconciliation.final_invoice_date
  );
  v_remittance_amount := case
    when v_reconciliation.remittance_amount_clp > 0 then v_reconciliation.remittance_amount_clp
    else coalesce(
      nullif(nullif(trim(v_provision_general->>'remittance_amount_clp'), '')::numeric, 0),
      nullif(nullif(trim(v_provision_general->>'declared_total_clp'), '')::numeric, 0),
      nullif(v_provision_total, 0),
      0
    )
  end;

  v_references_match := v_provision_reference is not null
    and v_final_reference is not null
    and regexp_replace(lower(v_provision_reference), '[^a-z0-9]', '', 'g')
      = regexp_replace(lower(v_final_reference), '[^a-z0-9]', '', 'g');
  v_ready := v_provision_document.id is not null
    and v_final_document.id is not null
    and v_provision_document.parse_status = 'confirmed'
    and v_final_document.parse_status = 'confirmed'
    and v_actual_lines > 0
    and (
      v_provision_reference is null
      or v_final_reference is null
      or v_references_match
      or v_reconciliation.identity_confirmed
    );

  update public.foreign_trade_expense_reconciliations
  set title = case
        when lower(trim(title)) in ('conciliacion de agencia', 'conciliación de agencia')
          and v_provision_reference is not null
          then left('Provision ' || v_provision_reference, 180)
        else title
      end,
      agency_name = v_agency_name,
      provision_reference = v_provision_reference,
      final_reference = v_final_reference,
      agency_invoice_number = v_invoice_number,
      remittance_date = v_remittance_date,
      final_invoice_date = v_final_invoice_date,
      remittance_amount_clp = v_remittance_amount,
      identity_confirmed = identity_confirmed or v_references_match,
      status = case when status = 'draft' and v_actual_lines > 0 then 'reviewed' else status end,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'automatic_reconciliation_version', 'document_refs_v1',
        'automatic_reconciliation_at', now(),
        'provision_total_clp', v_provision_total,
        'actual_total_clp', v_actual_total,
        'references_match', v_references_match,
        'ready_for_costing', v_ready
      ),
      updated_by = auth.uid()
  where id = p_reconciliation_id;

  if p_apply_costs
     and v_ready
     and v_reconciliation.status in ('draft', 'reviewed')
     and public.foreign_trade_has_permission('foreign_trade.approve') then
    select public.apply_foreign_trade_expense_reconciliation(p_reconciliation_id)
      into v_apply_result;
  end if;

  select count(*) into v_cost_lines
  from public.foreign_trade_cost_lines
  where operation_id = v_reconciliation.operation_id
    and metadata->>'reconciliation_id' = p_reconciliation_id::text
    and coalesce((metadata->>'excluded_from_costing')::boolean, false) is false;

  select status into v_status
  from public.foreign_trade_expense_reconciliations
  where id = p_reconciliation_id;

  return jsonb_build_object(
    'reconciliation_id', p_reconciliation_id,
    'operation_id', v_reconciliation.operation_id,
    'header_completed', true,
    'ready_for_costing', v_ready,
    'costing_applied', v_cost_lines > 0,
    'applied_lines', v_cost_lines,
    'provision_total_clp', v_provision_total,
    'actual_total_clp', coalesce((v_apply_result->>'actual_total_clp')::numeric, v_actual_total),
    'balance_clp', coalesce((v_apply_result->>'balance_clp')::numeric, v_remittance_amount - v_actual_total),
    'refund_due_clp', coalesce(
      (v_apply_result->>'refund_due_clp')::numeric,
      greatest(v_remittance_amount - v_actual_total - v_reconciliation.refund_received_clp, 0)
    ),
    'status', v_status
  );
end
$$;

create or replace function public.auto_finalize_foreign_trade_operation(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reconciliation record;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_processed integer := 0;
  v_applied integer := 0;
  v_applied_lines integer := 0;
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.import_shipments where id = p_operation_id) then
    raise exception 'foreign_trade_operation_not_found';
  end if;

  for v_reconciliation in
    select r.id
    from public.foreign_trade_expense_reconciliations r
    where r.operation_id = p_operation_id
      and r.provision_document_id is not null
      and r.final_document_id is not null
      and (
        r.status in ('draft', 'reviewed')
        or r.metadata->>'automatic_reconciliation_version' is distinct from 'document_refs_v1'
      )
    order by r.created_at
  loop
    v_result := public.auto_finalize_foreign_trade_expense_reconciliation(v_reconciliation.id, true);
    v_results := v_results || jsonb_build_array(v_result);
    v_processed := v_processed + 1;
    if coalesce((v_result->>'costing_applied')::boolean, false) then v_applied := v_applied + 1; end if;
    v_applied_lines := v_applied_lines + coalesce((v_result->>'applied_lines')::integer, 0);
  end loop;

  return jsonb_build_object(
    'operation_id', p_operation_id,
    'processed_reconciliations', v_processed,
    'applied_reconciliations', v_applied,
    'applied_lines', v_applied_lines,
    'results', v_results
  );
end
$$;

create or replace function public.auto_finalize_foreign_trade_settlement_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reconciliation_id uuid;
begin
  if new.document_type = 'agency_settlement'
     and new.parse_status = 'confirmed'
     and old.parse_status is distinct from new.parse_status
     and public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    select id into v_reconciliation_id
    from public.foreign_trade_expense_reconciliations
    where final_document_id = new.id
      and operation_id = new.operation_id
    order by updated_at desc
    limit 1;
    if v_reconciliation_id is not null then
      perform public.auto_finalize_foreign_trade_expense_reconciliation(v_reconciliation_id, true);
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists auto_finalize_foreign_trade_settlement on public.foreign_trade_documents;
create trigger auto_finalize_foreign_trade_settlement
after update of parse_status on public.foreign_trade_documents
for each row execute function public.auto_finalize_foreign_trade_settlement_trigger();

revoke all on function public.auto_finalize_foreign_trade_expense_reconciliation(uuid,boolean) from public;
revoke all on function public.auto_finalize_foreign_trade_operation(uuid) from public;
grant execute on function public.auto_finalize_foreign_trade_expense_reconciliation(uuid,boolean) to authenticated, service_role;
grant execute on function public.auto_finalize_foreign_trade_operation(uuid) to authenticated, service_role;

comment on function public.auto_finalize_foreign_trade_expense_reconciliation(uuid,boolean) is
  'Completa la cabecera desde documentos confirmados y aplica costos reales de forma idempotente cuando las referencias son seguras.';
comment on function public.auto_finalize_foreign_trade_operation(uuid) is
  'Actualiza conciliaciones historicas de una operacion y materializa los costos reales pendientes.';

commit;
