-- Clima Activa CRM - Centro de Finanzas y Contabilidad
-- Ejecutar despues de schema.sql, agent_hub.sql y foreign_trade_center.sql.
--
-- Este modulo consolida fuentes externas sin escribir de vuelta en Facto.
-- Los importes contables usan CLP como moneda funcional y conservan siempre
-- el monto, moneda y tipo de cambio originales.

alter type public.app_role add value if not exists 'finanzas';

-- PostgreSQL no permite usar un valor nuevo de un enum hasta confirmar la
-- transaccion que lo creo. Supabase Studio puede ejecutar el archivo completo
-- en una sola sesion, por lo que esta confirmacion debe ser explicita antes de
-- insertar los permisos del rol finanzas.
commit;

begin;

create extension if not exists pgcrypto;

create table if not exists public.accounting_role_permissions (
  role public.app_role not null,
  permission text not null check (permission in (
    'accounting.dashboard.view',
    'accounting.ledger.view',
    'accounting.import',
    'accounting.reconcile',
    'accounting.payments.manage',
    'accounting.entry.create',
    'accounting.entry.post',
    'accounting.period.close',
    'accounting.profitability.view',
    'accounting.config.manage',
    'accounting.audit.view'
  )),
  allowed boolean not null default true,
  primary key (role, permission)
);

insert into public.accounting_role_permissions(role, permission, allowed)
select 'administrador'::public.app_role, permission, true
from unnest(array[
  'accounting.dashboard.view','accounting.ledger.view','accounting.import',
  'accounting.reconcile','accounting.payments.manage','accounting.entry.create',
  'accounting.entry.post','accounting.period.close','accounting.profitability.view',
  'accounting.config.manage','accounting.audit.view'
]) permission
on conflict (role, permission) do update set allowed = excluded.allowed;

insert into public.accounting_role_permissions(role, permission, allowed)
select 'finanzas'::public.app_role, permission, true
from unnest(array[
  'accounting.dashboard.view','accounting.ledger.view','accounting.import',
  'accounting.reconcile','accounting.payments.manage','accounting.entry.create',
  'accounting.entry.post','accounting.profitability.view','accounting.audit.view'
]) permission
on conflict (role, permission) do update set allowed = excluded.allowed;

create or replace function public.accounting_has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.accounting_role_permissions rp
    where rp.role = public.current_role()
      and rp.permission = p_permission
      and rp.allowed
  )
$$;

create table if not exists public.accounting_entities (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  tax_id text not null unique,
  functional_currency text not null default 'CLP' check (functional_currency ~ '^[A-Z]{3}$'),
  fiscal_year_start_month smallint not null default 1 check (fiscal_year_start_month between 1 and 12),
  active boolean not null default true,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.accounting_entities(legal_name, tax_id, functional_currency)
values ('Importadora Latin Chile Limitada', '77.724.382-9', 'CLP')
on conflict (tax_id) do nothing;

create table if not exists public.accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  code text not null,
  name text not null,
  parent_id uuid references public.accounting_accounts(id) on delete restrict,
  level smallint not null default 1 check (level between 1 and 12),
  account_type text not null check (account_type in (
    'asset','liability','equity','income','cost','expense','result'
  )),
  normal_balance text not null check (normal_balance in ('debit','credit')),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  classification text not null default 'other',
  allows_posting boolean not null default true,
  active boolean not null default true,
  source_type text not null default 'SYSTEM' check (source_type in (
    'SYSTEM','FACTO','SCOTIABANK','BANCO_ESTADO','MERCADO_PAGO',
    'COMERCIO_EXTERIOR','EXCEL','MANUAL'
  )),
  source_id text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, code)
);

create table if not exists public.accounting_account_mappings (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete cascade,
  source_type text not null,
  source_key text not null,
  source_label text,
  account_id uuid not null references public.accounting_accounts(id) on delete restrict,
  status text not null default 'pending_review' check (status in ('pending_review','approved','rejected')),
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, source_type, source_key)
);

create table if not exists public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  period_number smallint not null check (period_number between 1 and 13),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open' check (status in ('open','review','closed')),
  closed_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz,
  close_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  unique (entity_id, fiscal_year, period_number),
  unique (entity_id, starts_on, ends_on)
);

insert into public.accounting_periods(entity_id, fiscal_year, period_number, starts_on, ends_on)
select e.id, y.year, m.month,
       make_date(y.year, m.month, 1),
       (make_date(y.year, m.month, 1) + interval '1 month - 1 day')::date
from public.accounting_entities e
cross join (values (2025), (2026), (2027)) y(year)
cross join generate_series(1, 12) m(month)
where e.tax_id = '77.724.382-9'
on conflict (entity_id, fiscal_year, period_number) do nothing;

create table if not exists public.accounting_source_documents (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  source_type text not null check (source_type in (
    'FACTO','SCOTIABANK','BANCO_ESTADO','MERCADO_PAGO','COMERCIO_EXTERIOR','EXCEL','MANUAL','SYSTEM'
  )),
  source_id text,
  source_key text not null,
  document_type text not null,
  external_id text,
  folio text,
  counterpart_tax_id text,
  counterpart_name text,
  issued_on date,
  due_on date,
  currency text not null default 'CLP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(20,8) not null default 1 check (exchange_rate > 0),
  net_amount numeric(20,4) not null default 0,
  tax_amount numeric(20,4) not null default 0,
  exempt_amount numeric(20,4) not null default 0,
  total_amount numeric(20,4) not null default 0,
  total_clp numeric(20,4) not null default 0,
  status text not null default 'pending' check (status in (
    'pending','validated','inconsistent','duplicate','voided','posted'
  )),
  data_quality text not null default 'pending' check (data_quality in (
    'pending','validated','inconsistent','duplicate_potential'
  )),
  raw_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_payload) = 'object'),
  source_created_at timestamptz,
  source_updated_at timestamptz,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, source_type, source_key)
);

