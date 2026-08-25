-- Centro de Comercio Exterior - Fase 14
-- Separa pagos directos a proveedores logisticos de la rendicion de la agencia.
-- Ejecutar despues de foreign_trade_center_phase13_packing_list_enrichment.sql.

begin;

create or replace function public.foreign_trade_is_agency_reconciliation_line(
  p_provider_name text,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_scope text := lower(coalesce(p_metadata->>'payment_scope', ''));
  v_provider text := trim(regexp_replace(lower(coalesce(p_provider_name, '')), '[^a-z0-9]+', ' ', 'g'));
begin
  if v_scope = 'direct_supplier'
     or coalesce((p_metadata->>'exclude_from_agency_reconciliation')::boolean, false) then
    return false;
  end if;
  if v_scope = 'agency' then return true; end if;
  if v_provider ~ '^ads?$'
     or (v_provider ~ '(^| )ads?( |$)'
       and v_provider ~ '(^| )(carga|cargas|cargo|internacional|internacionales)( |$)') then
    return false;
  end if;
  return true;
end
$$;

create or replace function public.apply_foreign_trade_expense_reconciliation(p_reconciliation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reconciliation public.foreign_trade_expense_reconciliations%rowtype;
  v_line public.foreign_trade_expense_reconciliation_lines%rowtype;
  v_cost_id uuid;
  v_amount numeric(20,2);
  v_actual_total numeric(20,2);
  v_direct_total numeric(20,2);
  v_balance numeric(20,2);
  v_refund_due numeric(20,2);
  v_source_amount numeric(20,6);
  v_source_currency text;
  v_source_rate numeric(18,6);
  v_converted_total numeric(20,2);
  v_applied integer := 0;
begin
  if not public.foreign_trade_has_permission('foreign_trade.costs.manage')
     or not public.foreign_trade_has_permission('foreign_trade.approve') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;

  select * into v_reconciliation
  from public.foreign_trade_expense_reconciliations
  where id = p_reconciliation_id;
  if not found then raise exception 'foreign_trade_reconciliation_not_found'; end if;
  if v_reconciliation.provision_reference is not null and v_reconciliation.final_reference is not null
     and lower(v_reconciliation.provision_reference) <> lower(v_reconciliation.final_reference)
     and not v_reconciliation.identity_confirmed then
    raise exception 'foreign_trade_reconciliation_identity_mismatch';
  end if;

  if v_reconciliation.general_estimate_cost_line_id is not null then
    update public.foreign_trade_cost_lines
    set metadata = metadata || jsonb_build_object(
          'excluded_from_costing', true,
          'superseded_by_reconciliation_id', v_reconciliation.id
        ),
        updated_by = auth.uid()
    where id = v_reconciliation.general_estimate_cost_line_id
      and operation_id = v_reconciliation.operation_id;
  end if;

  update public.foreign_trade_cost_lines
  set metadata = metadata || jsonb_build_object('excluded_from_costing', true),
      updated_by = auth.uid()
  where operation_id = v_reconciliation.operation_id
    and metadata->>'reconciliation_id' = v_reconciliation.id::text;

  -- Todos los costos se aplican al costo puesto en bodega. La forma de pago
  -- solo determina si la fila participa en el saldo de la agencia.
  for v_line in
    select * from public.foreign_trade_expense_reconciliation_lines
    where reconciliation_id = p_reconciliation_id and include_in_costing and actual_total_clp > 0
    order by position, created_at
  loop
    v_amount := case
      when v_line.line_type in ('customs_duty','import_vat') then v_line.actual_total_clp
      when v_line.actual_net_clp > 0 then v_line.actual_net_clp
      else v_line.actual_total_clp
    end;
    v_source_amount := case when v_line.actual_amount_original > 0 then v_line.actual_amount_original else v_amount end;
    v_source_currency := case when v_line.actual_amount_original > 0 then v_line.actual_currency else 'CLP' end;
    v_source_rate := case when v_source_currency = 'CLP' then null else v_line.actual_exchange_rate_clp end;
    v_converted_total := case
      when v_line.actual_amount_original <= 0 then null
      when v_line.actual_currency = 'CLP' then round(v_line.actual_amount_original, 2)
      when v_line.actual_exchange_rate_clp > 0 then round(v_line.actual_amount_original * v_line.actual_exchange_rate_clp, 2)
      else null
    end;

    if v_line.line_type in ('customs_duty','import_vat') then
      update public.foreign_trade_cost_lines
      set metadata = metadata || jsonb_build_object(
            'excluded_from_costing', true,
            'superseded_by_reconciliation_id', v_reconciliation.id
          ),
          updated_by = auth.uid()
      where operation_id = v_reconciliation.operation_id
        and category = v_line.cost_category
        and source_type = 'estimated'
        and id <> coalesce(v_line.applied_cost_line_id, gen_random_uuid());
    end if;

    if v_line.applied_cost_line_id is null then
      insert into public.foreign_trade_cost_lines(
        operation_id, category, name, amount_original, currency, exchange_rate_clp, amount_clp,
        allocation_method, source_type, recoverable_tax, notes, metadata, created_by, updated_by
      ) values (
        v_reconciliation.operation_id, v_line.cost_category, v_line.concept,
        v_source_amount, v_source_currency, v_source_rate, v_amount,
        'fob_value', 'real', v_line.recoverable_tax,
        concat_ws(' · ', nullif(v_line.provider_name, ''), nullif(v_line.document_number, '')),
        jsonb_build_object(
          'amount_basis', case when v_line.line_type in ('customs_duty','import_vat') or v_line.actual_net_clp <= 0 then 'gross' else 'net' end,
          'vat_amount_clp', v_line.actual_vat_clp,
          'gross_amount_clp', v_line.actual_total_clp,
          'source_original_amount', v_line.actual_amount_original,
          'source_currency', v_line.actual_currency,
          'source_exchange_rate_clp', v_line.actual_exchange_rate_clp,
          'implied_exchange_rate_clp', case
            when v_line.actual_currency <> 'CLP' and v_line.actual_amount_original > 0 and v_line.actual_exchange_rate_clp is null
              then round(v_line.actual_total_clp / v_line.actual_amount_original, 6)
            else null
          end,
          'converted_gross_amount_clp', v_converted_total,
          'conversion_variance_clp', case when v_converted_total is null then null else v_line.actual_total_clp - v_converted_total end,
          'reconciliation_id', v_reconciliation.id,
          'reconciliation_line_id', v_line.id,
          'line_type', v_line.line_type,
          'document_number', v_line.document_number,
          'source_page', v_line.source_page,
          'payment_scope', coalesce(v_line.metadata->>'payment_scope', 'agency'),
          'exclude_from_agency_reconciliation', not public.foreign_trade_is_agency_reconciliation_line(v_line.provider_name, v_line.metadata),
          'excluded_from_costing', false
        ), auth.uid(), auth.uid()
      ) returning id into v_cost_id;
      update public.foreign_trade_expense_reconciliation_lines
      set applied_cost_line_id = v_cost_id where id = v_line.id;
    else
      v_cost_id := v_line.applied_cost_line_id;
      update public.foreign_trade_cost_lines
      set category = v_line.cost_category,
          name = v_line.concept,
          amount_original = v_source_amount,
          currency = v_source_currency,
          exchange_rate_clp = v_source_rate,
          amount_clp = v_amount,
          source_type = 'real',
          recoverable_tax = v_line.recoverable_tax,
          notes = concat_ws(' · ', nullif(v_line.provider_name, ''), nullif(v_line.document_number, '')),
          metadata = metadata || jsonb_build_object(
            'amount_basis', case when v_line.line_type in ('customs_duty','import_vat') or v_line.actual_net_clp <= 0 then 'gross' else 'net' end,
            'vat_amount_clp', v_line.actual_vat_clp,
            'gross_amount_clp', v_line.actual_total_clp,
            'source_original_amount', v_line.actual_amount_original,
            'source_currency', v_line.actual_currency,
            'source_exchange_rate_clp', v_line.actual_exchange_rate_clp,
            'implied_exchange_rate_clp', case
              when v_line.actual_currency <> 'CLP' and v_line.actual_amount_original > 0 and v_line.actual_exchange_rate_clp is null
                then round(v_line.actual_total_clp / v_line.actual_amount_original, 6)
              else null
            end,
            'converted_gross_amount_clp', v_converted_total,
            'conversion_variance_clp', case when v_converted_total is null then null else v_line.actual_total_clp - v_converted_total end,
            'reconciliation_id', v_reconciliation.id,
            'reconciliation_line_id', v_line.id,
            'line_type', v_line.line_type,
            'document_number', v_line.document_number,
            'source_page', v_line.source_page,
            'payment_scope', coalesce(v_line.metadata->>'payment_scope', 'agency'),
            'exclude_from_agency_reconciliation', not public.foreign_trade_is_agency_reconciliation_line(v_line.provider_name, v_line.metadata),
            'excluded_from_costing', false
          ),
          updated_by = auth.uid()
      where id = v_cost_id and operation_id = v_reconciliation.operation_id;
    end if;
    v_applied := v_applied + 1;
  end loop;

  select
    coalesce(sum(actual_total_clp) filter (where public.foreign_trade_is_agency_reconciliation_line(provider_name, metadata)), 0),
    coalesce(sum(actual_total_clp) filter (where not public.foreign_trade_is_agency_reconciliation_line(provider_name, metadata)), 0)
  into v_actual_total, v_direct_total
  from public.foreign_trade_expense_reconciliation_lines
  where reconciliation_id = p_reconciliation_id;

  v_balance := v_reconciliation.remittance_amount_clp - v_actual_total;
  v_refund_due := greatest(v_balance - v_reconciliation.refund_received_clp, 0);

  update public.foreign_trade_expense_reconciliations
  set status = case
        when v_refund_due > 0 then 'refund_pending'
        when v_balance > 0 and refund_received_clp >= v_balance then 'settled'
        else 'applied'
      end,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'agency_reconciled_total_clp', v_actual_total,
        'direct_supplier_total_clp', v_direct_total,
        'payment_scope_version', 'direct_supplier_v1'
      ),
      applied_at = now(), applied_by = auth.uid(), updated_by = auth.uid()
  where id = p_reconciliation_id;

  return jsonb_build_object(
    'reconciliation_id', p_reconciliation_id,
    'applied_lines', v_applied,
    'actual_total_clp', v_actual_total,
    'direct_supplier_total_clp', v_direct_total,
    'balance_clp', v_balance,
    'refund_due_clp', v_refund_due
  );
end
$$;

create or replace function public.foreign_trade_mark_direct_supplier_payment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.metadata := coalesce(new.metadata, '{}'::jsonb);
  if not public.foreign_trade_is_agency_reconciliation_line(new.provider_name, new.metadata) then
    new.metadata := new.metadata || jsonb_build_object(
      'payment_scope', 'direct_supplier',
      'exclude_from_agency_reconciliation', true
    );
  elsif new.metadata->>'payment_scope' is null then
    new.metadata := new.metadata || jsonb_build_object(
      'payment_scope', 'agency',
      'exclude_from_agency_reconciliation', false
    );
  end if;
  return new;
end
$$;

drop trigger if exists mark_direct_supplier_payment_on_reconciliation_line
on public.foreign_trade_expense_reconciliation_lines;
create trigger mark_direct_supplier_payment_on_reconciliation_line
before insert or update of provider_name, metadata
on public.foreign_trade_expense_reconciliation_lines
for each row execute function public.foreign_trade_mark_direct_supplier_payment();

create or replace function public.foreign_trade_mark_direct_supplier_cost()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.metadata := coalesce(new.metadata, '{}'::jsonb);
  if not public.foreign_trade_is_agency_reconciliation_line(new.notes, new.metadata) then
    new.metadata := new.metadata || jsonb_build_object(
      'payment_scope', 'direct_supplier',
      'exclude_from_agency_reconciliation', true
    );
  end if;
  return new;
end
$$;

drop trigger if exists mark_direct_supplier_payment_on_cost_line
on public.foreign_trade_cost_lines;
create trigger mark_direct_supplier_payment_on_cost_line
before insert or update of notes, metadata
on public.foreign_trade_cost_lines
for each row execute function public.foreign_trade_mark_direct_supplier_cost();

-- Corrige los datos historicos sin quitar los costos de la importacion.
update public.foreign_trade_expense_reconciliation_lines
set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
  'payment_scope', 'direct_supplier',
  'exclude_from_agency_reconciliation', true,
  'payment_scope_migrated_at', now()
)
where not public.foreign_trade_is_agency_reconciliation_line(provider_name, metadata);

