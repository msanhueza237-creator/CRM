begin;

create table if not exists public.accounting_bank_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  bank_account_id uuid not null references public.accounting_bank_accounts(id) on delete restrict,
  as_of_date date not null,
  balance numeric(20,4) not null check (balance >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(20,8) not null default 1 check (exchange_rate > 0),
  balance_clp numeric(20,4) not null check (balance_clp >= 0),
  source_type text not null default 'MANUAL' check (source_type in ('MANUAL','EXCEL','BANK_STATEMENT','SYSTEM')),
  source_reference text not null,
  status text not null default 'verified' check (status in ('verified','superseded','rejected')),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bank_account_id, as_of_date, source_reference)
);

create index if not exists accounting_bank_balance_snapshots_latest_idx
  on public.accounting_bank_balance_snapshots(entity_id, bank_account_id, as_of_date desc, created_at desc)
  where status = 'verified';

alter table public.accounting_bank_balance_snapshots enable row level security;

drop policy if exists accounting_read on public.accounting_bank_balance_snapshots;
create policy accounting_read on public.accounting_bank_balance_snapshots
  for select to authenticated
  using (public.accounting_has_permission('accounting.dashboard.view'));

drop policy if exists accounting_service on public.accounting_bank_balance_snapshots;
create policy accounting_service on public.accounting_bank_balance_snapshots
  for all to service_role using (true) with check (true);

grant select on public.accounting_bank_balance_snapshots to authenticated;
grant all on public.accounting_bank_balance_snapshots to service_role;

comment on table public.accounting_bank_balance_snapshots is
  'Saldos externos verificados para control de tesorería. No generan ingresos, gastos ni asientos por sí solos.';

do $$
declare
  v_entity_id uuid;
begin
  select id into v_entity_id
  from public.accounting_entities
  where tax_id = '77.724.382-9'
  limit 1;

  if v_entity_id is null then
    raise exception 'No se encontró la entidad contable 77.724.382-9.';
  end if;

  insert into public.accounting_accounts (
    entity_id, code, name, account_type, normal_balance, currency,
    classification, allows_posting, active, source_type, metadata
  ) values
    (
      v_entity_id, '1.1.92', 'Diferencias bancarias pendientes de respaldo',
      'asset', 'debit', 'CLP', 'bank_balance_pending_asset', true, true, 'SYSTEM',
      jsonb_build_object(
        'purpose', 'bank_statement_control',
        'warning', 'No representa disponibilidad ni gasto; debe depurarse con cartolas y comprobantes.'
      )
    ),
    (
      v_entity_id, '2.1.92', 'Abonos bancarios pendientes de respaldo',
      'liability', 'credit', 'CLP', 'bank_balance_pending_liability', true, true, 'SYSTEM',
      jsonb_build_object(
        'purpose', 'bank_statement_control',
        'warning', 'No representa ingreso; debe depurarse con cartolas y comprobantes.'
      )
    )
  on conflict (entity_id, code) do update set
    name = excluded.name,
    account_type = excluded.account_type,
    normal_balance = excluded.normal_balance,
    currency = excluded.currency,
    classification = excluded.classification,
    allows_posting = true,
    active = true,
    updated_at = now();
end
$$;

do $$
declare
  c_batch_id constant uuid := '9d728e71-b1a2-414d-b1b6-ebdbadb1442d';
  v_entity_id uuid;
  v_duplicate_count integer;
  v_reversed_receivables jsonb := '{}'::jsonb;
  v_reversed_payables jsonb := '{}'::jsonb;