create table if not exists public.accounting_journal_entries (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  period_id uuid not null references public.accounting_periods(id) on delete restrict,
  entry_number bigint generated by default as identity,
  entry_date date not null,
  description text not null,
  reference text,
  source_type text not null default 'MANUAL',
  source_document_id uuid references public.accounting_source_documents(id) on delete restrict,
  source_module text,
  idempotency_key text not null,
  currency text not null default 'CLP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(20,8) not null default 1 check (exchange_rate > 0),
  status text not null default 'draft' check (status in (
    'draft','suggested','pending_review','validated','posted','reversed','voided'
  )),
  reversal_of uuid references public.accounting_journal_entries(id) on delete restrict,
  posted_by uuid references auth.users(id) on delete set null,
  posted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, idempotency_key)
);

create table if not exists public.accounting_journal_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.accounting_journal_entries(id) on delete restrict,
  line_number integer not null check (line_number > 0),
  account_id uuid not null references public.accounting_accounts(id) on delete restrict,
  description text,
  debit_clp numeric(20,4) not null default 0 check (debit_clp >= 0),
  credit_clp numeric(20,4) not null default 0 check (credit_clp >= 0),
  original_amount numeric(20,4),
  currency text not null default 'CLP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(20,8) not null default 1 check (exchange_rate > 0),
  cost_center text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  check ((debit_clp > 0 and credit_clp = 0) or (credit_clp > 0 and debit_clp = 0)),
  unique (entry_id, line_number)
);

create table if not exists public.accounting_posting_rules (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete cascade,
  code text not null,
  name text not null,
  source_type text not null,
  document_type text,
  debit_account_id uuid references public.accounting_accounts(id) on delete restrict,
  credit_account_id uuid references public.accounting_accounts(id) on delete restrict,
  tax_account_id uuid references public.accounting_accounts(id) on delete restrict,
  conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  active boolean not null default false,
  requires_review boolean not null default true,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, code)
);

create table if not exists public.accounting_import_batches (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  source_type text not null check (source_type in (
    'SCOTIABANK','BANCO_ESTADO','MERCADO_PAGO','COLLECTIONS','PAYMENTS','CHECKS','OPENING_BALANCE','MANUAL'
  )),
  import_profile text not null,
  status text not null default 'uploaded' check (status in (
    'uploaded','previewed','validated','imported','partial','failed','cancelled'
  )),
  file_name text not null,
  storage_path text,
  file_hash text not null,
  row_count integer not null default 0 check (row_count >= 0),
  new_count integer not null default 0 check (new_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  imported_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, source_type, file_hash)
);

create table if not exists public.accounting_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.accounting_import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  fingerprint text not null,
  status text not null default 'new' check (status in ('new','duplicate','invalid','imported','skipped')),
  normalized_data jsonb not null default '{}'::jsonb check (jsonb_typeof(normalized_data) = 'object'),
  validation_errors text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  unique (batch_id, row_number)
);

create table if not exists public.accounting_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  institution text not null,
  account_name text not null,
  account_number_masked text not null,
  currency text not null default 'CLP' check (currency ~ '^[A-Z]{3}$'),
  ledger_account_id uuid not null references public.accounting_accounts(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, institution, account_number_masked, currency)
);

create table if not exists public.accounting_bank_transactions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  bank_account_id uuid not null references public.accounting_bank_accounts(id) on delete restrict,
  import_batch_id uuid references public.accounting_import_batches(id) on delete restrict,
  source_row_id uuid references public.accounting_import_rows(id) on delete restrict,
  transaction_date date not null,
  value_date date,
  description text not null,
  reference text,
  operation_number text,
  debit numeric(20,4) not null default 0 check (debit >= 0),
  credit numeric(20,4) not null default 0 check (credit >= 0),
  amount numeric(20,4) not null,
  balance numeric(20,4),
  currency text not null default 'CLP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(20,8) not null default 1 check (exchange_rate > 0),
  amount_clp numeric(20,4) not null,
  fingerprint text not null,
  reconciliation_status text not null default 'unmatched' check (reconciliation_status in (
    'unmatched','proposed','partial','matched','ignored'
  )),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0)),
  unique (bank_account_id, fingerprint)
);

create table if not exists public.accounting_reconciliations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  bank_transaction_id uuid not null references public.accounting_bank_transactions(id) on delete restrict,
  status text not null default 'proposed' check (status in ('proposed','confirmed','rejected','reversed')),
  confidence text not null default 'possible' check (confidence in ('exact','high','possible','manual')),
  score numeric(7,4) check (score is null or score between 0 and 1),
  matched_amount_clp numeric(20,4) not null default 0 check (matched_amount_clp >= 0),
  explanation text,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.accounting_reconciliation_links (
  id uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references public.accounting_reconciliations(id) on delete cascade,
  target_type text not null check (target_type in (
    'source_document','receivable','payable','check','foreign_trade','journal_entry','manual'
  )),
  target_id uuid,
  target_reference text,
  allocated_amount_clp numeric(20,4) not null check (allocated_amount_clp > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.accounting_receivables (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  source_document_id uuid not null references public.accounting_source_documents(id) on delete restrict,
  company_id uuid,
  customer_tax_id text,
  customer_name text not null,
  document_number text not null,
  issued_on date not null,
  due_on date,
  currency text not null default 'CLP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(20,8) not null default 1 check (exchange_rate > 0),
  original_amount numeric(20,4) not null check (original_amount >= 0),
  original_amount_clp numeric(20,4) not null check (original_amount_clp >= 0),
  paid_amount_clp numeric(20,4) not null default 0 check (paid_amount_clp >= 0),
  balance_clp numeric(20,4) generated always as (greatest(original_amount_clp - paid_amount_clp, 0)) stored,
  status text not null default 'pending' check (status in (
    'pending','partial','paid','overdue','renegotiated','written_off','collections'
  )),
  responsible_id uuid references auth.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, source_document_id)
);

create table if not exists public.accounting_payables (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  source_document_id uuid not null references public.accounting_source_documents(id) on delete restrict,
  supplier_id uuid,
  supplier_tax_id text,
  supplier_name text not null,
  document_number text not null,
  issued_on date not null,
  due_on date,
  currency text not null default 'CLP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(20,8) not null default 1 check (exchange_rate > 0),
  original_amount numeric(20,4) not null check (original_amount >= 0),
  original_amount_clp numeric(20,4) not null check (original_amount_clp >= 0),
  paid_amount_clp numeric(20,4) not null default 0 check (paid_amount_clp >= 0),
  balance_clp numeric(20,4) generated always as (greatest(original_amount_clp - paid_amount_clp, 0)) stored,
  status text not null default 'pending' check (status in ('pending','partial','paid','overdue','renegotiated','voided')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, source_document_id)
);

create table if not exists public.accounting_checks (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  receivable_id uuid references public.accounting_receivables(id) on delete restrict,
  customer_name text not null,
  bank_name text not null,
  check_number text not null,
  amount_clp numeric(20,4) not null check (amount_clp > 0),
  received_on date not null,
  due_on date,
  deposited_on date,
  status text not null default 'portfolio' check (status in (
    'portfolio','deposited','collected','protested','replaced','voided'
  )),
  import_batch_id uuid references public.accounting_import_batches(id) on delete restrict,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, bank_name, check_number)
);

