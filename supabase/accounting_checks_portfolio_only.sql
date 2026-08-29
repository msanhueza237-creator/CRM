-- Finanzas - correccion durable del indicador de cheques en cartera.
--
-- Los cheques depositados o cobrados se conservan para auditoria, pero no son
-- dinero en cartera. El dashboard solo suma documentos fisicos con estado
-- portfolio. Esta migracion puede ejecutarse varias veces sin duplicar datos.

create or replace function public.accounting_dashboard_summary(
  p_entity_id uuid,
  p_as_of date default current_date
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when auth.role()='service_role' or public.accounting_has_permission('accounting.dashboard.view') then jsonb_build_object(
    'as_of', p_as_of,
    'bank_clp', coalesce((select sum(case when a.normal_balance='debit' then l.debit_clp-l.credit_clp else l.credit_clp-l.debit_clp end)
      from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id=l.entry_id
      join public.accounting_accounts a on a.id=l.account_id
      where e.entity_id=p_entity_id and e.status in ('posted','reversed') and e.entry_date<=p_as_of
        and a.classification in ('cash','bank_clp','bank_scotiabank_clp','bank_bancoestado_clp','payment_processor')),0),
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
