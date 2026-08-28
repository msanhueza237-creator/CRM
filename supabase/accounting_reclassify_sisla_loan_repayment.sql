-- Reclasifica los cinco egresos del 23-06-2026 informados por Gerencia como
-- devolución de préstamo de Sisla Muñoz. No modifica ni elimina asientos
-- contabilizados: crea un ajuste trazable que retira CLP 22.000.000 de
-- remuneraciones y los lleva a una obligación con parte relacionada.
--
-- La cuenta queda sujeta a revisión hasta incorporar el respaldo del préstamo
-- original. El script es idempotente y falla si la evidencia bancaria cambió.

do $$
declare
  v_entity constant uuid := '4f06ba88-ea62-4a10-a962-b9902ddd5021';
  v_transaction_ids constant uuid[] := array[
    'ad3aad37-f3df-4331-b691-f4cb562bfa64'::uuid,
    'ba8f85f6-4c49-4d44-bb6c-f67671f0073b'::uuid,
    'bce2639a-d50e-4227-bbf3-0facd4957483'::uuid,
    'ef12ab4f-fac6-48b5-9777-bb6531957f00'::uuid,
    'f6ad1cbb-34de-43ba-adb9-70802aa9ee66'::uuid
  ];
  v_expected_total constant numeric(20,4) := 22000000;
  v_parent uuid;
  v_loan_account uuid;
  v_payroll_expense uuid;
  v_period uuid;
  v_entry uuid;
  v_transaction_count integer;
  v_transaction_total numeric(20,4);
  v_payroll_total numeric(20,4);