update public.foreign_trade_cost_lines
set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
  'payment_scope', 'direct_supplier',
  'exclude_from_agency_reconciliation', true,
  'payment_scope_migrated_at', now()
)
where not public.foreign_trade_is_agency_reconciliation_line(notes, metadata);

-- Recalcula el estado historico usando solo fondos efectivamente rendidos por
-- la agencia. Los pagos directos conservan sus costos y respaldos.
with agency_totals as (
  select
    r.id,
    r.remittance_amount_clp,
    r.refund_received_clp,
    coalesce(sum(l.actual_total_clp) filter (
      where public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)
    ), 0) as actual_total_clp,
    coalesce(sum(l.actual_total_clp) filter (
      where not public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)
    ), 0) as direct_total_clp
  from public.foreign_trade_expense_reconciliations r
  join public.foreign_trade_expense_reconciliation_lines l on l.reconciliation_id = r.id
  group by r.id, r.remittance_amount_clp, r.refund_received_clp
)
update public.foreign_trade_expense_reconciliations r
set status = case
      when greatest(t.remittance_amount_clp - t.actual_total_clp - t.refund_received_clp, 0) > 0 then 'refund_pending'
      when t.remittance_amount_clp - t.actual_total_clp > 0
        and t.refund_received_clp >= t.remittance_amount_clp - t.actual_total_clp then 'settled'
      else case when r.status = 'settled' then 'settled' else 'applied' end
    end,
    metadata = coalesce(r.metadata, '{}'::jsonb) || jsonb_build_object(
      'agency_reconciled_total_clp', t.actual_total_clp,
      'direct_supplier_total_clp', t.direct_total_clp,
      'payment_scope_version', 'direct_supplier_v1'
    ),
    updated_by = coalesce(auth.uid(), r.updated_by)
