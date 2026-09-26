-- Editable references reuse the existing costs, costing engine and audit triggers.
-- No accounting entries, payments, documents or existing operations are changed on install.
begin;

do $$
begin
  if to_regprocedure('public.upsert_foreign_trade_cost_line_v19(jsonb)') is null then
    alter function public.upsert_foreign_trade_cost_line(jsonb) rename to upsert_foreign_trade_cost_line_v19;
  end if;
  if to_regprocedure('public.create_foreign_trade_operation_v19(jsonb)') is null then
    alter function public.create_foreign_trade_operation(jsonb) rename to create_foreign_trade_operation_v19;
  end if;
  if to_regprocedure('public.apply_foreign_trade_expense_reconciliation_v19(uuid)') is null then
    alter function public.apply_foreign_trade_expense_reconciliation(uuid) rename to apply_foreign_trade_expense_reconciliation_v19;
  end if;
  if to_regprocedure('public.auto_finalize_foreign_trade_expense_reconciliation_v19(uuid,boolean)') is null then
    alter function public.auto_finalize_foreign_trade_expense_reconciliation(uuid,boolean) rename to auto_finalize_foreign_trade_expense_reconciliation_v19;
  end if;
end $$;

revoke all on function public.upsert_foreign_trade_cost_line_v19(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.create_foreign_trade_operation_v19(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.apply_foreign_trade_expense_reconciliation_v19(uuid) from public, anon, authenticated, service_role;
revoke all on function public.auto_finalize_foreign_trade_expense_reconciliation_v19(uuid,boolean) from public, anon, authenticated, service_role;

create or replace function public.auto_finalize_foreign_trade_expense_reconciliation(p_reconciliation_id uuid, p_apply_costs boolean default true)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  perform 1 from public.import_shipments where id = (select operation_id
    from public.foreign_trade_expense_reconciliations where id = p_reconciliation_id) for update;
  perform 1 from public.foreign_trade_expense_reconciliations where id = p_reconciliation_id for update;
  if exists (select 1 from public.foreign_trade_expense_reconciliations
    where id = p_reconciliation_id and metadata->>'reference_only' = 'true') then
    return jsonb_build_object('reconciliation_id', p_reconciliation_id, 'costing_applied', false,
      'applied_lines', 0, 'reference_only', true);
  end if;
  return public.auto_finalize_foreign_trade_expense_reconciliation_v19(p_reconciliation_id, p_apply_costs);
end $$;

create or replace function public.simulate_foreign_trade_costs(p_operation_id uuid, p_expected_versions jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_operation public.import_shipments%rowtype;
  v_cost public.foreign_trade_cost_lines%rowtype;
  v_versions jsonb;
  v_ids uuid[] := '{}';
  v_count integer := 0;
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage')
     or not public.foreign_trade_has_permission('foreign_trade.operations.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  select * into v_operation from public.import_shipments where id = p_operation_id for update;
  if not found then raise exception 'foreign_trade_operation_not_found'; end if;
  if v_operation.status in ('received','closed','cancelled') or v_operation.warehouse_receipt_date is not null then
    raise exception 'foreign_trade_simulation_requires_future_operation';
  end if;
  perform 1 from public.foreign_trade_cost_lines where operation_id = p_operation_id for update;
  select coalesce(jsonb_object_agg(id::text, to_jsonb(updated_at)), '{}'::jsonb) into v_versions
  from public.foreign_trade_cost_lines where operation_id = p_operation_id;
  -- Compare timestamps as instants (PostgREST and JS can serialize offsets differently).
  if p_expected_versions is null or jsonb_typeof(p_expected_versions) <> 'object'
     or (select count(*) from jsonb_object_keys(v_versions)) <> (select count(*) from jsonb_object_keys(p_expected_versions))
     or exists (select 1 from jsonb_each_text(v_versions) e
       where not (p_expected_versions ? e.key)
          or (p_expected_versions->>e.key)::timestamptz is distinct from e.value::timestamptz) then
    raise exception 'foreign_trade_costs_changed_refresh';
  end if;
  for v_cost in select * from public.foreign_trade_cost_lines where operation_id = p_operation_id
    and not coalesce((metadata->>'excluded_from_costing')::boolean, false)
    and not (source_type = 'simulated' and metadata ? 'simulation_reference')
  loop
    update public.foreign_trade_cost_lines set source_type = 'simulated', updated_by = auth.uid(),
      metadata = jsonb_build_object(
        'simulation_reference', jsonb_build_object('operation_reference', v_operation.reference,
          'captured_at', now(), 'cost', to_jsonb(v_cost)),
        'amount_basis', coalesce(v_cost.metadata->>'amount_basis', 'net'),
        'vat_rate_percent', coalesce(v_cost.metadata->'vat_rate_percent', '0'::jsonb),
        'vat_amount_clp', v_cost.metadata->'vat_amount_clp',
        'gross_amount_clp', v_cost.metadata->'gross_amount_clp'
      )
    where id = v_cost.id;
    v_ids := array_append(v_ids, v_cost.id);
    v_count := v_count + 1;
  end loop;
  -- Keep the original reconciliation as history, never as current documentary evidence.
  update public.foreign_trade_expense_reconciliations r set
    metadata = r.metadata || jsonb_build_object('reference_only', true, 'reference_converted_at', now()),
    updated_by = auth.uid()
  where r.operation_id = p_operation_id and exists (
    select 1 from public.foreign_trade_expense_reconciliation_lines l
    where l.reconciliation_id = r.id and (l.applied_cost_line_id = any(v_ids) or l.provision_cost_line_id = any(v_ids))
  );
  update public.foreign_trade_expense_reconciliation_lines set
    metadata = metadata || jsonb_build_object('reference_applied_cost_line_id', applied_cost_line_id,
      'reference_provision_cost_line_id', provision_cost_line_id),
    applied_cost_line_id = null, provision_cost_line_id = null
  where operation_id = p_operation_id and (applied_cost_line_id = any(v_ids) or provision_cost_line_id = any(v_ids));
  return jsonb_build_object('converted_costs', v_count);
end $$;

create or replace function public.upsert_foreign_trade_cost_line(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old public.foreign_trade_cost_lines%rowtype;
  v_meta jsonb := coalesce(p_payload->'metadata', '{}'::jsonb);
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  perform 1 from public.import_shipments where id = nullif(p_payload->>'operation_id','')::uuid for update;
  select * into v_old from public.foreign_trade_cost_lines
    where id = nullif(p_payload->>'id', '')::uuid for update;
  if found then
    if v_old.metadata ? 'reconciliation_id' then raise exception 'foreign_trade_edit_in_reconciliation'; end if;
    if p_payload ? 'expected_updated_at' and (p_payload->>'expected_updated_at')::timestamptz is distinct from v_old.updated_at then
      raise exception 'foreign_trade_costs_changed_refresh';
    end if;
    if v_old.metadata ? 'simulation_reference' then
      -- Remove fixed historical VAT/conversion overrides when the editable amount changes.
      v_meta := v_meta || jsonb_build_object('simulation_reference', v_old.metadata->'simulation_reference');
    end if;
  end if;
  return public.upsert_foreign_trade_cost_line_v19(p_payload || jsonb_build_object('metadata', v_meta));
end $$;

create or replace function public.apply_foreign_trade_expense_reconciliation(p_reconciliation_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reconciliation public.foreign_trade_expense_reconciliations%rowtype;
  v_line public.foreign_trade_expense_reconciliation_lines%rowtype;
  v_result jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage')
     or not public.foreign_trade_has_permission('foreign_trade.approve') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  perform 1 from public.import_shipments where id = (select operation_id
    from public.foreign_trade_expense_reconciliations where id = p_reconciliation_id) for update;
  select * into v_reconciliation from public.foreign_trade_expense_reconciliations
    where id = p_reconciliation_id for update;
  if v_reconciliation.metadata->>'reference_only' = 'true' then
    raise exception 'foreign_trade_reference_only_reconciliation';
  end if;
  for v_line in select * from public.foreign_trade_expense_reconciliation_lines
    where reconciliation_id = p_reconciliation_id and include_in_costing and actual_total_clp > 0
      and provision_cost_line_id is not null
  loop
    if not exists (select 1 from public.foreign_trade_cost_lines c
      where c.id = v_line.provision_cost_line_id and c.operation_id = v_reconciliation.operation_id
        and c.source_type in ('simulated','estimated','configured') and c.category = v_line.cost_category) then
      raise exception 'foreign_trade_invalid_reference_replacement';
    end if;
    if exists (select 1 from public.foreign_trade_expense_reconciliation_lines l
      where l.id <> v_line.id and l.provision_cost_line_id = v_line.provision_cost_line_id
        and l.include_in_costing and l.actual_total_clp > 0) then
      raise exception 'foreign_trade_duplicate_reference_replacement';
    end if;
  end loop;
  v_result := public.apply_foreign_trade_expense_reconciliation_v19(p_reconciliation_id);
  update public.foreign_trade_cost_lines c set metadata = c.metadata || jsonb_build_object(
    'excluded_from_costing', true, 'superseded_by_reconciliation_id', p_reconciliation_id), updated_by = auth.uid()
  where exists (select 1 from public.foreign_trade_expense_reconciliation_lines l
    where l.reconciliation_id = p_reconciliation_id and l.include_in_costing and l.actual_total_clp > 0
      and l.provision_cost_line_id = c.id);
  return v_result;
end $$;

create or replace function public.foreign_trade_keep_reference_history()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.metadata->>'reference_only' = 'true' then
    new.metadata := new.metadata || jsonb_build_object('reference_only', true,
      'reference_converted_at', old.metadata->'reference_converted_at');
  end if;
  return new;
end $$;
drop trigger if exists keep_foreign_trade_reference_history on public.foreign_trade_expense_reconciliations;
create trigger keep_foreign_trade_reference_history before update on public.foreign_trade_expense_reconciliations
for each row execute function public.foreign_trade_keep_reference_history();

-- Product deletion must not cascade into the independent reference cost.
create or replace function public.foreign_trade_detach_reference_costs()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.foreign_trade_cost_lines set operation_line_id = null
  where operation_line_id = old.id and metadata ? 'simulation_reference';
  return old;
end $$;
drop trigger if exists detach_foreign_trade_reference_costs on public.foreign_trade_operation_lines;
create trigger detach_foreign_trade_reference_costs before delete on public.foreign_trade_operation_lines
for each row execute function public.foreign_trade_detach_reference_costs();

create or replace function public.foreign_trade_invalidate_cost_projection()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.foreign_trade_scenarios set calculated_at = null,
    logistics_total_clp = null, duties_total_clp = null, taxes_total_clp = null,
    landed_total_clp = null, projected_sales_clp = null, projected_profit_clp = null, projected_margin_percent = null,
    missing_inputs = array['Costos modificados: recalcular escenario'], updated_by = auth.uid()
  where operation_id = case when tg_op = 'DELETE' then old.operation_id else new.operation_id end
    and status = 'baseline' and calculated_at is not null;
  return null;
end $$;
drop trigger if exists invalidate_foreign_trade_cost_projection on public.foreign_trade_cost_lines;
create trigger invalidate_foreign_trade_cost_projection after insert or update or delete on public.foreign_trade_cost_lines
for each row execute function public.foreign_trade_invalidate_cost_projection();

create or replace function public.create_foreign_trade_operation(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_previous public.import_shipments%rowtype;
begin
  v_id := public.create_foreign_trade_operation_v19(p_payload);
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage')
     or coalesce(p_payload->>'status', '') in ('received','closed','cancelled') then return v_id; end if;
  select o.* into v_previous from public.import_shipments o
  where o.id <> v_id and o.status in ('received','closed')
    and o.transport_type = coalesce(nullif(p_payload->>'transport_type', ''), 'sea')
    and exists (select 1 from public.foreign_trade_expense_reconciliations r where r.operation_id = o.id
      and r.status in ('applied','settled') and r.applied_at is not null
      and exists (select 1 from public.foreign_trade_documents d where d.id = r.final_document_id
        and d.operation_id = o.id and d.parse_status = 'confirmed')
      and coalesce(r.metadata->>'reference_only','false') <> 'true')
    and not exists (select 1 from public.foreign_trade_expense_reconciliations r where r.operation_id = o.id
      and (r.status not in ('applied','settled') or r.metadata->>'reference_only' = 'true'))
    and exists (select 1 from public.foreign_trade_cost_lines c where c.operation_id = o.id
      and c.source_type = 'real' and c.category not in ('merchandise','duties','taxes')
      and not coalesce((c.metadata->>'excluded_from_costing')::boolean, false))
    and not exists (select 1 from public.foreign_trade_cost_lines c where c.operation_id = o.id
      and c.source_type not in ('real','document') and not coalesce((c.metadata->>'excluded_from_costing')::boolean, false))
  order by o.warehouse_receipt_date desc nulls last,
    (select max(r.applied_at) from public.foreign_trade_expense_reconciliations r where r.operation_id = o.id) desc,
    o.id
  limit 1 for share;
  if found then
    insert into public.foreign_trade_cost_lines (operation_id, category, name, amount_original, currency,
      exchange_rate_clp, amount_clp, allocation_method, source_type, recoverable_tax, notes, metadata, created_by, updated_by)
    select v_id, c.category, c.name, c.amount_original, c.currency, c.exchange_rate_clp, c.amount_clp,
      c.allocation_method, 'simulated', c.recoverable_tax, c.notes,
      jsonb_build_object('simulation_reference', jsonb_build_object('operation_reference', v_previous.reference,
        'captured_at', now(), 'cost', to_jsonb(c)),
        'amount_basis', coalesce(c.metadata->>'amount_basis','net'),
        'vat_rate_percent', coalesce(c.metadata->'vat_rate_percent','0'::jsonb),
        'vat_amount_clp', c.metadata->'vat_amount_clp', 'gross_amount_clp', c.metadata->'gross_amount_clp'),
      auth.uid(), auth.uid()
    from public.foreign_trade_cost_lines c where c.operation_id = v_previous.id
      and c.category not in ('merchandise','duties','taxes')
      and c.source_type in ('real','document') and not coalesce((c.metadata->>'excluded_from_costing')::boolean, false);
  end if;
  return v_id;
end $$;

revoke all on function public.simulate_foreign_trade_costs(uuid,jsonb) from public, anon;
revoke all on function public.upsert_foreign_trade_cost_line(jsonb) from public, anon;
revoke all on function public.apply_foreign_trade_expense_reconciliation(uuid) from public, anon;
revoke all on function public.create_foreign_trade_operation(jsonb) from public, anon;
revoke all on function public.auto_finalize_foreign_trade_expense_reconciliation(uuid,boolean) from public, anon;
grant execute on function public.auto_finalize_foreign_trade_expense_reconciliation(uuid,boolean) to authenticated, service_role;
grant execute on function public.simulate_foreign_trade_costs(uuid,jsonb), public.upsert_foreign_trade_cost_line(jsonb),
  public.apply_foreign_trade_expense_reconciliation(uuid), public.create_foreign_trade_operation(jsonb) to authenticated, service_role;
revoke all on function public.foreign_trade_keep_reference_history(), public.foreign_trade_detach_reference_costs() from public, anon;
revoke all on function public.foreign_trade_invalidate_cost_projection() from public, anon;
notify pgrst, 'reload schema';
commit;
