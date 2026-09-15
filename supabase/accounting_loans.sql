-- Loan subledger. Principal only; invoice payments and interest remain separate.
begin;

create table if not exists public.accounting_loans (
  id uuid primary key,
  entity_id uuid not null references public.accounting_entities(id),
  liability_account_id uuid not null references public.accounting_accounts(id),
  lender_name text not null check (length(trim(lender_name)) between 3 and 200),
  lender_tax_id text,
  principal_clp numeric(20,4) not null check (principal_clp>0 and principal_clp=trunc(principal_clp)),
  received_on date not null,
  due_on date,
  interest_terms text not null default 'unknown' check (interest_terms in ('unknown','none','agreed')),
  terms_notes text not null default '',
  purpose text not null default '',
  invoice_reference text not null default '',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (due_on is null or due_on>=received_on),
  check (interest_terms<>'agreed' or length(trim(terms_notes))>=5)
);
create table if not exists public.accounting_loan_movements (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.accounting_loans(id),
  kind text not null check (kind in ('received','repayment')),
  amount_clp numeric(20,4) not null check (amount_clp>0),
  bank_transaction_id uuid not null unique references public.accounting_bank_transactions(id),
  entry_id uuid not null unique references public.accounting_journal_entries(id),
  reconciliation_id uuid not null unique references public.accounting_reconciliations(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists accounting_loan_one_receipt on public.accounting_loan_movements(loan_id) where kind='received';
create index if not exists accounting_loans_entity_date on public.accounting_loans(entity_id,received_on desc,id);
alter table public.accounting_loans enable row level security;
alter table public.accounting_loan_movements enable row level security;
drop policy if exists accounting_loans_read on public.accounting_loans;
create policy accounting_loans_read on public.accounting_loans for select to authenticated
  using (public.accounting_has_permission('accounting.ledger.view'));
drop policy if exists accounting_loan_movements_read on public.accounting_loan_movements;
create policy accounting_loan_movements_read on public.accounting_loan_movements for select to authenticated
  using (public.accounting_has_permission('accounting.ledger.view'));
revoke all on public.accounting_loans, public.accounting_loan_movements from anon, authenticated;
grant select on public.accounting_loans, public.accounting_loan_movements to authenticated;
grant all on public.accounting_loans, public.accounting_loan_movements to service_role;

insert into public.accounting_accounts(entity_id,code,name,parent_id,level,account_type,normal_balance,currency,classification,allows_posting,active,source_type)
select e.id,'2.1.31','Prestamos recibidos de terceros',a.id,3,'liability','credit','CLP','loan_payable',true,true,'MANUAL'
from public.accounting_entities e join public.accounting_accounts a on a.entity_id=e.id and a.code='2.1'
on conflict(entity_id,code) do nothing;

create or replace function public.accounting_save_loan(p_payload jsonb,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_id uuid := (p_payload->>'id')::uuid;
  v_entity uuid := (p_payload->>'entity_id')::uuid;
  v_account uuid := (p_payload->>'liability_account_id')::uuid;
  v_old public.accounting_loans%rowtype;
begin
  if auth.role() is distinct from 'service_role' or not exists(select 1 from public.profiles where id=p_actor_id and active and role::text in ('administrador','finanzas')) then
    raise exception 'No tienes permiso para registrar prestamos.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_id::text,0));
  select * into v_old from public.accounting_loans where id=v_id for update;
  if found and (v_old.entity_id<>v_entity or exists(select 1 from public.accounting_loan_movements where loan_id=v_id)) then
    raise exception 'El prestamo ya tiene movimientos o pertenece a otra entidad; no se puede modificar.';
  end if;
  if not exists(select 1 from public.accounting_entities where id=v_entity and active) or not exists(
    select 1 from public.accounting_accounts where id=v_account and entity_id=v_entity and active and allows_posting
    and account_type='liability' and currency='CLP' and classification in ('related_party_loan_payable','loan_payable')
  ) then raise exception 'Selecciona una cuenta de prestamos CLP activa de esta entidad.'; end if;
  if length(coalesce(p_payload->>'terms_notes',''))>1000 or length(coalesce(p_payload->>'purpose',''))>1000 or length(coalesce(p_payload->>'invoice_reference',''))>200
    or length(coalesce(p_payload->>'lender_tax_id',''))>30 then raise exception 'El detalle excede la longitud admitida.'; end if;
  if coalesce((p_payload->>'principal_clp')::numeric,0)>999999999999 then raise exception 'Monto fuera de rango.'; end if;
  insert into public.accounting_loans(id,entity_id,liability_account_id,lender_name,lender_tax_id,principal_clp,received_on,due_on,interest_terms,terms_notes,purpose,invoice_reference,created_by)
  values(v_id,v_entity,v_account,trim(p_payload->>'lender_name'),nullif(trim(p_payload->>'lender_tax_id'),''),(p_payload->>'principal_clp')::numeric,
    (p_payload->>'received_on')::date,nullif(p_payload->>'due_on','')::date,coalesce(p_payload->>'interest_terms','unknown'),coalesce(p_payload->>'terms_notes',''),
    coalesce(p_payload->>'purpose',''),coalesce(p_payload->>'invoice_reference',''),p_actor_id)
  on conflict(id) do update set liability_account_id=excluded.liability_account_id,lender_name=excluded.lender_name,lender_tax_id=excluded.lender_tax_id,
    principal_clp=excluded.principal_clp,received_on=excluded.received_on,due_on=excluded.due_on,interest_terms=excluded.interest_terms,terms_notes=excluded.terms_notes,
    purpose=excluded.purpose,invoice_reference=excluded.invoice_reference,updated_at=now();
  insert into public.accounting_audit_events(entity_id,actor_id,action,entity_type,entity_id_text,new_value)
  values(v_entity,p_actor_id,'loan.draft_saved','loan',v_id::text,p_payload);
  return v_id;
end $$;

create or replace function public.accounting_loan_action(p_loan_id uuid,p_kind text,p_transaction_id uuid,p_actor_id uuid,p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_loan public.accounting_loans%rowtype;
  v_tx public.accounting_bank_transactions%rowtype;
  v_existing public.accounting_loan_movements%rowtype;
  v_bank public.accounting_bank_accounts%rowtype;
  v_stage public.accounting_journal_entries%rowtype;
  v_period uuid;
  v_suspense uuid;
  v_counter uuid;
  v_amount numeric;
  v_received numeric;
  v_repaid numeric;
  v_lines jsonb;
  v_entry uuid;
  v_rec uuid;
  v_meta jsonb;
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' or not exists(select 1 from public.profiles where id=p_actor_id and active and role::text in ('administrador','finanzas')) then
    raise exception 'No tienes permiso para contabilizar prestamos.';
  end if;
  if p_kind not in ('received','repayment') or p_kind is null then raise exception 'Tipo de movimiento invalido.'; end if;
  select * into strict v_loan from public.accounting_loans where id=p_loan_id for update;
  if not exists(select 1 from public.accounting_entities where id=v_loan.entity_id and active) then raise exception 'La entidad esta inactiva.'; end if;
  select * into strict v_tx from public.accounting_bank_transactions where id=p_transaction_id and entity_id=v_loan.entity_id for update;
  select * into v_existing from public.accounting_loan_movements where bank_transaction_id=p_transaction_id;
  if found then
    if v_existing.loan_id<>p_loan_id or v_existing.kind<>p_kind then raise exception 'Este movimiento ya pertenece a otro registro.'; end if;
    if not exists(select 1 from public.accounting_journal_entries where id=v_existing.entry_id and status='posted') then
      raise exception 'El asiento fue reversado; requiere revision contable.';
    end if;
    return jsonb_build_object('existing',true,'entryId',v_existing.entry_id,'amountClp',v_existing.amount_clp,'loanId',p_loan_id);
  end if;
  if not exists(select 1 from public.accounting_accounts where id=v_loan.liability_account_id and entity_id=v_loan.entity_id and active and allows_posting
    and account_type='liability' and currency='CLP' and classification in ('related_party_loan_payable','loan_payable')) then raise exception 'La cuenta de prestamo no es valida.'; end if;
  if v_tx.currency<>'CLP' or v_tx.amount<>v_tx.amount_clp or abs(v_tx.amount_clp)<>trunc(abs(v_tx.amount_clp)) then raise exception 'Solo se admiten movimientos de capital en pesos CLP.'; end if;
  if v_tx.reconciliation_status not in ('unmatched','proposed') or coalesce(v_tx.metadata->>'classification_locked','false')='true'
    or nullif(v_tx.metadata->>'verified_classification','') is not null
    or exists(select 1 from public.accounting_reconciliations where bank_transaction_id=v_tx.id and status='confirmed') then
    raise exception 'El movimiento ya tiene conciliacion o clasificacion; revisa el registro existente.';
  end if;
  if (p_kind='received' and v_tx.amount_clp<=0) or (p_kind='repayment' and v_tx.amount_clp>=0) then raise exception 'El signo del movimiento no corresponde a la operacion.'; end if;
  v_amount:=abs(v_tx.amount_clp);
  select coalesce(sum(m.amount_clp) filter(where m.kind='received'),0),coalesce(sum(m.amount_clp) filter(where m.kind='repayment'),0)
    into v_received,v_repaid from public.accounting_loan_movements m join public.accounting_journal_entries e on e.id=m.entry_id where m.loan_id=p_loan_id and e.status='posted';
  if exists(select 1 from public.accounting_loan_movements m join public.accounting_journal_entries e on e.id=m.entry_id where m.loan_id=p_loan_id and e.status<>'posted') then
    raise exception 'Este prestamo tiene asientos reversados; revisa antes de agregar movimientos.';
  end if;
  if p_kind='received' and (v_received>0 or v_amount<>v_loan.principal_clp or v_tx.transaction_date<>v_loan.received_on) then
    raise exception 'El ingreso debe coincidir con el monto y fecha del prestamo, sin duplicar la recepcion.';
  end if;
  if p_kind='repayment' and (v_received<=0 or v_amount>v_received-v_repaid or v_tx.transaction_date<v_loan.received_on) then
    raise exception 'El abono excede el capital pendiente o es anterior a la recepcion.';
  end if;
  select id into v_period from public.accounting_periods where entity_id=v_loan.entity_id and v_tx.transaction_date between starts_on and ends_on and status<>'closed' order by starts_on limit 1 for update;
  if v_period is null or v_tx.transaction_date>(now() at time zone 'America/Santiago')::date then raise exception 'No hay periodo abierto para la fecha bancaria, o la fecha es futura.'; end if;
  select * into strict v_bank from public.accounting_bank_accounts where id=v_tx.bank_account_id and entity_id=v_loan.entity_id and active and currency='CLP';
  if not exists(select 1 from public.accounting_accounts where id=v_bank.ledger_account_id and entity_id=v_loan.entity_id
    and active and allows_posting and account_type='asset' and coalesce(currency,'CLP')='CLP') then raise exception 'La cuenta contable bancaria CLP no es valida.'; end if;
  select id into strict v_suspense from public.accounting_accounts where entity_id=v_loan.entity_id and active and allows_posting
    and coalesce(currency,'CLP')='CLP' and classification=case when p_kind='received' then 'suspense_liability' else 'suspense_asset' end;
  select * into v_stage from public.accounting_journal_entries where entity_id=v_loan.entity_id and idempotency_key='bank-transaction:'||v_tx.id::text for update;
  v_counter:=v_bank.ledger_account_id;
  if v_stage.id is not null then
    if v_stage.status<>'posted' or (select count(*) from public.accounting_journal_lines where entry_id=v_stage.id)<>2
      or not exists(select 1 from public.accounting_journal_lines where entry_id=v_stage.id and account_id=v_bank.ledger_account_id
        and debit_clp=case when p_kind='received' then v_amount else 0 end and credit_clp=case when p_kind='received' then 0 else v_amount end)
      or not exists(select 1 from public.accounting_journal_lines where entry_id=v_stage.id and account_id=v_suspense
        and debit_clp=case when p_kind='received' then 0 else v_amount end and credit_clp=case when p_kind='received' then v_amount else 0 end) then
      raise exception 'El asiento bancario previo no coincide; requiere revision para no duplicar caja.';
    end if;
    v_counter:=v_suspense;
  end if;
  if exists(select 1 from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id=l.entry_id
    where e.entity_id=v_loan.entity_id and e.status in ('posted','reversed')
    and (l.metadata->>'bank_transaction_id'=v_tx.id::text or l.metadata->'bank_transaction_ids' @> jsonb_build_array(v_tx.id::text))
    and e.id is distinct from v_stage.id) then raise exception 'Hay otros asientos asociados al movimiento; revisa antes de contabilizar.'; end if;
  v_meta:=jsonb_build_object('loan_id',p_loan_id,'loan_kind',p_kind,'bank_transaction_id',v_tx.id,'lender',v_loan.lender_name);
  v_lines:=jsonb_build_array(
    jsonb_build_object('account_id',case when p_kind='received' then v_counter else v_loan.liability_account_id end,'debit_clp',v_amount,'credit_clp',0,'metadata',v_meta),
    jsonb_build_object('account_id',case when p_kind='received' then v_loan.liability_account_id else v_counter end,'debit_clp',0,'credit_clp',v_amount,'metadata',v_meta));
  v_result:=jsonb_build_object('loanId',p_loan_id,'kind',p_kind,'amountClp',v_amount,'date',v_tx.transaction_date,'staged',v_stage.id is not null,
    'balanceAfter',case when p_kind='received' then v_amount else v_received-v_repaid-v_amount end,'lines',v_lines,'existing',false);
  if p_confirm is not true then return v_result; end if;
  v_rec:=gen_random_uuid();
  v_entry:=public.accounting_create_journal_entry(jsonb_build_object('entity_id',v_loan.entity_id,'entry_date',v_tx.transaction_date,
    'description',case when p_kind='received' then 'Prestamo recibido de ' else 'Devolucion de capital a ' end||v_loan.lender_name,
    'reference','PRESTAMO-'||p_loan_id::text,'idempotency_key','bank-reconciliation:'||v_rec::text,'currency','CLP','exchange_rate',1,'lines',v_lines),p_actor_id);
  update public.accounting_journal_entries set source_module='loans' where id=v_entry;
  perform public.accounting_post_journal_entry(v_entry);
  insert into public.accounting_reconciliations(id,entity_id,bank_transaction_id,status,confidence,score,matched_amount_clp,explanation,confirmed_by,confirmed_at)
  values(v_rec,v_loan.entity_id,v_tx.id,'confirmed','manual',1,v_amount,'Capital de prestamo: '||v_loan.lender_name,p_actor_id,now());
  insert into public.accounting_reconciliation_links(reconciliation_id,target_type,target_id,target_reference,allocated_amount_clp)
  values(v_rec,'journal_entry',v_entry,'loan_'||p_kind,v_amount);
  update public.accounting_reconciliations set status='rejected',updated_at=now() where bank_transaction_id=v_tx.id and status='proposed';
  insert into public.accounting_loan_movements(loan_id,kind,amount_clp,bank_transaction_id,entry_id,reconciliation_id,created_by)
  values(p_loan_id,p_kind,v_amount,v_tx.id,v_entry,v_rec,p_actor_id);
  update public.accounting_bank_transactions set reconciliation_status='matched',metadata=metadata||jsonb_build_object(
    'loan_id',p_loan_id,'verified_classification','loan_'||p_kind,'classification_locked',true,'classification_policy','loan_subledger',
    'classified_amount_clp',v_amount,'loan_entry_id',v_entry),updated_at=now() where id=v_tx.id;
  insert into public.accounting_audit_events(entity_id,actor_id,action,entity_type,entity_id_text,new_value)
  values(v_loan.entity_id,p_actor_id,'loan.'||p_kind,'loan',p_loan_id::text,v_result||jsonb_build_object('entry_id',v_entry,'bank_transaction_id',v_tx.id));
  return v_result||jsonb_build_object('entryId',v_entry);
end $$;
revoke all on function public.accounting_save_loan(jsonb,uuid) from public,anon,authenticated;
revoke all on function public.accounting_loan_action(uuid,text,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.accounting_save_loan(jsonb,uuid),public.accounting_loan_action(uuid,text,uuid,uuid,boolean) to service_role;
commit;
