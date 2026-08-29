-- Finanzas - respaldos Excel de Facto, saldos operativos y eventos de pago.
-- Los eventos de pago no son cartolas ni asientos; quedan pendientes de conciliacion bancaria.

alter table public.accounting_receivables
  add column if not exists reported_paid_amount_clp numeric(20,4)
    check (reported_paid_amount_clp is null or reported_paid_amount_clp >= 0),
  add column if not exists reported_balance_clp numeric(20,4)
    check (reported_balance_clp is null or reported_balance_clp >= 0),
  add column if not exists reported_at timestamptz,
  add column if not exists reported_source_batch_id uuid
    references public.accounting_import_batches(id) on delete set null;

alter table public.accounting_payables
  add column if not exists reported_paid_amount_clp numeric(20,4)
    check (reported_paid_amount_clp is null or reported_paid_amount_clp >= 0),
  add column if not exists reported_balance_clp numeric(20,4)
    check (reported_balance_clp is null or reported_balance_clp >= 0),
  add column if not exists reported_at timestamptz,
  add column if not exists reported_source_batch_id uuid
    references public.accounting_import_batches(id) on delete set null;

alter table public.accounting_checks
  add column if not exists source_row_id uuid
    references public.accounting_import_rows(id) on delete set null,
  add column if not exists settlement_bank_account_id uuid
    references public.accounting_bank_accounts(id) on delete set null,
  add column if not exists source_status text,
  add column if not exists metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object');

create table if not exists public.accounting_payment_events (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  source_document_id uuid references public.accounting_source_documents(id) on delete set null,
  receivable_id uuid references public.accounting_receivables(id) on delete set null,
  payable_id uuid references public.accounting_payables(id) on delete set null,
  import_batch_id uuid not null references public.accounting_import_batches(id) on delete restrict,
  source_row_id uuid not null references public.accounting_import_rows(id) on delete restrict,
  expected_bank_account_id uuid references public.accounting_bank_accounts(id) on delete set null,
  event_date date not null,
  event_time time,
  direction text not null check (direction in ('receipt','payment','adjustment')),
  document_type text,
  document_number text,
  payment_method text,
  responsible text,
  amount_clp numeric(20,4) not null check (amount_clp > 0),
  signed_amount_clp numeric(20,4) not null,
  source_profile text not null,
  fingerprint text not null,
  matching_status text not null default 'unmatched'
    check (matching_status in ('unmatched','linked','suggested','reconciled','ignored')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, fingerprint)
);

create index if not exists accounting_payment_events_date_idx
  on public.accounting_payment_events(entity_id, event_date desc);
create index if not exists accounting_payment_events_document_idx
  on public.accounting_payment_events(entity_id, document_type, document_number);
create index if not exists accounting_payment_events_matching_idx
  on public.accounting_payment_events(entity_id, matching_status, event_date);
create index if not exists accounting_checks_settlement_idx
  on public.accounting_checks(entity_id, settlement_bank_account_id, status, due_on);

alter table public.accounting_payment_events enable row level security;
drop policy if exists accounting_read on public.accounting_payment_events;
create policy accounting_read on public.accounting_payment_events for select to authenticated
  using (public.accounting_has_permission('accounting.dashboard.view'));
drop policy if exists accounting_service on public.accounting_payment_events;
create policy accounting_service on public.accounting_payment_events for all to service_role
  using (true) with check (true);

grant select on public.accounting_payment_events to authenticated;
grant all on public.accounting_payment_events to service_role;

create or replace function public.accounting_dashboard_summary(p_entity_id uuid, p_as_of date default current_date)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select case when auth.role()='service_role' or public.accounting_has_permission('accounting.dashboard.view') then jsonb_build_object(
    'as_of', p_as_of,
    'bank_clp', coalesce((select sum(case when a.normal_balance='debit' then l.debit_clp-l.credit_clp else l.credit_clp-l.debit_clp end)
      from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id=l.entry_id
      join public.accounting_accounts a on a.id=l.account_id
      where e.entity_id=p_entity_id and e.status in ('posted','reversed') and e.entry_date<=p_as_of
        and a.classification in ('cash','bank_clp','payment_processor')),0),
    'bank_usd_clp', coalesce((select sum(l.debit_clp-l.credit_clp)
      from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id=l.entry_id
      join public.accounting_accounts a on a.id=l.account_id
      where e.entity_id=p_entity_id and e.status in ('posted','reversed') and e.entry_date<=p_as_of
        and a.classification='bank_usd'),0),
    'receivables', coalesce((select sum(coalesce(reported_balance_clp,balance_clp))
      from public.accounting_receivables where entity_id=p_entity_id and status not in ('written_off')),0),
    'receivables_confirmed', coalesce((select sum(balance_clp)
      from public.accounting_receivables where entity_id=p_entity_id and status not in ('written_off')),0),
    'receivables_overdue', coalesce((select sum(coalesce(reported_balance_clp,balance_clp))
      from public.accounting_receivables where entity_id=p_entity_id and status not in ('written_off') and due_on < p_as_of),0),
    'payables', coalesce((select sum(coalesce(reported_balance_clp,balance_clp))
      from public.accounting_payables where entity_id=p_entity_id and status <> 'voided'),0),
    'payables_confirmed', coalesce((select sum(balance_clp)
      from public.accounting_payables where entity_id=p_entity_id and status <> 'voided'),0),
    'payables_overdue', coalesce((select sum(coalesce(reported_balance_clp,balance_clp))
      from public.accounting_payables where entity_id=p_entity_id and status <> 'voided' and due_on < p_as_of),0),
    'checks_portfolio', coalesce((select sum(amount_clp) from public.accounting_checks
      where entity_id=p_entity_id and status='portfolio'),0),
    'unmatched_bank', (select count(*) from public.accounting_bank_transactions
      where entity_id=p_entity_id and reconciliation_status='unmatched'),
    'payment_events_pending', (select count(*) from public.accounting_payment_events
      where entity_id=p_entity_id and matching_status in ('unmatched','linked','suggested')),
    'open_controls', (select count(*) from public.accounting_control_findings
      where entity_id=p_entity_id and status='open' and severity<>'ok'),
    'pending_entries', (select count(*) from public.accounting_journal_entries
      where entity_id=p_entity_id and status in ('draft','suggested','pending_review','validated')),
    'provisional', exists(select 1 from public.accounting_periods
      where entity_id=p_entity_id and p_as_of between starts_on and ends_on and status<>'closed')
  ) else '{}'::jsonb end
$$;

revoke all on function public.accounting_dashboard_summary(uuid,date) from public;
grant execute on function public.accounting_dashboard_summary(uuid,date) to authenticated, service_role;

comment on table public.accounting_payment_events is
  'Eventos de pago informados por Facto/Excel; no equivalen a movimientos bancarios ni asientos hasta su conciliacion.';
comment on column public.accounting_receivables.reported_balance_clp is
  'Saldo operativo informado por Facto, pendiente de confirmacion bancaria cuando corresponda.';
comment on column public.accounting_checks.settlement_bank_account_id is
  'Cuenta donde se espera ver el deposito/cobro; puede diferir del banco emisor del cheque.';