begin
  select id into v_entity_id
  from public.accounting_entities
  where tax_id = '77.724.382-9'
  limit 1;

  if not exists (select 1 from public.accounting_import_batches where id = c_batch_id) then
    return;
  end if;

  create temporary table if not exists _accounting_semantic_duplicates (
    transaction_id uuid primary key,
    canonical_transaction_id uuid not null
  ) on commit drop;
  truncate _accounting_semantic_duplicates;

  insert into _accounting_semantic_duplicates(transaction_id, canonical_transaction_id)
  with imported as (
    select
      t.id,
      t.transaction_date,
      t.currency,
      t.amount,
      lower(regexp_replace(trim(t.description), '\s+', ' ', 'g')) as normalized_description,
      row_number() over (
        partition by t.transaction_date, t.currency, t.amount,
          lower(regexp_replace(trim(t.description), '\s+', ' ', 'g'))
        order by ir.row_number, t.id
      ) as occurrence
    from public.accounting_bank_transactions t
    left join public.accounting_import_rows ir on ir.id = t.source_row_id
    where t.import_batch_id = c_batch_id
  ),
  canonical as (
    select
      t.id,
      t.transaction_date,
      t.currency,
      t.amount,
      lower(regexp_replace(trim(t.description), '\s+', ' ', 'g')) as normalized_description,
      row_number() over (
        partition by t.transaction_date, t.currency, t.amount,
          lower(regexp_replace(trim(t.description), '\s+', ' ', 'g'))
        order by t.created_at, t.id
      ) as occurrence
    from public.accounting_bank_transactions t
    join public.accounting_bank_accounts ba on ba.id = t.bank_account_id
    where t.entity_id = v_entity_id
      and t.import_batch_id is distinct from c_batch_id
      and ba.institution = 'Scotiabank'
      and t.transaction_date between date '2026-08-01' and date '2026-08-31'
      and t.reconciliation_status <> 'ignored'
  )
  select i.id, c.id
  from imported i
  join canonical c
    on c.transaction_date = i.transaction_date
   and c.currency = i.currency
   and c.amount = i.amount
   and c.normalized_description = i.normalized_description
   and c.occurrence = i.occurrence;

  select count(*) into v_duplicate_count from _accounting_semantic_duplicates;
  if v_duplicate_count <> 39 then
    raise exception 'Se esperaban 39 duplicados semánticos en la cartola Scotiabank del 01-09-2026, se detectaron %.', v_duplicate_count;
  end if;

  select coalesce(jsonb_object_agg(receivable_id::text, reversed_amount), '{}'::jsonb)
  into v_reversed_receivables
  from (
    select ra.receivable_id, sum(ra.amount_clp) as reversed_amount
    from public.accounting_receivable_allocations ra
    join _accounting_semantic_duplicates d on d.transaction_id = ra.bank_transaction_id
    where ra.status = 'confirmed'
    group by ra.receivable_id
  ) x;

  select coalesce(jsonb_object_agg(payable_id::text, reversed_amount), '{}'::jsonb)
  into v_reversed_payables
  from (
    select pa.payable_id, sum(pa.amount_clp) as reversed_amount
    from public.accounting_payable_allocations pa
    join _accounting_semantic_duplicates d on d.transaction_id = pa.bank_transaction_id
    where pa.status = 'confirmed'
    group by pa.payable_id
  ) x;

  update public.accounting_receivable_allocations ra
  set status = 'reversed'
  from _accounting_semantic_duplicates d
  where d.transaction_id = ra.bank_transaction_id
    and ra.status = 'confirmed';

  update public.accounting_payable_allocations pa
  set status = 'reversed'
  from _accounting_semantic_duplicates d
  where d.transaction_id = pa.bank_transaction_id
    and pa.status = 'confirmed';

  update public.accounting_receivables r
  set
    paid_amount_clp = greatest(r.paid_amount_clp - (value::text)::numeric, 0),
    status = case
      when greatest(r.paid_amount_clp - (value::text)::numeric, 0) <= 0.005
        then case when r.due_on is not null and r.due_on < current_date then 'overdue' else 'pending' end
      when greatest(r.paid_amount_clp - (value::text)::numeric, 0) >= r.original_amount_clp - 0.005 then 'paid'
      else 'partial'
    end,
    updated_at = now()
  from jsonb_each(v_reversed_receivables)
  where r.id = key::uuid;

  update public.accounting_payables p
  set
    paid_amount_clp = greatest(p.paid_amount_clp - (value::text)::numeric, 0),
    status = case
      when greatest(p.paid_amount_clp - (value::text)::numeric, 0) <= 0.005
        then case when p.due_on is not null and p.due_on < current_date then 'overdue' else 'pending' end
      when greatest(p.paid_amount_clp - (value::text)::numeric, 0) >= p.original_amount_clp - 0.005 then 'paid'
      else 'partial'
    end,
    updated_at = now()
  from jsonb_each(v_reversed_payables)
  where p.id = key::uuid;

  update public.accounting_reconciliations r
  set status = 'reversed', updated_at = now()
  from _accounting_semantic_duplicates d
  where d.transaction_id = r.bank_transaction_id
    and r.status <> 'reversed';

  update public.accounting_bank_transactions t
  set
    reconciliation_status = 'ignored',
    metadata = coalesce(t.metadata, '{}'::jsonb) || jsonb_build_object(
      'duplicate_of', d.canonical_transaction_id,
      'duplicate_reason', 'semantic_reimport_without_operation_number',
      'duplicate_corrected_at', now()
    ),
    updated_at = now()
  from _accounting_semantic_duplicates d
  where t.id = d.transaction_id;

  update public.accounting_import_rows ir
  set status = 'duplicate'
  from public.accounting_bank_transactions t
  join _accounting_semantic_duplicates d on d.transaction_id = t.id
  where ir.id = t.source_row_id;

  update public.accounting_import_batches
  set
    row_count = 43,
    new_count = 4,
    duplicate_count = 39,
    error_count = 0,
    summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object(
      'total', 43,
      'new', 4,
      'duplicates', 39,
      'errors', 0,
      'duplicate_correction', 'semantic_reimport_without_operation_number',
      'corrected_at', now()
    ),
    updated_at = now()
  where id = c_batch_id;

  if not exists (
    select 1 from public.accounting_audit_events
    where action = 'bank.import_semantic_duplicates_corrected'
      and entity_id_text = c_batch_id::text
  ) then
    insert into public.accounting_audit_events (
      entity_id, action, entity_type, entity_id_text, reason, previous_value, new_value
    ) values (
      v_entity_id,
      'bank.import_semantic_duplicates_corrected',
      'import_batch',
      c_batch_id::text,
      'Se conservó la evidencia y se excluyeron 39 movimientos repetidos de la cartola Scotiabank cargada el 01-09-2026.',
      jsonb_build_object('new_count', 43, 'duplicate_count', 0),
      jsonb_build_object(
        'new_count', 4,
        'duplicate_count', 39,
        'reversed_receivable_allocations', v_reversed_receivables,
        'reversed_payable_allocations', v_reversed_payables
      )
    );
  end if;