begin
  select count(*),coalesce(sum(abs(amount_clp)),0)
    into v_transaction_count,v_transaction_total
  from public.accounting_bank_transactions
  where entity_id=v_entity
    and id=any(v_transaction_ids)
    and transaction_date=date '2026-06-23'
    and amount_clp<0
    and lower(description) like '%sisla%';

  if v_transaction_count<>5 or v_transaction_total<>v_expected_total then
    raise exception 'La evidencia bancaria de Sisla no coincide: % movimientos por CLP %.',
      v_transaction_count,v_transaction_total;
  end if;

  select coalesce(sum(l.debit_clp-l.credit_clp),0)
    into v_payroll_total
  from public.accounting_journal_lines l
  join public.accounting_journal_entries e on e.id=l.entry_id
  join public.accounting_accounts a on a.id=l.account_id
  where e.entity_id=v_entity
    and e.status='posted'
    and a.classification='payroll_expense'
    and l.metadata->>'bank_transaction_id'=any(
      select unnest(v_transaction_ids)::text
    );

  if v_payroll_total<>v_expected_total then
    raise exception 'La clasificación contable previa no coincide: remuneraciones CLP %.',v_payroll_total;
  end if;

  select id into strict v_parent
  from public.accounting_accounts
  where entity_id=v_entity and code='2.1';

  insert into public.accounting_accounts(
    entity_id,code,name,parent_id,level,account_type,normal_balance,currency,
    classification,allows_posting,active,source_type,metadata
  ) values (
    v_entity,'2.1.30','Préstamo parte relacionada - Sisla Muñoz',v_parent,3,
    'liability','credit','CLP','related_party_loan_payable',true,true,'MANUAL',
    jsonb_build_object(
      'counterparty','Sisla Muñoz',
      'management_confirmed',true,
      'confirmed_principal_clp',v_expected_total,
      'confirmation_date','2026-08-28'
    )
  )
  on conflict (entity_id,code) do update
  set name=excluded.name,
      classification=excluded.classification,
      metadata=public.accounting_accounts.metadata||excluded.metadata,
      updated_at=now()
  returning id into v_loan_account;

  select id into strict v_payroll_expense
  from public.accounting_accounts
  where entity_id=v_entity and classification='payroll_expense' and active and allows_posting;

  select id into strict v_period
  from public.accounting_periods
  where entity_id=v_entity
    and date '2026-06-23' between starts_on and ends_on
    and status<>'closed'
  order by starts_on
  limit 1;

  select id into v_entry
  from public.accounting_journal_entries
  where entity_id=v_entity
    and idempotency_key='management-adjustment:sisla-loan-repayment:2026-06-23';

  if v_entry is null then
    insert into public.accounting_journal_entries(
      entity_id,period_id,entry_date,description,reference,source_type,source_module,
      idempotency_key,currency,exchange_rate,status,created_at,updated_at
    ) values (
      v_entity,v_period,date '2026-06-23',
      'Reclasificación devolución de préstamo a Sisla Muñoz',
      'GERENCIA-SISLA-PRESTAMO-2026-06-23','MANUAL','accounting',
      'management-adjustment:sisla-loan-repayment:2026-06-23','CLP',1,'validated',now(),now()
    ) returning id into v_entry;

    insert into public.accounting_journal_lines(
      entry_id,line_number,account_id,description,debit_clp,credit_clp,
      original_amount,currency,exchange_rate,metadata
    ) values
      (v_entry,1,v_loan_account,
       'Disminución de préstamo de parte relacionada informada por Gerencia',
       v_expected_total,0,v_expected_total,'CLP',1,
       jsonb_build_object('management_classification','loan_repayment_sisla','bank_transaction_ids',v_transaction_ids)),
      (v_entry,2,v_payroll_expense,
       'Reversa de remuneraciones clasificadas como devolución de préstamo',
       0,v_expected_total,v_expected_total,'CLP',1,
       jsonb_build_object('management_classification','loan_repayment_sisla','bank_transaction_ids',v_transaction_ids));

    if not exists (
      select 1 from public.accounting_journal_lines
      where entry_id=v_entry
      group by entry_id
      having sum(debit_clp)=sum(credit_clp) and sum(debit_clp)=v_expected_total
    ) then
      raise exception 'El asiento de reclasificación de Sisla quedó descuadrado.';
    end if;

    update public.accounting_journal_entries
    set status='posted',posted_at=now(),updated_at=now()
    where id=v_entry;
  end if;

  update public.accounting_bank_transactions
  set metadata=metadata||jsonb_build_object(
        'verified_classification','loan_repayment_sisla',
        'classification_locked',true,
        'classification_policy','management_confirmed_loan_repayment',
        'loan_principal_amount_clp',abs(amount_clp),
        'classification_corrected_at',now(),
        'adjustment_entry_id',v_entry
      ),
      updated_at=now()
  where entity_id=v_entity and id=any(v_transaction_ids);

  update public.accounting_reconciliations
  set explanation='Clasificación empresarial aprobada: loan_repayment_sisla',updated_at=now()
  where bank_transaction_id=any(v_transaction_ids)
    and status='confirmed';

  update public.accounting_reconciliation_links l
  set target_reference='loan_repayment_sisla'
  from public.accounting_reconciliations r
  where r.id=l.reconciliation_id
    and r.bank_transaction_id=any(v_transaction_ids)
    and l.target_reference='salary_sisla';

  if not exists (
    select 1 from public.accounting_audit_events
    where entity_id=v_entity
      and action='bank.classification_corrected'
      and entity_id_text=v_entry::text
  ) then
    insert into public.accounting_audit_events(
      entity_id,action,entity_type,entity_id_text,reason,previous_value,new_value
    ) values (
      v_entity,'bank.classification_corrected','journal_entry',v_entry::text,
      'Gerencia confirmó que CLP 22.000.000 transferidos a Sisla Muñoz corresponden a devolución de préstamo.',
      jsonb_build_object('classification','salary_sisla','amount_clp',v_expected_total),
      jsonb_build_object(
        'classification','loan_repayment_sisla',
        'amount_clp',v_expected_total,
        'salary_transfer_remainder_clp',8349006,
        'bank_transaction_ids',v_transaction_ids
      )
    );
  end if;

  insert into public.accounting_control_findings(
    entity_id,control_code,severity,status,title,detail,entity_type,entity_reference,amount_clp,metadata
  ) values (
    v_entity,'RELATED_PARTY_LOAN_ORIGIN_SUPPORT','review','open',
    'Respaldar origen del préstamo de Sisla Muñoz',
    'La devolución de CLP 22.000.000 fue confirmada por Gerencia y retirada de remuneraciones. Falta relacionar el ingreso u asiento histórico que originó la obligación para que la cuenta de préstamo muestre su saldo completo.',
    'accounting_account','2.1.30',v_expected_total,
    jsonb_build_object('adjustment_entry_id',v_entry,'counterparty','Sisla Muñoz')
  )
  on conflict (entity_id,control_code,entity_type,entity_reference,status)
  do update set detail=excluded.detail,amount_clp=excluded.amount_clp,
    metadata=excluded.metadata,detected_at=now();
end;
$$;

select
  a.code,
  a.name,
  sum(l.debit_clp-l.credit_clp) as saldo_deudor_clp
from public.accounting_journal_lines l
join public.accounting_journal_entries e on e.id=l.entry_id
join public.accounting_accounts a on a.id=l.account_id
where e.entity_id='4f06ba88-ea62-4a10-a962-b9902ddd5021'
  and e.status='posted'
  and a.classification in ('payroll_expense','related_party_loan_payable')
group by a.code,a.name
order by a.code;
