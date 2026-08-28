-- Clasificaciones bancarias aprobadas por Gerencia y cheques vigentes en cartera.
-- Idempotente: puede ejecutarse nuevamente sin duplicar asientos ni conciliaciones.

create or replace function public.accounting_apply_approved_named_classifications(
  p_entity_id uuid,
  p_from date default date '2026-01-01',
  p_to date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent_assets uuid;
  v_suspense_asset uuid;
  v_payroll_payable uuid;
  v_payroll_expense uuid;
  v_payroll_withholdings uuid;
  v_payroll_contributions uuid;
  v_legal_fees uuid;
  v_internal_clearing uuid;
  v_payroll_balance numeric(20,4);
  v_withholdings_balance numeric(20,4);
  v_rule text;
  v_total numeric(20,4);
  v_existing numeric(20,4);
  v_remaining numeric(20,4);
  v_liability numeric(20,4);
  v_expense numeric(20,4);
  v_period uuid;
  v_entry uuid;
  v_existing_entry uuid;
  v_prior_entry uuid;
  v_entry_key text;
  v_reconciliation uuid;
  v_count integer := 0;
  v_amount numeric(20,4) := 0;
  v_prior_amount numeric(20,4);
  v_approved_amount numeric(20,4);
  v_by_rule jsonb := '{}'::jsonb;
  v_tx public.accounting_bank_transactions%rowtype;
begin
  if p_entity_id is null or p_from is null or p_to is null or p_from > p_to then
    raise exception 'Entidad y rango de fechas válidos son obligatorios.';
  end if;

  select id into v_parent_assets
  from public.accounting_accounts
  where entity_id=p_entity_id and code='1.1';

  insert into public.accounting_accounts(
    entity_id,code,name,parent_id,level,account_type,normal_balance,currency,
    classification,allows_posting,active,source_type,metadata
  ) values
    (p_entity_id,'1.1.98','Transferencias internas por conciliar',v_parent_assets,3,'asset','debit','CLP',
     'internal_transfer_clearing',true,true,'SYSTEM','{"approved_rule":"own_company_transfer"}'::jsonb),
    (p_entity_id,'6.1.12','Cotizaciones previsionales',null,3,'expense','debit','CLP',
     'payroll_contributions_expense',true,true,'SYSTEM','{"approved_rule":"previred"}'::jsonb),
    (p_entity_id,'6.1.20','Honorarios legales',null,3,'expense','debit','CLP',
     'legal_fees',true,true,'SYSTEM','{"approved_rule":"lena_and_cia"}'::jsonb)
  on conflict (entity_id,code) do nothing;

  select id into strict v_suspense_asset from public.accounting_accounts
   where entity_id=p_entity_id and classification='suspense_asset' and active and allows_posting;
  select id into strict v_payroll_payable from public.accounting_accounts
   where entity_id=p_entity_id and classification='payroll_payable' and active and allows_posting;
  select id into strict v_payroll_expense from public.accounting_accounts
   where entity_id=p_entity_id and classification='payroll_expense' and active and allows_posting;
  select id into strict v_payroll_withholdings from public.accounting_accounts
   where entity_id=p_entity_id and classification='payroll_withholdings' and active and allows_posting;
  select id into strict v_payroll_contributions from public.accounting_accounts
   where entity_id=p_entity_id and classification='payroll_contributions_expense' and active and allows_posting;
  select id into strict v_legal_fees from public.accounting_accounts
   where entity_id=p_entity_id and classification='legal_fees' and active and allows_posting;
  select id into strict v_internal_clearing from public.accounting_accounts
   where entity_id=p_entity_id and classification='internal_transfer_clearing' and active and allows_posting;

  select coalesce(sum(l.credit_clp-l.debit_clp),0) into v_payroll_balance
  from public.accounting_journal_lines l
  join public.accounting_journal_entries e on e.id=l.entry_id
  where e.entity_id=p_entity_id and e.status in ('posted','reversed') and l.account_id=v_payroll_payable;

  select coalesce(sum(l.credit_clp-l.debit_clp),0) into v_withholdings_balance
  from public.accounting_journal_lines l
  join public.accounting_journal_entries e on e.id=l.entry_id
  where e.entity_id=p_entity_id and e.status in ('posted','reversed') and l.account_id=v_payroll_withholdings;

  for v_tx in
    select t.*
    from public.accounting_bank_transactions t
    where t.entity_id=p_entity_id
      and t.transaction_date between p_from and p_to
      and t.amount_clp < 0
      and t.reconciliation_status <> 'ignored'
      and (
        lower(t.description) like '%sisla%'
        or lower(t.description) like '%marco sanhueza%'
        or lower(t.description) like '%previred%'
        or regexp_replace(coalesce(t.description,''),'[^0-9]','','g') like '%761617540%'
        or lower(t.description) like '%asistencia judi%'
        or lower(t.description) like '%lena%cia%'
        or lower(t.description) like '%importadora latin chile%'
        or lower(t.description) like '%importadora lat%'
      )
    order by t.transaction_date,t.created_at,t.id
  loop
    v_rule := case
      when lower(v_tx.description) like '%sisla%' then 'salary_sisla'
      when lower(v_tx.description) like '%marco sanhueza%' then 'salary_marco'
      when lower(v_tx.description) like '%previred%' then 'pension_previred'
      when regexp_replace(coalesce(v_tx.description,''),'[^0-9]','','g') like '%761617540%'
        or lower(v_tx.description) like '%asistencia judi%'
        or lower(v_tx.description) like '%lena%cia%' then 'legal_lena'
      else 'internal_transfer'
    end;
    v_total := abs(v_tx.amount_clp);
    v_existing := 0;
    v_existing_entry := null;
    v_prior_entry := null;
    v_prior_amount := 0;
    v_approved_amount := 0;

    if v_rule='pension_previred' then
      select coalesce(sum(l.debit_clp),0),min(e.id::text)::uuid
        into v_prior_amount,v_prior_entry
      from public.accounting_journal_entries e
      join public.accounting_journal_lines l on l.entry_id=e.id
      where e.entity_id=p_entity_id and e.status='posted'
        and e.idempotency_key='bank-payroll-settlement:'||v_tx.id::text||':payroll_withholdings'
        and l.account_id=v_payroll_withholdings;
    elsif v_rule='internal_transfer' and v_tx.reconciliation_status='matched' then
      select v_total,min(e.id::text)::uuid into v_prior_amount,v_prior_entry
      from public.accounting_journal_entries e
      where e.entity_id=p_entity_id and e.status='posted'
        and e.idempotency_key like 'bank-internal-transfer:%'
        and coalesce(e.reference,'') like '%'||v_tx.id::text||'%';
      v_prior_amount := coalesce(v_prior_amount,0);
    end if;

    v_existing := v_prior_amount;
    v_existing_entry := v_prior_entry;

    v_entry_key := 'bank-approved-classification:'||v_tx.id::text||':'||v_rule;
    select id into v_entry from public.accounting_journal_entries
    where entity_id=p_entity_id and idempotency_key=v_entry_key;

    if v_entry is not null then
      select coalesce(sum(debit_clp),0) into v_approved_amount
      from public.accounting_journal_lines
      where entry_id=v_entry and account_id<>v_suspense_asset;
      v_existing := least(v_total,v_existing+coalesce(v_approved_amount,0));
    end if;

    v_remaining := greatest(v_total-v_existing,0);
    if v_remaining > 0.005 and v_entry is null then
      select id into v_period
      from public.accounting_periods
      where entity_id=p_entity_id and v_tx.transaction_date between starts_on and ends_on and status<>'closed'
      order by starts_on limit 1;
      if v_period is null then
        raise exception 'No existe período abierto para %.',v_tx.transaction_date;
      end if;

      insert into public.accounting_journal_entries(
        entity_id,period_id,entry_date,description,reference,source_type,source_module,
        idempotency_key,currency,exchange_rate,status,created_at,updated_at
      ) values (
        p_entity_id,v_period,v_tx.transaction_date,
        case v_rule
          when 'salary_sisla' then 'Pago de remuneración a Sisla Muñoz'
          when 'salary_marco' then 'Pago de remuneración a Marco Sanhueza'
          when 'pension_previred' then 'Pago de cotizaciones previsionales PREVIRED'
          when 'legal_lena' then 'Pago de honorarios legales Lena & Cia'
          else 'Transferencia entre cuentas de Importadora Latin Chile'
        end,
        coalesce(v_tx.operation_number,v_tx.reference,v_tx.id::text),'SYSTEM','accounting',
        v_entry_key,'CLP',1,'validated',now(),now()
      ) returning id into v_entry;

      if v_rule in ('salary_sisla','salary_marco') then
        v_liability := least(v_remaining,greatest(v_payroll_balance,0));
        v_expense := v_remaining-v_liability;
        if v_liability > 0.005 then
          insert into public.accounting_journal_lines(entry_id,line_number,account_id,description,debit_clp,credit_clp,currency,exchange_rate,metadata)
          values (v_entry,1,v_payroll_payable,'Disminución de remuneraciones devengadas por pagar',v_liability,0,'CLP',1,
                  jsonb_build_object('bank_transaction_id',v_tx.id,'approved_rule',v_rule));
        end if;
        if v_expense > 0.005 then
          insert into public.accounting_journal_lines(entry_id,line_number,account_id,description,debit_clp,credit_clp,currency,exchange_rate,metadata)
          values (v_entry,case when v_liability>0.005 then 2 else 1 end,v_payroll_expense,
                  'Remuneración sin devengo previo disponible',v_expense,0,'CLP',1,
                  jsonb_build_object('bank_transaction_id',v_tx.id,'approved_rule',v_rule));
        end if;
        v_payroll_balance := greatest(v_payroll_balance-v_liability,0);
      elsif v_rule='pension_previred' then
        v_liability := least(v_remaining,greatest(v_withholdings_balance,0));
        v_expense := v_remaining-v_liability;
        if v_liability > 0.005 then
          insert into public.accounting_journal_lines(entry_id,line_number,account_id,description,debit_clp,credit_clp,currency,exchange_rate,metadata)
          values (v_entry,1,v_payroll_withholdings,'Disminución de cotizaciones devengadas por pagar',v_liability,0,'CLP',1,
                  jsonb_build_object('bank_transaction_id',v_tx.id,'approved_rule',v_rule));
        end if;
        if v_expense > 0.005 then
          insert into public.accounting_journal_lines(entry_id,line_number,account_id,description,debit_clp,credit_clp,currency,exchange_rate,metadata)
          values (v_entry,case when v_liability>0.005 then 2 else 1 end,v_payroll_contributions,
                  'Cotización previsional sin devengo previo disponible',v_expense,0,'CLP',1,
                  jsonb_build_object('bank_transaction_id',v_tx.id,'approved_rule',v_rule));
        end if;
        v_withholdings_balance := greatest(v_withholdings_balance-v_liability,0);
      elsif v_rule='legal_lena' then
        insert into public.accounting_journal_lines(entry_id,line_number,account_id,description,debit_clp,credit_clp,currency,exchange_rate,metadata)
        values (v_entry,1,v_legal_fees,'Asesoría jurídica Lena & Cia',v_remaining,0,'CLP',1,
                jsonb_build_object('bank_transaction_id',v_tx.id,'approved_rule',v_rule));
      else
        insert into public.accounting_journal_lines(entry_id,line_number,account_id,description,debit_clp,credit_clp,currency,exchange_rate,metadata)
        values (v_entry,1,v_internal_clearing,'Fondos enviados a otra cuenta propia; receptor pendiente de pareo',v_remaining,0,'CLP',1,
                jsonb_build_object('bank_transaction_id',v_tx.id,'approved_rule',v_rule));
      end if;

      insert into public.accounting_journal_lines(entry_id,line_number,account_id,description,debit_clp,credit_clp,currency,exchange_rate,metadata)
      select v_entry,coalesce(max(line_number),0)+1,v_suspense_asset,
             'Liberación del egreso bancario transitorio',0,v_remaining,'CLP',1,
             jsonb_build_object('bank_transaction_id',v_tx.id,'approved_rule',v_rule)
      from public.accounting_journal_lines where entry_id=v_entry;

      if not exists (
        select 1 from public.accounting_journal_lines where entry_id=v_entry
        group by entry_id having sum(debit_clp)=sum(credit_clp) and sum(debit_clp)>0
      ) then raise exception 'Asiento descuadrado para movimiento %.',v_tx.id; end if;

      update public.accounting_journal_entries
      set status='posted',posted_at=now(),updated_at=now()
      where id=v_entry;
      insert into public.accounting_audit_events(entity_id,action,entity_type,entity_id_text,reason,new_value)
      values (p_entity_id,'journal.posted','journal_entry',v_entry::text,
              'Clasificación empresarial aprobada por Gerencia',
              jsonb_build_object('bank_transaction_id',v_tx.id,'rule',v_rule,'amount_clp',v_remaining));
      v_existing_entry := v_entry;
      v_approved_amount := v_remaining;
      v_count := v_count+1;
      v_amount := v_amount+v_remaining;
      v_by_rule := jsonb_set(v_by_rule,array[v_rule],to_jsonb(coalesce((v_by_rule->>v_rule)::integer,0)+1),true);
    end if;

    select id into v_reconciliation
    from public.accounting_reconciliations
    where bank_transaction_id=v_tx.id and status='confirmed'
      and explanation like 'Clasificación empresarial aprobada:%'
    order by created_at limit 1;
    if v_reconciliation is null then
      insert into public.accounting_reconciliations(
        entity_id,bank_transaction_id,status,confidence,score,matched_amount_clp,explanation,confirmed_at
      ) values (
        p_entity_id,v_tx.id,'confirmed','manual',1,v_total,
        'Clasificación empresarial aprobada: '||v_rule,now()
      ) returning id into v_reconciliation;
    else
      update public.accounting_reconciliations
      set matched_amount_clp=v_total,updated_at=now()
      where id=v_reconciliation;
    end if;

    if v_prior_entry is not null and v_prior_amount > 0.005 and not exists (
      select 1 from public.accounting_reconciliation_links
      where reconciliation_id=v_reconciliation and target_type='journal_entry' and target_id=v_prior_entry
    ) then
      insert into public.accounting_reconciliation_links(
        reconciliation_id,target_type,target_id,target_reference,allocated_amount_clp
      ) values (v_reconciliation,'journal_entry',v_prior_entry,v_rule,least(v_prior_amount,v_total));
    end if;
    if v_entry is not null and v_approved_amount > 0.005 and not exists (
      select 1 from public.accounting_reconciliation_links
      where reconciliation_id=v_reconciliation and target_type='journal_entry' and target_id=v_entry
    ) then
      insert into public.accounting_reconciliation_links(
        reconciliation_id,target_type,target_id,target_reference,allocated_amount_clp
      ) values (
        v_reconciliation,'journal_entry',v_entry,v_rule,
        least(v_approved_amount,greatest(v_total-v_prior_amount,0))
      );
    end if;

    update public.accounting_bank_transactions
    set reconciliation_status='matched',
        metadata=metadata||jsonb_build_object(
          'verified_classification',v_rule,
          'classified_amount_clp',v_total,
          'classification_policy','management_approved_named_rule',
          'classified_at',now()
        ),
        updated_at=now()
    where id=v_tx.id;
  end loop;

  return jsonb_build_object('entries_created',v_count,'amount_classified_clp',v_amount,'by_rule',v_by_rule);
end;
$$;

revoke all on function public.accounting_apply_approved_named_classifications(uuid,date,date) from public;
grant execute on function public.accounting_apply_approved_named_classifications(uuid,date,date) to service_role;

do $$
declare
  v_entity constant uuid := '4f06ba88-ea62-4a10-a962-b9902ddd5021';
  v_row record;
  v_check uuid;
begin
  for v_row in
    select * from (values
      ('331','151949'::numeric,date '2026-09-02'),
      ('350','675137'::numeric,date '2026-10-11'),
      ('351','342895'::numeric,date '2026-10-24')
    ) as x(check_number,amount_clp,due_on)
  loop
    insert into public.accounting_checks(
      entity_id,customer_name,bank_name,check_number,amount_clp,received_on,due_on,status,
      source_business_key,bank_evidence_status,notes
    ) values (
      v_entity,'Climatiza MyM SpA','Santander',v_row.check_number,v_row.amount_clp,
      date '2026-08-28',v_row.due_on,'portfolio','manual-check:climatiza-mym:'||v_row.check_number,
      'pending','Cheque en cartera verificado desde evidencia fotográfica proporcionada por Gerencia.'
    )
    on conflict (entity_id,source_business_key) where source_business_key is not null
    do update set customer_name=excluded.customer_name,bank_name=excluded.bank_name,
      check_number=excluded.check_number,amount_clp=excluded.amount_clp,received_on=excluded.received_on,
      due_on=excluded.due_on,status='portfolio',bank_evidence_status='pending',notes=excluded.notes,updated_at=now()
    returning id into v_check;

    if not exists (
      select 1 from public.accounting_audit_events
      where entity_id=v_entity and action='check.portfolio_verified' and entity_id_text=v_check::text
    ) then
      insert into public.accounting_audit_events(entity_id,action,entity_type,entity_id_text,reason,new_value)
      values (v_entity,'check.portfolio_verified','check',v_check::text,'Estado de cartera informado por Gerencia',
              jsonb_build_object('check_number',v_row.check_number,'amount_clp',v_row.amount_clp,'due_on',v_row.due_on));
    end if;
  end loop;
end;
$$;

select public.accounting_apply_approved_named_classifications(
  '4f06ba88-ea62-4a10-a962-b9902ddd5021',date '2026-01-01',date '2026-08-28'
) as result;