end
$$;

do $$
declare
  c_batch_id constant uuid := '9d728e71-b1a2-414d-b1b6-ebdbadb1442d';
  v_entity_id uuid;
  v_period_id uuid;
  v_payroll_account_id uuid;
  v_suspense_asset_id uuid;
  v_suspense_liability_id uuid;
  v_pending_asset_id uuid;
  v_pending_liability_id uuid;
  v_bank_ledger_id uuid;
  v_entry_id uuid;
  v_transaction record;
  v_difference numeric(20,4);
  v_ledger_balance numeric(20,4);
begin
  select id into v_entity_id
  from public.accounting_entities
  where tax_id = '77.724.382-9'
  limit 1;

  select id into v_period_id
  from public.accounting_periods
  where entity_id = v_entity_id
    and date '2026-08-31' between starts_on and ends_on
    and status <> 'closed'
  limit 1;

  select id into v_payroll_account_id from public.accounting_accounts where entity_id = v_entity_id and classification = 'payroll_expense' and active and allows_posting limit 1;
  select id into v_suspense_asset_id from public.accounting_accounts where entity_id = v_entity_id and classification = 'suspense_asset' and active and allows_posting limit 1;
  select id into v_suspense_liability_id from public.accounting_accounts where entity_id = v_entity_id and classification = 'suspense_liability' and active and allows_posting limit 1;
  select id into v_pending_asset_id from public.accounting_accounts where entity_id = v_entity_id and classification = 'bank_balance_pending_asset' and active and allows_posting limit 1;
  select id into v_pending_liability_id from public.accounting_accounts where entity_id = v_entity_id and classification = 'bank_balance_pending_liability' and active and allows_posting limit 1;
  select id into v_bank_ledger_id from public.accounting_accounts where entity_id = v_entity_id and code = '1.1.02' and active and allows_posting limit 1;

  if v_period_id is null or v_payroll_account_id is null or v_suspense_asset_id is null
     or v_suspense_liability_id is null or v_bank_ledger_id is null
     or v_pending_asset_id is null or v_pending_liability_id is null then
    raise exception 'Faltan período o cuentas para canalizar la cartola Scotiabank de agosto 2026.';
  end if;

  for v_transaction in
    select t.*
    from public.accounting_bank_transactions t
    where t.import_batch_id = c_batch_id
      and t.reconciliation_status <> 'ignored'
    order by t.transaction_date, t.created_at, t.id
  loop
    if not exists (
      select 1 from public.accounting_journal_entries
      where entity_id = v_entity_id
        and idempotency_key = 'bank-transaction:' || v_transaction.id::text
    ) then
      insert into public.accounting_journal_entries (
        entity_id, period_id, entry_date, description, reference, source_type,
        source_module, idempotency_key, currency, exchange_rate, status
      ) values (
        v_entity_id,
        v_period_id,
        v_transaction.transaction_date,
        'Movimiento bancario pendiente: ' || v_transaction.description,
        coalesce(nullif(v_transaction.operation_number, ''), nullif(v_transaction.reference, ''), v_transaction.id::text),
        'SCOTIABANK',
        'bank_statement_import',
        'bank-transaction:' || v_transaction.id::text,
        v_transaction.currency,
        v_transaction.exchange_rate,
        'validated'
      ) returning id into v_entry_id;

      if v_transaction.amount_clp > 0 then
        insert into public.accounting_journal_lines (
          entry_id, line_number, account_id, description, debit_clp, credit_clp,
          original_amount, currency, exchange_rate, metadata
        ) values
          (
            v_entry_id, 1, v_bank_ledger_id, 'Ingreso bancario pendiente de clasificar',
            abs(v_transaction.amount_clp), 0, abs(v_transaction.amount), v_transaction.currency, v_transaction.exchange_rate,
            jsonb_build_object('bank_transaction_id', v_transaction.id, 'import_batch_id', c_batch_id, 'bank_description', v_transaction.description)
          ),
          (
            v_entry_id, 2, v_suspense_liability_id, 'Contrapartida transitoria de ingreso bancario',
            0, abs(v_transaction.amount_clp), abs(v_transaction.amount), v_transaction.currency, v_transaction.exchange_rate,
            jsonb_build_object('bank_transaction_id', v_transaction.id, 'import_batch_id', c_batch_id, 'bank_description', v_transaction.description)
          );
      else
        insert into public.accounting_journal_lines (
          entry_id, line_number, account_id, description, debit_clp, credit_clp,
          original_amount, currency, exchange_rate, metadata
        ) values
          (
            v_entry_id, 1, v_suspense_asset_id, 'Contrapartida transitoria de egreso bancario',
            abs(v_transaction.amount_clp), 0, abs(v_transaction.amount), v_transaction.currency, v_transaction.exchange_rate,
            jsonb_build_object('bank_transaction_id', v_transaction.id, 'import_batch_id', c_batch_id, 'bank_description', v_transaction.description)
          ),
          (
            v_entry_id, 2, v_bank_ledger_id, 'Egreso bancario pendiente de clasificar',
            0, abs(v_transaction.amount_clp), abs(v_transaction.amount), v_transaction.currency, v_transaction.exchange_rate,
            jsonb_build_object('bank_transaction_id', v_transaction.id, 'import_batch_id', c_batch_id, 'bank_description', v_transaction.description)
          );
      end if;

      perform public.accounting_post_journal_entry(v_entry_id);
    end if;

    if v_transaction.id = 'b906ac74-21c4-4c79-8b79-461ea67a0dc4'::uuid
       and not exists (
         select 1 from public.accounting_journal_entries
         where entity_id = v_entity_id
           and idempotency_key = 'bank-payroll-known-employee:' || v_transaction.id::text
       ) then
      insert into public.accounting_journal_entries (
        entity_id, period_id, entry_date, description, reference, source_type,
        source_module, idempotency_key, currency, exchange_rate, status
      ) values (
        v_entity_id,
        v_period_id,
        v_transaction.transaction_date,
        'Pago de remuneración confirmado: Sisla Muñoz',
        coalesce(nullif(v_transaction.operation_number, ''), nullif(v_transaction.reference, ''), v_transaction.id::text),
        'SYSTEM',
        'bank_payroll_rule',
        'bank-payroll-known-employee:' || v_transaction.id::text,
        'CLP',
        1,
        'validated'
      ) returning id into v_entry_id;

      insert into public.accounting_journal_lines (
        entry_id, line_number, account_id, description, debit_clp, credit_clp,
        original_amount, currency, exchange_rate, metadata
      ) values
        (
          v_entry_id, 1, v_payroll_account_id, 'Remuneración pagada a Sisla Muñoz',
          650000, 0, 650000, 'CLP', 1,
          jsonb_build_object(
            'bank_transaction_id', v_transaction.id,
            'bank_account_id', v_transaction.bank_account_id,
            'employee_key', 'sisla_munoz',
            'employee_name', 'Sisla Muñoz',
            'employee_tax_id', '14.186.473-4',
            'operation_number', v_transaction.operation_number,
            'bank_description', v_transaction.description,
            'classification', 'payroll_expense'
          )
        ),
        (
          v_entry_id, 2, v_suspense_asset_id, 'Liberación de egreso bancario transitorio',
          0, 650000, 650000, 'CLP', 1,
          jsonb_build_object(
            'bank_transaction_id', v_transaction.id,
            'bank_account_id', v_transaction.bank_account_id,
            'employee_key', 'sisla_munoz',
            'employee_name', 'Sisla Muñoz',
            'employee_tax_id', '14.186.473-4',
            'operation_number', v_transaction.operation_number,
            'bank_description', v_transaction.description,
            'classification', 'suspense_release'
          )
        );

      perform public.accounting_post_journal_entry(v_entry_id);

      update public.accounting_bank_transactions
      set
        reconciliation_status = 'matched',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'verified_classification', 'payroll_sisla',
          'classification_locked', true,
          'classification_policy', 'management_approved_known_employee',
          'employee_key', 'sisla_munoz',
          'employee_name', 'Sisla Muñoz',
          'employee_tax_id', '14.186.473-4',
          'payroll_expense_clp', 650000,
          'classified_at', now()
        ),
        updated_at = now()
      where id = v_transaction.id;
    end if;
  end loop;

  select coalesce(sum(l.debit_clp - l.credit_clp), 0)
  into v_ledger_balance
  from public.accounting_journal_lines l
  join public.accounting_journal_entries e on e.id = l.entry_id
  where e.entity_id = v_entity_id
    and e.status in ('posted','reversed')
    and l.account_id = v_bank_ledger_id;

  v_difference := 1632382 - v_ledger_balance;
  if abs(v_difference) >= 0.5
     and not exists (
       select 1 from public.accounting_journal_entries
       where entity_id = v_entity_id
         and idempotency_key = 'bank-statement-balance:v3:scotiabank:2026-08-31:1632382'
     ) then
    insert into public.accounting_journal_entries (
      entity_id, period_id, entry_date, description, reference, source_type,
      source_module, idempotency_key, currency, exchange_rate, status
    ) values (
      v_entity_id,
      v_period_id,
      date '2026-08-31',
      'Control de saldo contra cartola Scotiabank agosto 2026',
      'SALDO-CARTOLA-31-08-2026',
      'SCOTIABANK',
      'bank_statement_control',
      'bank-statement-balance:v3:scotiabank:2026-08-31:1632382',
      'CLP',
      1,
      'validated'
    ) returning id into v_entry_id;

    if v_difference > 0 then
      insert into public.accounting_journal_lines (
        entry_id, line_number, account_id, description, debit_clp, credit_clp, currency, exchange_rate, metadata
      ) values
        (v_entry_id, 1, v_bank_ledger_id, 'Control contra saldo final de cartola', v_difference, 0, 'CLP', 1,
          jsonb_build_object('statement_balance_clp', 1632382, 'previous_ledger_balance_clp', v_ledger_balance, 'as_of_date', '2026-08-31')),
        (v_entry_id, 2, v_pending_liability_id, 'Abono bancario pendiente de identificar', 0, v_difference, 'CLP', 1,
          jsonb_build_object('statement_balance_clp', 1632382, 'previous_ledger_balance_clp', v_ledger_balance, 'as_of_date', '2026-08-31'));
    else
      insert into public.accounting_journal_lines (
        entry_id, line_number, account_id, description, debit_clp, credit_clp, currency, exchange_rate, metadata
      ) values
        (v_entry_id, 1, v_pending_asset_id, 'Cargo bancario pendiente de identificar', abs(v_difference), 0, 'CLP', 1,
          jsonb_build_object('statement_balance_clp', 1632382, 'previous_ledger_balance_clp', v_ledger_balance, 'as_of_date', '2026-08-31')),
        (v_entry_id, 2, v_bank_ledger_id, 'Control contra saldo final de cartola', 0, abs(v_difference), 'CLP', 1,
          jsonb_build_object('statement_balance_clp', 1632382, 'previous_ledger_balance_clp', v_ledger_balance, 'as_of_date', '2026-08-31'));
    end if;

    perform public.accounting_post_journal_entry(v_entry_id);
  end if;

  if not exists (
    select 1 from public.accounting_audit_events
    where action = 'bank.scotiabank_august_channelled'
      and entity_id_text = c_batch_id::text
  ) then
    insert into public.accounting_audit_events (
      entity_id, action, entity_type, entity_id_text, reason, new_value
    ) values (
      v_entity_id,
      'bank.scotiabank_august_channelled',
      'import_batch',
      c_batch_id::text,
      'Se contabilizaron cuatro movimientos nuevos y el sueldo de Sisla Muñoz quedó identificado con su respaldo bancario.',
      jsonb_build_object(
        'new_transactions', 4,
        'payroll_employee', 'Sisla Muñoz',
        'payroll_tax_id', '14.186.473-4',
        'payroll_amount_clp', 650000,
        'statement_balance_2026_08_31_clp', 1632382
      )
    );
  end if;
