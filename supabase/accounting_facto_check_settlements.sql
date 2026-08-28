-- Finanzas - trazabilidad de cheques Facto y cobro contra BancoEstado.
-- Un numero de cheque puede repetirse en fechas distintas y un cheque fisico
-- puede pagar mas de un documento. La clave anterior perdia ambos casos.

alter table public.accounting_checks
  add column if not exists source_business_key text,
  add column if not exists facto_collected_on date,
  add column if not exists bank_evidence_status text not null default 'pending'
    check (bank_evidence_status in ('pending','matched','not_required'));

alter table public.accounting_checks
  drop constraint if exists accounting_checks_entity_id_bank_name_check_number_key;

create unique index if not exists accounting_checks_source_business_key_uidx
  on public.accounting_checks(entity_id, source_business_key)
  where source_business_key is not null;

create index if not exists accounting_checks_facto_collection_idx
  on public.accounting_checks(entity_id, source_status, facto_collected_on, bank_evidence_status);

create unique index if not exists accounting_receivable_check_allocation_uidx
  on public.accounting_receivable_allocations(receivable_id, check_id)
  where check_id is not null and status = 'confirmed';

create unique index if not exists accounting_reconciliation_check_target_uidx
  on public.accounting_reconciliation_links(target_type, target_id)
  where target_type = 'check';

comment on column public.accounting_checks.source_business_key is
  'Identifica el cheque fisico por banco, numero, fechas y RUT; no confundir con una asignacion documental.';
comment on column public.accounting_checks.facto_collected_on is
  'Fecha de cobro informada por Facto; no sustituye la evidencia de la cartola bancaria.';
comment on column public.accounting_checks.bank_evidence_status is
  'Indica si el cobro Facto ya fue demostrado por un movimiento bancario independiente.';