create table if not exists public.accounting_receivable_allocations (
  id uuid primary key default gen_random_uuid(),
  receivable_id uuid not null references public.accounting_receivables(id) on delete restrict,
  bank_transaction_id uuid references public.accounting_bank_transactions(id) on delete restrict,
  check_id uuid references public.accounting_checks(id) on delete restrict,
  journal_entry_id uuid references public.accounting_journal_entries(id) on delete restrict,
  amount_clp numeric(20,4) not null check (amount_clp > 0),
  allocated_on date not null,
  status text not null default 'confirmed' check (status in ('proposed','confirmed','reversed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (bank_transaction_id is not null or check_id is not null)
);

create table if not exists public.accounting_payable_allocations (
  id uuid primary key default gen_random_uuid(),
  payable_id uuid not null references public.accounting_payables(id) on delete restrict,
  bank_transaction_id uuid references public.accounting_bank_transactions(id) on delete restrict,
  journal_entry_id uuid references public.accounting_journal_entries(id) on delete restrict,
  amount_clp numeric(20,4) not null check (amount_clp > 0),
  allocated_on date not null,
  status text not null default 'confirmed' check (status in ('proposed','confirmed','reversed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (bank_transaction_id is not null)
);

create table if not exists public.accounting_exchange_rates (
  id uuid primary key default gen_random_uuid(),
  rate_date date not null,
  from_currency text not null check (from_currency ~ '^[A-Z]{3}$'),
  to_currency text not null default 'CLP' check (to_currency ~ '^[A-Z]{3}$'),
  rate numeric(20,8) not null check (rate > 0),
  source text not null,
  status text not null default 'configured' check (status in ('official','configured','document','estimated')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (rate_date, from_currency, to_currency, source)
);

create table if not exists public.accounting_inventory_movements (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  product_reference text not null,
  product_name text not null,
  movement_date date not null,
  movement_type text not null check (movement_type in ('opening','purchase','sale','adjustment','import_landed')),
  quantity numeric(20,6) not null,
  unit_cost_clp numeric(20,6) not null default 0 check (unit_cost_clp >= 0),
  total_cost_clp numeric(20,4) not null default 0,
  source_type text not null,
  source_id text,
  journal_entry_id uuid references public.accounting_journal_entries(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (entity_id, source_type, source_id, product_reference, movement_type)
);

create table if not exists public.accounting_jobs (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  job_type text not null check (job_type in ('facto_sync','bank_import','reconciliation','controls','foreign_trade_sync')),
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in ('pending','running','completed','partial','failed','cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  error_code text,
  error_message text,
  available_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, idempotency_key)
);

create table if not exists public.accounting_control_findings (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete cascade,
  control_code text not null,
  severity text not null check (severity in ('error','review','ok')),
  status text not null default 'open' check (status in ('open','acknowledged','resolved','ignored')),
  title text not null,
  detail text not null,
  entity_type text,
  entity_reference text,
  amount_clp numeric(20,4),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  unique (entity_id, control_code, entity_type, entity_reference, status)
);

create table if not exists public.accounting_audit_events (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.accounting_entities(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id_text text not null,
  reason text,
  previous_value jsonb,
  new_value jsonb,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create index if not exists accounting_accounts_parent_idx on public.accounting_accounts(entity_id, parent_id, code);
create index if not exists accounting_periods_status_idx on public.accounting_periods(entity_id, status, starts_on);
create index if not exists accounting_sources_date_idx on public.accounting_source_documents(entity_id, issued_on, status);
create index if not exists accounting_entries_date_idx on public.accounting_journal_entries(entity_id, entry_date, status);
create index if not exists accounting_lines_account_idx on public.accounting_journal_lines(account_id, entry_id);
create index if not exists accounting_bank_tx_date_idx on public.accounting_bank_transactions(bank_account_id, transaction_date desc);
create index if not exists accounting_bank_tx_status_idx on public.accounting_bank_transactions(entity_id, reconciliation_status, transaction_date);
create index if not exists accounting_receivables_due_idx on public.accounting_receivables(entity_id, status, due_on);
create index if not exists accounting_payables_due_idx on public.accounting_payables(entity_id, status, due_on);
create index if not exists accounting_checks_due_idx on public.accounting_checks(entity_id, status, due_on);
create index if not exists accounting_findings_open_idx on public.accounting_control_findings(entity_id, status, severity);
create index if not exists accounting_audit_entity_idx on public.accounting_audit_events(entity_type, entity_id_text, created_at desc);

do $$
declare
  v_entity uuid;
begin
  select id into v_entity from public.accounting_entities where tax_id = '77.724.382-9';
  insert into public.accounting_accounts(entity_id, code, name, level, account_type, normal_balance, classification, allows_posting)
  values
    (v_entity,'1','ACTIVOS',1,'asset','debit','assets',false),
    (v_entity,'1.1','ACTIVO CIRCULANTE',2,'asset','debit','current_assets',false),
    (v_entity,'1.1.01','Caja',3,'asset','debit','cash',true),
    (v_entity,'1.1.02','Scotiabank CLP',3,'asset','debit','bank_clp',true),
    (v_entity,'1.1.03','BancoEstado CLP',3,'asset','debit','bank_clp',true),
    (v_entity,'1.1.04','Mercado Pago',3,'asset','debit','payment_processor',true),
    (v_entity,'1.1.05','Banco USD',3,'asset','debit','bank_usd',true),
    (v_entity,'1.1.10','Clientes y documentos por cobrar',3,'asset','debit','receivables',true),
    (v_entity,'1.1.11','Cheques en cartera',3,'asset','debit','checks_portfolio',true),
    (v_entity,'1.1.20','Inventarios',3,'asset','debit','inventory',true),
    (v_entity,'1.1.21','Importaciones en tránsito',3,'asset','debit','imports_in_transit',true),
    (v_entity,'1.1.30','IVA crédito fiscal',3,'asset','debit','vat_credit',true),
    (v_entity,'1.1.99','Cuenta transitoria de activos',3,'asset','debit','suspense_asset',true),
    (v_entity,'2','PASIVOS',1,'liability','credit','liabilities',false),
    (v_entity,'2.1','PASIVO CIRCULANTE',2,'liability','credit','current_liabilities',false),
    (v_entity,'2.1.01','Proveedores nacionales',3,'liability','credit','payables',true),
    (v_entity,'2.1.02','Proveedores extranjeros',3,'liability','credit','foreign_payables',true),
    (v_entity,'2.1.10','IVA débito fiscal',3,'liability','credit','vat_debit',true),
    (v_entity,'2.1.11','Impuestos por pagar',3,'liability','credit','taxes_payable',true),
    (v_entity,'2.1.99','Cuenta transitoria de pasivos',3,'liability','credit','suspense_liability',true),
    (v_entity,'3','PATRIMONIO',1,'equity','credit','equity',false),
    (v_entity,'3.1.01','Capital',3,'equity','credit','capital',true),
    (v_entity,'3.1.02','Resultados acumulados',3,'equity','credit','retained_earnings',true),
    (v_entity,'4','INGRESOS',1,'income','credit','income',false),
    (v_entity,'4.1.01','Ventas netas',3,'income','credit','net_sales',true),
    (v_entity,'4.1.02','Otros ingresos',3,'income','credit','other_income',true),
    (v_entity,'4.1.03','Utilidad por diferencia de cambio',3,'income','credit','fx_gain',true),
    (v_entity,'5','COSTOS',1,'cost','debit','costs',false),
    (v_entity,'5.1.01','Costo de ventas',3,'cost','debit','cost_of_sales',true),
    (v_entity,'5.1.02','Costos de importación',3,'cost','debit','import_costs',true),
    (v_entity,'6','GASTOS',1,'expense','debit','expenses',false),
    (v_entity,'6.1.01','Gastos operacionales',3,'expense','debit','operating_expenses',true),
    (v_entity,'6.1.02','Gastos bancarios',3,'expense','debit','bank_fees',true),
    (v_entity,'6.1.03','Pérdida por diferencia de cambio',3,'expense','debit','fx_loss',true)
  on conflict (entity_id, code) do nothing;

  update public.accounting_accounts child
  set parent_id = parent.id
  from public.accounting_accounts parent
  where child.entity_id = v_entity and parent.entity_id = v_entity
    and child.parent_id is null
    and child.code <> parent.code
    and parent.code = regexp_replace(child.code, '\.[^.]+$', '');
end $$;

create or replace function public.accounting_guard_posted_entry()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status in ('posted','reversed') then
    if tg_op = 'UPDATE'
       and old.status = 'posted'
       and new.status = 'reversed'
       and current_setting('app.accounting_authorized_reversal', true) = 'on' then
      return new;
    end if;
    raise exception 'Los asientos contabilizados son inmutables; crea una reversa.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists accounting_guard_posted_entry_update on public.accounting_journal_entries;
create trigger accounting_guard_posted_entry_update
before update or delete on public.accounting_journal_entries
for each row execute function public.accounting_guard_posted_entry();

create or replace function public.accounting_guard_posted_line()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare v_status text;
begin
  select status into v_status
  from public.accounting_journal_entries
  where id = case when tg_op = 'DELETE' then old.entry_id else new.entry_id end;
  if v_status in ('posted','reversed') then
    raise exception 'Las líneas de un asiento contabilizado son inmutables.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.accounting_create_journal_entry(
  p_payload jsonb,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity uuid;
  v_period uuid;
  v_entry uuid;
  v_date date;
  v_lines jsonb;
  v_line jsonb;
  v_line_number integer := 0;
  v_debit numeric(20,4) := 0;
  v_credit numeric(20,4) := 0;
  v_account uuid;
  v_currency text;
  v_rate numeric(20,8);
begin
  if auth.role() <> 'service_role' and not public.accounting_has_permission('accounting.entry.create') then
    raise exception 'No tienes permiso para crear asientos.';
  end if;
  v_entity := nullif(p_payload->>'entity_id','')::uuid;
  v_date := nullif(p_payload->>'entry_date','')::date;
  v_lines := p_payload->'lines';
  v_currency := upper(coalesce(nullif(p_payload->>'currency',''),'CLP'));
  v_rate := coalesce(nullif(p_payload->>'exchange_rate','')::numeric,1);
  if v_entity is null or v_date is null or coalesce(length(trim(p_payload->>'description')),0) < 3 then
    raise exception 'Entidad, fecha y glosa son obligatorias.';
  end if;
  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) < 2 then
    raise exception 'El asiento requiere al menos dos líneas.';
  end if;
  select id into v_period
  from public.accounting_periods
  where entity_id=v_entity and v_date between starts_on and ends_on and status <> 'closed'
  order by starts_on limit 1;
  if v_period is null then raise exception 'No existe un período abierto para la fecha del asiento.'; end if;

  insert into public.accounting_journal_entries(
    entity_id,period_id,entry_date,description,reference,source_type,source_module,
    idempotency_key,currency,exchange_rate,status,created_by
  ) values (
    v_entity,v_period,v_date,trim(p_payload->>'description'),nullif(trim(p_payload->>'reference'),''),
    'MANUAL','accounting',coalesce(nullif(p_payload->>'idempotency_key',''),'manual:'||gen_random_uuid()::text),
    v_currency,v_rate,coalesce(nullif(p_payload->>'status',''),'draft'),coalesce(p_actor_id,auth.uid())
  ) returning id into v_entry;

  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_line_number := v_line_number + 1;
    v_account := nullif(v_line->>'account_id','')::uuid;
    if not exists (
      select 1 from public.accounting_accounts
      where id=v_account and entity_id=v_entity and active and allows_posting
    ) then raise exception 'La línea % usa una cuenta inválida o no imputable.', v_line_number; end if;
    v_debit := v_debit + coalesce(nullif(v_line->>'debit_clp','')::numeric,0);
    v_credit := v_credit + coalesce(nullif(v_line->>'credit_clp','')::numeric,0);
    insert into public.accounting_journal_lines(
      entry_id,line_number,account_id,description,debit_clp,credit_clp,
      original_amount,currency,exchange_rate,cost_center,metadata
    ) values (
      v_entry,v_line_number,v_account,nullif(trim(v_line->>'description'),''),
      coalesce(nullif(v_line->>'debit_clp','')::numeric,0),
      coalesce(nullif(v_line->>'credit_clp','')::numeric,0),
      nullif(v_line->>'original_amount','')::numeric,
      upper(coalesce(nullif(v_line->>'currency',''),v_currency)),
      coalesce(nullif(v_line->>'exchange_rate','')::numeric,v_rate),
      nullif(trim(v_line->>'cost_center'),''),coalesce(v_line->'metadata','{}'::jsonb)
    );
  end loop;
  if v_debit <= 0 or v_debit <> v_credit then
    raise exception 'Asiento descuadrado: debe % y haber %.', v_debit, v_credit;
  end if;
  insert into public.accounting_audit_events(entity_id,actor_id,action,entity_type,entity_id_text,new_value)
  values (v_entity,coalesce(p_actor_id,auth.uid()),'journal.created','journal_entry',v_entry::text,
          jsonb_build_object('debit_clp',v_debit,'credit_clp',v_credit));
  return v_entry;
end;
$$;

drop trigger if exists accounting_guard_posted_line_change on public.accounting_journal_lines;
create trigger accounting_guard_posted_line_change
before insert or update or delete on public.accounting_journal_lines
for each row execute function public.accounting_guard_posted_line();

create or replace function public.accounting_post_journal_entry(p_entry_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry public.accounting_journal_entries%rowtype;
  v_debit numeric(20,4);
  v_credit numeric(20,4);
  v_lines integer;
  v_period_status text;
begin
  if auth.role() <> 'service_role' and not public.accounting_has_permission('accounting.entry.post') then
    raise exception 'No tienes permiso para contabilizar asientos.';
  end if;
  select * into v_entry from public.accounting_journal_entries where id = p_entry_id for update;
  if not found then raise exception 'Asiento no encontrado.'; end if;
  if v_entry.status in ('posted','reversed') then return v_entry.id; end if;
  select status into v_period_status from public.accounting_periods where id = v_entry.period_id;
  if v_period_status = 'closed' then raise exception 'El período contable está cerrado.'; end if;
  select coalesce(sum(debit_clp),0), coalesce(sum(credit_clp),0), count(*)
    into v_debit, v_credit, v_lines
  from public.accounting_journal_lines where entry_id = p_entry_id;
  if v_lines < 2 then raise exception 'El asiento requiere al menos dos líneas.'; end if;
  if v_debit <= 0 or v_debit <> v_credit then
    raise exception 'Asiento descuadrado: debe % y haber %.', v_debit, v_credit;
  end if;
  if exists (
    select 1 from public.accounting_journal_lines l
    join public.accounting_accounts a on a.id = l.account_id
    where l.entry_id = p_entry_id and (not a.active or not a.allows_posting or a.entity_id <> v_entry.entity_id)
  ) then raise exception 'El asiento contiene una cuenta inactiva, no imputable o de otra entidad.'; end if;

  update public.accounting_journal_entries
  set status = 'posted', posted_by = auth.uid(), posted_at = now(), updated_at = now()
  where id = p_entry_id;
  update public.accounting_source_documents
  set status = 'posted', updated_at = now()
  where id = v_entry.source_document_id and status <> 'voided';
  insert into public.accounting_audit_events(entity_id, actor_id, action, entity_type, entity_id_text, new_value)
  values (v_entry.entity_id, auth.uid(), 'journal.posted', 'journal_entry', p_entry_id::text,
          jsonb_build_object('debit_clp', v_debit, 'credit_clp', v_credit));
  return p_entry_id;
end;
$$;

create or replace function public.accounting_reverse_journal_entry(
  p_entry_id uuid,
  p_reversal_date date,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry public.accounting_journal_entries%rowtype;
  v_period uuid;
  v_reversal uuid;
begin
  if auth.role() <> 'service_role' and not public.accounting_has_permission('accounting.entry.post') then
    raise exception 'No tienes permiso para reversar asientos.';
  end if;
  if coalesce(length(trim(p_reason)),0) < 5 then raise exception 'Debes indicar el motivo de la reversa.'; end if;
  select * into v_entry from public.accounting_journal_entries where id = p_entry_id for update;
  if not found or v_entry.status <> 'posted' then raise exception 'Solo se puede reversar un asiento contabilizado.'; end if;
  select id into v_period from public.accounting_periods
  where entity_id = v_entry.entity_id and p_reversal_date between starts_on and ends_on and status <> 'closed'
  order by starts_on limit 1;
  if v_period is null then raise exception 'No existe un período abierto para la fecha de reversa.'; end if;
  insert into public.accounting_journal_entries(
    entity_id, period_id, entry_date, description, reference, source_type, source_module,
    idempotency_key, currency, exchange_rate, status, reversal_of, created_by
  ) values (
    v_entry.entity_id, v_period, p_reversal_date, 'Reversa: ' || v_entry.description,
    v_entry.reference, 'SYSTEM', 'accounting', 'reversal:' || p_entry_id::text,
    v_entry.currency, v_entry.exchange_rate, 'validated', p_entry_id, auth.uid()
  ) returning id into v_reversal;
  insert into public.accounting_journal_lines(
    entry_id, line_number, account_id, description, debit_clp, credit_clp,
    original_amount, currency, exchange_rate, cost_center, metadata
  )
  select v_reversal, line_number, account_id, 'Reversa: ' || coalesce(description,''),
         credit_clp, debit_clp, original_amount, currency, exchange_rate, cost_center, metadata
  from public.accounting_journal_lines where entry_id = p_entry_id order by line_number;
  perform public.accounting_post_journal_entry(v_reversal);
  perform set_config('app.accounting_authorized_reversal', 'on', true);
  update public.accounting_journal_entries set status = 'reversed', updated_at = now() where id = p_entry_id;
  insert into public.accounting_audit_events(entity_id, actor_id, action, entity_type, entity_id_text, reason, new_value)
  values (v_entry.entity_id, auth.uid(), 'journal.reversed', 'journal_entry', p_entry_id::text,
          trim(p_reason), jsonb_build_object('reversal_entry_id', v_reversal));
  return v_reversal;
end;
$$;

create or replace function public.accounting_close_period(p_period_id uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_period public.accounting_periods%rowtype;
begin
  if auth.role() <> 'service_role' and (public.current_role() <> 'administrador' or not public.accounting_has_permission('accounting.period.close')) then
    raise exception 'Solo Administración puede cerrar períodos.';
  end if;
  select * into v_period from public.accounting_periods where id = p_period_id for update;
  if not found then raise exception 'Período no encontrado.'; end if;
  if v_period.status = 'closed' then return p_period_id; end if;
  if exists (
    select 1 from public.accounting_journal_entries
    where period_id = p_period_id and status in ('draft','suggested','pending_review','validated')
  ) then raise exception 'Existen asientos pendientes en el período.'; end if;
  if exists (
    select 1 from public.accounting_control_findings
    where entity_id = v_period.entity_id and status = 'open' and severity = 'error'
      and metadata->>'period_id' = p_period_id::text
  ) then raise exception 'Existen errores de control abiertos en el período.'; end if;
  update public.accounting_periods
  set status = 'closed', closed_by = auth.uid(), closed_at = now(), close_note = p_note, updated_at = now()
  where id = p_period_id;
  insert into public.accounting_audit_events(entity_id, actor_id, action, entity_type, entity_id_text, reason)
  values (v_period.entity_id, auth.uid(), 'period.closed', 'accounting_period', p_period_id::text, p_note);
  return p_period_id;
end;
$$;

create or replace function public.accounting_trial_balance(
  p_entity_id uuid,
  p_from date,
  p_to date
)
returns table (
  account_id uuid, code text, account_name text, account_type text,
  debits numeric, credits numeric, debit_balance numeric, credit_balance numeric
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select a.id, a.code, a.name, a.account_type,
         coalesce(sum(l.debit_clp) filter (where e.id is not null),0)::numeric,
         coalesce(sum(l.credit_clp) filter (where e.id is not null),0)::numeric,
         greatest(coalesce(sum(l.debit_clp-l.credit_clp) filter (where e.id is not null),0),0)::numeric,
         greatest(coalesce(sum(l.credit_clp-l.debit_clp) filter (where e.id is not null),0),0)::numeric
  from public.accounting_accounts a
  left join public.accounting_journal_lines l on l.account_id = a.id
  left join public.accounting_journal_entries e on e.id = l.entry_id
    and e.status in ('posted','reversed') and e.entry_date between p_from and p_to
  where a.entity_id = p_entity_id and a.allows_posting
    and (auth.role()='service_role' or public.accounting_has_permission('accounting.ledger.view'))
  group by a.id, a.code, a.name, a.account_type
  having coalesce(sum(l.debit_clp) filter (where e.id is not null),0) <> 0
      or coalesce(sum(l.credit_clp) filter (where e.id is not null),0) <> 0
  order by a.code
$$;

create or replace function public.accounting_balance_eight_columns(
  p_entity_id uuid,
  p_from date,
  p_to date
)
returns table (
  code text, account_name text, debits numeric, credits numeric,
  debit_balance numeric, credit_balance numeric,
  assets numeric, liabilities numeric, losses numeric, gains numeric
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  with b as (
    select * from public.accounting_trial_balance(p_entity_id, p_from, p_to)
  )
  select b.code, b.account_name, b.debits, b.credits, b.debit_balance, b.credit_balance,
         case when b.account_type = 'asset' then b.debit_balance else 0 end,
         case when b.account_type in ('liability','equity') then b.credit_balance else 0 end,
         case when b.account_type in ('cost','expense') then b.debit_balance else 0 end,
         case when b.account_type in ('income','result') then b.credit_balance else 0 end
  from b order by b.code
$$;

create or replace function public.accounting_income_statement(
  p_entity_id uuid,
  p_from date,
  p_to date
)
returns table (
  code text,
  account_name text,
  category text,
  amount_clp numeric
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select a.code,
         a.name,
         case a.account_type
           when 'income' then 'Ingresos'
           when 'cost' then 'Costo de ventas'
           when 'expense' then 'Gastos operacionales'
           else 'Otros resultados'
         end,
         case
           when a.account_type in ('income','result')
             then coalesce(sum(l.credit_clp - l.debit_clp), 0)
           else coalesce(sum(l.debit_clp - l.credit_clp), 0)
         end::numeric
  from public.accounting_accounts a
  join public.accounting_journal_lines l on l.account_id = a.id
  join public.accounting_journal_entries e on e.id = l.entry_id
  where a.entity_id = p_entity_id
    and a.account_type in ('income','cost','expense','result')
    and e.status in ('posted','reversed')
    and e.entry_date between p_from and p_to
    and (auth.role()='service_role' or public.accounting_has_permission('accounting.profitability.view'))
  group by a.code, a.name, a.account_type
  having sum(l.debit_clp) <> 0 or sum(l.credit_clp) <> 0
  order by a.code
$$;

create or replace function public.accounting_cash_flow(
  p_entity_id uuid,
  p_from date,
  p_to date
)
returns table (
  month date,
  inflows_clp numeric,
  outflows_clp numeric,
  net_flow_clp numeric,
  matched_transactions bigint,
  pending_transactions bigint
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select date_trunc('month', t.transaction_date)::date,
         coalesce(sum(greatest(t.amount_clp, 0)), 0)::numeric,
         coalesce(sum(abs(least(t.amount_clp, 0))), 0)::numeric,
         coalesce(sum(t.amount_clp), 0)::numeric,
         count(*) filter (where t.reconciliation_status = 'matched'),
         count(*) filter (where t.reconciliation_status in ('unmatched','proposed','partial'))
  from public.accounting_bank_transactions t
  where t.entity_id = p_entity_id
    and t.transaction_date between p_from and p_to
    and t.reconciliation_status <> 'ignored'
    and (auth.role()='service_role' or public.accounting_has_permission('accounting.ledger.view'))
  group by date_trunc('month', t.transaction_date)
  order by date_trunc('month', t.transaction_date)
$$;

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
    'receivables', coalesce((select sum(balance_clp) from public.accounting_receivables
      where entity_id=p_entity_id and status not in ('paid','written_off')),0),
    'receivables_overdue', coalesce((select sum(balance_clp) from public.accounting_receivables
      where entity_id=p_entity_id and status not in ('paid','written_off') and due_on < p_as_of),0),
    'payables', coalesce((select sum(balance_clp) from public.accounting_payables
      where entity_id=p_entity_id and status not in ('paid','voided')),0),
    'payables_overdue', coalesce((select sum(balance_clp) from public.accounting_payables
      where entity_id=p_entity_id and status not in ('paid','voided') and due_on < p_as_of),0),
    'checks_portfolio', coalesce((select sum(amount_clp) from public.accounting_checks
      where entity_id=p_entity_id and status='portfolio'),0),
    'unmatched_bank', (select count(*) from public.accounting_bank_transactions
      where entity_id=p_entity_id and reconciliation_status='unmatched'),
    'open_controls', (select count(*) from public.accounting_control_findings
      where entity_id=p_entity_id and status='open' and severity<>'ok'),
    'pending_entries', (select count(*) from public.accounting_journal_entries
      where entity_id=p_entity_id and status in ('draft','suggested','pending_review','validated')),
    'provisional', exists(select 1 from public.accounting_periods
      where entity_id=p_entity_id and p_as_of between starts_on and ends_on and status<>'closed')
  ) else '{}'::jsonb end
$$;

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
  update public.accounting_control_findings set status='resolved', resolved_at=now(), resolved_by=auth.uid()
  where entity_id=p_entity_id and status='open' and control_code in (
    'bank_unmatched','source_unposted','receivable_overdue','payable_overdue','missing_exchange_rate'
  );
  insert into public.accounting_control_findings(entity_id, control_code, severity, title, detail, entity_type, entity_reference, amount_clp)
  select p_entity_id, 'bank_unmatched', 'review', 'Movimiento bancario sin conciliar',
         description, 'bank_transaction', id::text, abs(amount_clp)
  from public.accounting_bank_transactions
  where entity_id=p_entity_id and reconciliation_status='unmatched'
  on conflict do nothing;
  insert into public.accounting_control_findings(entity_id, control_code, severity, title, detail, entity_type, entity_reference, amount_clp)
  select p_entity_id, 'source_unposted', 'review', 'Documento fuente sin contabilizar',
         coalesce(document_type,'Documento') || ' ' || coalesce(folio,source_key), 'source_document', id::text, total_clp
  from public.accounting_source_documents
  where entity_id=p_entity_id and status in ('pending','validated','inconsistent')
  on conflict do nothing;
  select count(*) into v_count from public.accounting_control_findings where entity_id=p_entity_id and status='open';
  return v_count;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'accounting_entities','accounting_accounts','accounting_account_mappings','accounting_periods',
    'accounting_source_documents','accounting_journal_entries','accounting_journal_lines',
    'accounting_posting_rules','accounting_import_batches','accounting_import_rows',
    'accounting_bank_accounts','accounting_bank_transactions','accounting_reconciliations',
    'accounting_reconciliation_links','accounting_receivables','accounting_payables','accounting_checks',
    'accounting_receivable_allocations','accounting_payable_allocations','accounting_exchange_rates',
    'accounting_inventory_movements','accounting_jobs','accounting_control_findings','accounting_audit_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists accounting_read on public.%I', t);
    execute format('create policy accounting_read on public.%I for select to authenticated using (public.accounting_has_permission(''accounting.dashboard.view''))', t);
    execute format('drop policy if exists accounting_service on public.%I', t);
    execute format('create policy accounting_service on public.%I for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

alter table public.accounting_role_permissions enable row level security;
drop policy if exists accounting_permissions_read on public.accounting_role_permissions;
create policy accounting_permissions_read on public.accounting_role_permissions
  for select to authenticated using (public.accounting_has_permission('accounting.dashboard.view'));
drop policy if exists accounting_permissions_admin on public.accounting_role_permissions;
create policy accounting_permissions_admin on public.accounting_role_permissions
  for all to authenticated using (public.current_role()='administrador') with check (public.current_role()='administrador');

drop policy if exists accounting_user_create_entries on public.accounting_journal_entries;
create policy accounting_user_create_entries on public.accounting_journal_entries
  for insert to authenticated with check (public.accounting_has_permission('accounting.entry.create'));
drop policy if exists accounting_user_update_entries on public.accounting_journal_entries;
create policy accounting_user_update_entries on public.accounting_journal_entries
  for update to authenticated using (public.accounting_has_permission('accounting.entry.create'))
  with check (public.accounting_has_permission('accounting.entry.create'));
drop policy if exists accounting_user_manage_lines on public.accounting_journal_lines;
create policy accounting_user_manage_lines on public.accounting_journal_lines
  for all to authenticated using (public.accounting_has_permission('accounting.entry.create'))
  with check (public.accounting_has_permission('accounting.entry.create'));

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'accounting-evidence','accounting-evidence',false,52428800,
  array['application/pdf','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv']
)
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists accounting_read_evidence on storage.objects;
create policy accounting_read_evidence on storage.objects for select to authenticated
  using (bucket_id='accounting-evidence' and public.accounting_has_permission('accounting.dashboard.view'));
drop policy if exists accounting_upload_evidence on storage.objects;
create policy accounting_upload_evidence on storage.objects for insert to authenticated
  with check (bucket_id='accounting-evidence' and public.accounting_has_permission('accounting.import'));
drop policy if exists accounting_update_evidence on storage.objects;
create policy accounting_update_evidence on storage.objects for update to authenticated
  using (bucket_id='accounting-evidence' and public.accounting_has_permission('accounting.import'))
  with check (bucket_id='accounting-evidence' and public.accounting_has_permission('accounting.import'));

do $$
declare t text;
begin
  foreach t in array array[
    'accounting_entities','accounting_accounts','accounting_account_mappings','accounting_periods',
    'accounting_source_documents','accounting_journal_entries','accounting_journal_lines',
    'accounting_posting_rules','accounting_import_batches','accounting_import_rows',
    'accounting_bank_accounts','accounting_bank_transactions','accounting_reconciliations',
    'accounting_reconciliation_links','accounting_receivables','accounting_payables','accounting_checks',
    'accounting_receivable_allocations','accounting_payable_allocations','accounting_exchange_rates',
    'accounting_inventory_movements','accounting_jobs','accounting_control_findings','accounting_audit_events'
  ] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

grant select on public.accounting_role_permissions to authenticated;
grant all on public.accounting_role_permissions to service_role;
grant insert, update on public.accounting_journal_entries to authenticated;
grant insert, update, delete on public.accounting_journal_lines to authenticated;

revoke all on function public.accounting_has_permission(text) from public;
revoke all on function public.accounting_create_journal_entry(jsonb,uuid) from public;
revoke all on function public.accounting_post_journal_entry(uuid) from public;
revoke all on function public.accounting_reverse_journal_entry(uuid,date,text) from public;
revoke all on function public.accounting_close_period(uuid,text) from public;
revoke all on function public.accounting_trial_balance(uuid,date,date) from public;
revoke all on function public.accounting_balance_eight_columns(uuid,date,date) from public;
revoke all on function public.accounting_income_statement(uuid,date,date) from public;
revoke all on function public.accounting_cash_flow(uuid,date,date) from public;
revoke all on function public.accounting_dashboard_summary(uuid,date) from public;
revoke all on function public.accounting_refresh_controls(uuid) from public;

grant execute on function public.accounting_has_permission(text) to authenticated, service_role;
grant execute on function public.accounting_create_journal_entry(jsonb,uuid) to authenticated, service_role;
grant execute on function public.accounting_post_journal_entry(uuid) to authenticated, service_role;
grant execute on function public.accounting_reverse_journal_entry(uuid,date,text) to authenticated, service_role;
grant execute on function public.accounting_close_period(uuid,text) to authenticated, service_role;
grant execute on function public.accounting_trial_balance(uuid,date,date) to authenticated, service_role;
grant execute on function public.accounting_balance_eight_columns(uuid,date,date) to authenticated, service_role;
grant execute on function public.accounting_income_statement(uuid,date,date) to authenticated, service_role;
grant execute on function public.accounting_cash_flow(uuid,date,date) to authenticated, service_role;
grant execute on function public.accounting_dashboard_summary(uuid,date) to authenticated, service_role;
grant execute on function public.accounting_refresh_controls(uuid) to authenticated, service_role;

comment on table public.accounting_source_documents is 'Documentos normalizados; un documento no equivale a un pago ni a un asiento.';
comment on table public.accounting_bank_transactions is 'Movimientos bancarios normalizados y deduplicados por fingerprint.';
comment on table public.accounting_journal_entries is 'Libro central de doble partida; los asientos contabilizados son inmutables.';
comment on table public.accounting_snapshots is 'Cortes contables legados; no sustituyen el libro central de doble partida.';

commit;