end
$$;

do $$
declare
  v_entity_id uuid;
  v_scotiabank_id uuid;
  v_banco_estado_id uuid;
begin
  select id into v_entity_id
  from public.accounting_entities
  where tax_id = '77.724.382-9'
  limit 1;

  select ba.id into v_scotiabank_id
  from public.accounting_bank_accounts ba
  where ba.entity_id = v_entity_id
    and ba.institution = 'Scotiabank'
    and ba.currency = 'CLP'
    and ba.account_number_masked = '985659206'
  order by ba.created_at desc
  limit 1;

  select ba.id into v_banco_estado_id
  from public.accounting_bank_accounts ba
  where ba.entity_id = v_entity_id
    and ba.institution = 'BancoEstado'
    and ba.currency = 'CLP'
    and ba.active
  order by (
    select count(*) from public.accounting_bank_transactions t where t.bank_account_id = ba.id
  ) desc, ba.created_at
  limit 1;

  if v_scotiabank_id is null or v_banco_estado_id is null then
    raise exception 'No se encontraron las cuentas bancarias para registrar los saldos verificados.';
  end if;

  insert into public.accounting_bank_balance_snapshots (
    entity_id, bank_account_id, as_of_date, balance, currency, exchange_rate,
    balance_clp, source_type, source_reference, status, notes
  ) values
    (
      v_entity_id, v_scotiabank_id, date '2026-09-03', 7733234, 'CLP', 1,
      7733234, 'MANUAL', 'Saldo confirmado por Gerencia 03-09-2026', 'verified',
      'Saldo disponible actual. Los movimientos de septiembre que explican la diferencia con el Libro Mayor permanecen pendientes de importar.'
    ),
    (
      v_entity_id, v_banco_estado_id, date '2026-09-03', 476138, 'CLP', 1,
      476138, 'EXCEL', 'Cartola BancoEstado agosto 2026', 'verified',
      'Saldo disponible informado en la planilla de agosto 2026; debe coincidir al importar sus movimientos.'
    )
  on conflict (bank_account_id, as_of_date, source_reference) do update set
    balance = excluded.balance,
    exchange_rate = excluded.exchange_rate,
    balance_clp = excluded.balance_clp,
    source_type = excluded.source_type,
    status = excluded.status,
    notes = excluded.notes,
    updated_at = now();

  update public.accounting_bank_accounts
  set active = false, updated_at = now()
  where entity_id = v_entity_id
    and active
    and account_number_masked ilike '%pendiente cartola%'
    and not exists (
      select 1 from public.accounting_bank_transactions t
      where t.bank_account_id = accounting_bank_accounts.id
    );
end
$$;

select public.accounting_refresh_controls(id)
from public.accounting_entities
where tax_id = '77.724.382-9';

commit;
