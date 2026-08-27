-- Finanzas y Contabilidad - respaldo historico de sincronizaciones Facto
-- Aplicar despues de supabase/accounting_center.sql.

begin;

create table if not exists public.accounting_facto_sync_runs (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  from_date date not null,
  to_date date not null,
  status text not null default 'running'
    check (status in ('running','completed','partial','failed','cancelled')),
  source_records integer not null default 0 check (source_records >= 0),
  in_range_records integer not null default 0 check (in_range_records >= 0),
  inserted_records integer not null default 0 check (inserted_records >= 0),
  updated_records integer not null default 0 check (updated_records >= 0),
  skipped_records integer not null default 0 check (skipped_records >= 0),
  inconsistent_records integer not null default 0 check (inconsistent_records >= 0),
  receivables integer not null default 0 check (receivables >= 0),
  payables integer not null default 0 check (payables >= 0),
  source_observed_from timestamptz,
  source_observed_to timestamptz,
  error_message text,
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  requested_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_facto_sync_range check (from_date <= to_date)
);

create table if not exists public.accounting_facto_sync_records (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.accounting_facto_sync_runs(id) on delete restrict,
  integration_record_id uuid,
  resource text not null,
  external_id text not null,
  canonical_key text not null,
  document_date date,
  observed_at timestamptz,
  payload_hash text not null,
  raw_payload jsonb not null default '{}'::jsonb,
  decision text not null
    check (decision in ('included','out_of_range','superseded','invalid')),
  source_document_id uuid references public.accounting_source_documents(id) on delete set null,
  validation_errors text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (run_id, resource, external_id)
);

create index if not exists accounting_facto_runs_entity_idx
  on public.accounting_facto_sync_runs(entity_id, created_at desc);
create index if not exists accounting_facto_records_run_idx
  on public.accounting_facto_sync_records(run_id, decision, document_date);
create index if not exists accounting_facto_records_external_idx
  on public.accounting_facto_sync_records(external_id, resource);

alter table public.accounting_facto_sync_runs enable row level security;
alter table public.accounting_facto_sync_records enable row level security;

drop policy if exists accounting_facto_runs_read on public.accounting_facto_sync_runs;
create policy accounting_facto_runs_read
on public.accounting_facto_sync_runs for select to authenticated
using (public.accounting_has_permission('accounting.dashboard.view'));

drop policy if exists accounting_facto_records_read on public.accounting_facto_sync_records;
create policy accounting_facto_records_read
on public.accounting_facto_sync_records for select to authenticated
using (public.accounting_has_permission('accounting.dashboard.view'));

drop policy if exists accounting_facto_runs_service on public.accounting_facto_sync_runs;
create policy accounting_facto_runs_service
on public.accounting_facto_sync_runs for all to service_role
using (true) with check (true);

drop policy if exists accounting_facto_records_service on public.accounting_facto_sync_records;
create policy accounting_facto_records_service
on public.accounting_facto_sync_records for all to service_role
using (true) with check (true);

grant select on public.accounting_facto_sync_runs, public.accounting_facto_sync_records to authenticated;
grant all on public.accounting_facto_sync_runs, public.accounting_facto_sync_records to service_role;

commit;
