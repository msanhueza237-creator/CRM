-- Contabilidad 2026 para el Agente de Finanzas.
-- Ejecutar como postgres. Los datos quedan visibles y editables solo para administradores.

begin;

create table if not exists public.accounting_snapshots (
  id uuid primary key default gen_random_uuid(),
  fiscal_year integer not null check (fiscal_year between 2000 and 2100),
  version integer not null default 1 check (version > 0),
  period_start date not null,
  period_end date not null,
  status text not null default 'provisional'
    check (status in ('provisional', 'reviewed', 'closed')),
  basis text not null,
  source_coverage jsonb not null default '{}'::jsonb,
  bank_summary jsonb not null default '[]'::jsonb,
  payroll_summary jsonb not null default '{}'::jsonb,
  prebalance_rows jsonb not null default '[]'::jsonb,
  controls jsonb not null default '{}'::jsonb,
  findings jsonb not null default '[]'::jsonb,
  artifact_metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fiscal_year, version),
  check (period_end >= period_start),
  check (jsonb_typeof(source_coverage) = 'object'),
  check (jsonb_typeof(bank_summary) = 'array'),
  check (jsonb_typeof(payroll_summary) = 'object'),
  check (jsonb_typeof(prebalance_rows) = 'array'),
  check (jsonb_typeof(controls) = 'object'),
  check (jsonb_typeof(findings) = 'array'),
  check (jsonb_typeof(artifact_metadata) = 'object')
);

create table if not exists public.accounting_action_proposals (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.accounting_snapshots(id) on delete cascade,
  action_type text not null
    check (action_type in (
      'facto_employee_setup',
      'journal_reclassification',
      'bank_reconciliation',
      'payroll_validation',
      'source_completion'
    )),
  title text not null,
  description text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'rejected', 'executed', 'cancelled')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(payload) = 'object'),
  check (
    (status = 'pending_review' and reviewed_at is null)
    or (status <> 'pending_review' and reviewed_at is not null)
  )
);

create index if not exists accounting_snapshots_period_idx
  on public.accounting_snapshots (fiscal_year desc, period_end desc, version desc);
create index if not exists accounting_action_proposals_status_idx
  on public.accounting_action_proposals (status, created_at desc);

drop trigger if exists set_accounting_snapshots_updated_at on public.accounting_snapshots;
create trigger set_accounting_snapshots_updated_at
before update on public.accounting_snapshots
for each row execute function public.set_updated_at();

drop trigger if exists set_accounting_action_proposals_updated_at on public.accounting_action_proposals;
create trigger set_accounting_action_proposals_updated_at
before update on public.accounting_action_proposals
for each row execute function public.set_updated_at();

alter table public.accounting_snapshots enable row level security;
alter table public.accounting_action_proposals enable row level security;

drop policy if exists "admins manage accounting snapshots" on public.accounting_snapshots;
create policy "admins manage accounting snapshots"
on public.accounting_snapshots for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "admins manage accounting proposals" on public.accounting_action_proposals;
create policy "admins manage accounting proposals"
on public.accounting_action_proposals for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

revoke all on public.accounting_snapshots from anon;
revoke all on public.accounting_action_proposals from anon;
grant select, insert, update, delete on public.accounting_snapshots to authenticated;
grant select, insert, update, delete on public.accounting_action_proposals to authenticated;

comment on table public.accounting_snapshots is
  'Cortes contables agregados y versionados. No contiene cartolas completas ni datos personales laborales.';
comment on table public.accounting_action_proposals is
  'Acciones contables o de Facto que requieren revisión humana antes de ejecutarse.';

commit;