from agency_totals t
where r.id = t.id and t.direct_total_clp > 0;

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
      'lines', coalesce((
        select jsonb_agg(to_jsonb(l) order by l.position, l.created_at)
        from public.foreign_trade_expense_reconciliation_lines l
        where l.reconciliation_id = r.id
      ), '[]'::jsonb),
      'totals', jsonb_build_object(
        'provision_expenses_clp', coalesce((select sum(l.provision_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and l.line_type not in ('customs_duty','import_vat') and public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)), 0),
        'actual_expenses_clp', coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and l.line_type not in ('customs_duty','import_vat') and public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)), 0),
        'provision_taxes_clp', coalesce((select sum(l.provision_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and l.line_type in ('customs_duty','import_vat') and public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)), 0),
        'actual_taxes_clp', coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and l.line_type in ('customs_duty','import_vat') and public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)), 0),
        'provision_total_clp', coalesce((select sum(l.provision_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)), 0),
        'actual_total_clp', coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)), 0),
        'direct_supplier_total_clp', coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and not public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)), 0),
        'balance_clp', r.remittance_amount_clp - coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)), 0),
        'refund_due_clp', greatest(r.remittance_amount_clp - coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)), 0) - r.refund_received_clp, 0),
        'additional_payment_clp', greatest(coalesce((select sum(l.actual_total_clp) from public.foreign_trade_expense_reconciliation_lines l where l.reconciliation_id = r.id and public.foreign_trade_is_agency_reconciliation_line(l.provider_name, l.metadata)), 0) - r.remittance_amount_clp, 0)
      )
    ) order by r.created_at desc
  ), '[]'::jsonb) into v_result
  from public.foreign_trade_expense_reconciliations r
  where r.operation_id = p_operation_id;

  return v_result;
end
$$;

revoke all on function public.foreign_trade_is_agency_reconciliation_line(text,jsonb) from public;
grant execute on function public.foreign_trade_is_agency_reconciliation_line(text,jsonb) to authenticated, service_role;

comment on function public.foreign_trade_is_agency_reconciliation_line(text,jsonb) is
  'Distingue costos rendidos por la agencia de pagos directos a proveedores logisticos.';
comment on function public.apply_foreign_trade_expense_reconciliation(uuid) is
  'Aplica todos los costos reales, pero calcula saldo y devolucion solo con pagos rendidos por la agencia.';

commit;
