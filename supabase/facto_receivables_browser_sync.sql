-- Facto receivables browser connector - local implementation phase.
-- Adds an auditable dry-run queue. Applying a preview only updates Facto's
-- reported operational balance; it never creates bank movements or journal entries.

begin;

alter table public.integration_sync_runs
  drop constraint if exists integration_sync_runs_status_check;

alter table public.integration_sync_runs
  add constraint integration_sync_runs_status_check
  check (status in (
    'pending','running','preview_ready','applying','completed','partial','failed','cancelled'
  ));

alter table public.integration_sync_runs
  add column if not exists entity_id uuid references public.accounting_entities(id) on delete restrict,
  add column if not exists task_id uuid references public.business_agent_tasks(id) on delete set null,
  add column if not exists requested_by uuid references auth.users(id) on delete set null,
  add column if not exists trigger_type text not null default 'manual',
  add column if not exists sync_method text not null default 'api_browser',
  add column if not exists run_mode text not null default 'dry_run',
  add column if not exists from_date date,
  add column if not exists to_date date,
  add column if not exists source_as_of timestamptz,
  add column if not exists correlation_id uuid not null default gen_random_uuid(),
  add column if not exists summary jsonb not null default '{}'::jsonb,
  add column if not exists coverage jsonb not null default '{}'::jsonb,
  add column if not exists error_message text,
  add column if not exists error_detail jsonb not null default '{}'::jsonb,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists duration_ms integer,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists integration_sync_runs_task_uidx
  on public.integration_sync_runs(task_id)
  where task_id is not null;

create index if not exists integration_sync_runs_facto_receivables_idx
  on public.integration_sync_runs(entity_id, provider, resource, created_at desc)
  where provider = 'facto' and resource = 'receivables';

create unique index if not exists integration_sync_runs_facto_receivables_active_uidx
  on public.integration_sync_runs(entity_id, provider, resource)
  where provider = 'facto' and resource = 'receivables'
    and status in ('pending','running','applying');

create index if not exists accounting_sources_facto_external_idx
  on public.accounting_source_documents(entity_id, external_id)
  where source_type = 'FACTO' and external_id is not null;

create index if not exists accounting_sources_facto_document_match_idx
  on public.accounting_source_documents(entity_id, document_type, folio, counterpart_tax_id)
  where source_type = 'FACTO';

create table if not exists public.integration_sync_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.integration_sync_runs(id) on delete restrict,
  entity_id uuid not null references public.accounting_entities(id) on delete restrict,
  provider text not null default 'facto' check (provider = 'facto'),
  resource text not null default 'receivables' check (resource = 'receivables'),
  external_id text,
  canonical_key text not null,
  action text not null check (action in (
    'create','update','close','unchanged','ambiguous','invalid'
  )),
  match_confidence text not null default 'none'
    check (match_confidence in ('exact','high','possible','none')),
  matched_source_document_id uuid references public.accounting_source_documents(id) on delete restrict,
  matched_receivable_id uuid references public.accounting_receivables(id) on delete restrict,
  previous_payload jsonb not null default '{}'::jsonb,
  normalized_payload jsonb not null check (jsonb_typeof(normalized_payload) = 'object'),
  raw_payload_hash text,
  normalized_hash text not null,
  validation_errors jsonb not null default '[]'::jsonb
    check (jsonb_typeof(validation_errors) = 'array'),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  observed_at timestamptz not null,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, canonical_key)
);

create index if not exists integration_sync_items_run_action_idx
  on public.integration_sync_items(run_id, action, created_at);

alter table public.integration_sync_items enable row level security;

drop policy if exists integration_sync_items_read on public.integration_sync_items;
create policy integration_sync_items_read on public.integration_sync_items
  for select to authenticated
  using (public.accounting_has_permission('accounting.dashboard.view'));

drop policy if exists integration_sync_items_service on public.integration_sync_items;
create policy integration_sync_items_service on public.integration_sync_items
  for all to service_role using (true) with check (true);

grant select on public.integration_sync_items to authenticated;
grant all on public.integration_sync_items to service_role;

create or replace function public.claim_facto_receivables_sync_task(
  p_worker_id text,
  p_lease_seconds integer default 300
) returns table(task jsonb, lease_token uuid, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.business_agent_tasks%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then
    raise exception 'facto_receivables_claim_service_only' using errcode = '42501';
  end if;
  if nullif(trim(p_worker_id), '') is null then raise exception 'worker_id_required'; end if;

  select bat.* into v_task
  from public.business_agent_tasks bat
  where bat.agent_type = 'collections'
    and bat.action = 'sync_facto_receivables'
    and (bat.status = 'pending' or (bat.status = 'in_progress' and bat.lease_expires_at < now()))
  order by bat.priority desc, bat.created_at
  for update skip locked
  limit 1;
  if not found then return; end if;

  update public.business_agent_tasks bat
  set status = 'in_progress',
      worker_id = p_worker_id,
      lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => greatest(30, least(600, p_lease_seconds))),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where bat.id = v_task.id
  returning to_jsonb(bat.*), bat.lease_token, bat.lease_expires_at
  into task, lease_token, lease_expires_at;
  return next;
end
$$;

create or replace function public.accounting_request_facto_receivables_preview(
  p_entity_id uuid,
  p_actor_id uuid,
  p_from_date date,
  p_to_date date,
  p_trigger_type text default 'manual',
  p_correlation_id uuid default gen_random_uuid()
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_task_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Solo el servicio financiero puede solicitar lecturas Facto.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.accounting_entities where id = p_entity_id and active) then
    raise exception 'Entidad contable inexistente o inactiva.';
  end if;
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date then
    raise exception 'El período Facto es inválido.';
  end if;
  if p_to_date > current_date then raise exception 'El período Facto no puede terminar en el futuro.'; end if;
  if p_trigger_type not in ('manual','copilot','development') then
    raise exception 'Origen de sincronización inválido.';
  end if;
  if exists (
    select 1 from public.integration_sync_runs
    where entity_id = p_entity_id and provider = 'facto' and resource = 'receivables'
      and status in ('pending','running','applying')
  ) then
    raise exception 'Ya existe una lectura Facto en curso.';
  end if;

  insert into public.integration_sync_runs(
    provider, resource, status, entity_id, requested_by, trigger_type,
    sync_method, run_mode, from_date, to_date, correlation_id, summary
  ) values (
    'facto', 'receivables', 'pending', p_entity_id, p_actor_id, p_trigger_type,
    'api_browser', 'dry_run', p_from_date, p_to_date, p_correlation_id,
    jsonb_build_object(
      'policy', 'API first; browser read-only; preview required before apply',
      'bank_movements_created', 0,
      'journal_entries_created', 0
    )
  ) returning id into v_run_id;

  insert into public.business_agent_tasks(
    agent_type, action, payload, status, priority, requested_by
  ) values (
    'collections', 'sync_facto_receivables',
    jsonb_build_object(
      'run_id', v_run_id,
      'entity_id', p_entity_id,
      'from_date', p_from_date,
      'to_date', p_to_date,
      'mode', 'dry_run',
      'read_only', true,
      'requested_from', p_trigger_type
    ),
    'pending', 75, p_actor_id
  ) returning id into v_task_id;

  update public.integration_sync_runs
  set task_id = v_task_id, updated_at = now()
  where id = v_run_id;

  insert into public.agent_task_events(task_id, level, stage, message, metrics)
  values (
    v_task_id, 'info', 'requested',
    'Previsualización de cobranza Facto solicitada desde Finanzas.',
    jsonb_build_object(
      'run_id', v_run_id,
      'from_date', p_from_date,
      'to_date', p_to_date,
      'read_only', true
    )
  );

  insert into public.accounting_audit_events(
    entity_id, actor_id, action, entity_type, entity_id_text,
    correlation_id, new_value
  ) values (
    p_entity_id, p_actor_id, 'facto.receivables_preview_requested',
    'integration_sync_run', v_run_id::text, p_correlation_id,
    jsonb_build_object(
      'task_id', v_task_id,
      'from_date', p_from_date,
      'to_date', p_to_date,
      'trigger_type', p_trigger_type,
      'run_mode', 'dry_run'
    )
  );

  return jsonb_build_object(
    'runId', v_run_id,
    'taskId', v_task_id,
    'status', 'pending',
    'mode', 'dry_run',
    'fromDate', p_from_date,
    'toDate', p_to_date
  );
end
$$;

create or replace function public.accounting_stage_facto_receivable_sync_items(
  p_run_id uuid,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.integration_sync_runs%rowtype;
  v_item jsonb;
  v_normalized jsonb;
  v_errors jsonb;
  v_evidence jsonb;
  v_external_id text;
  v_canonical_key text;
  v_document_type text;
  v_folio text;
  v_tax_id text;
  v_issued_on date;
  v_original numeric(20,4);
  v_outstanding numeric(20,4);
  v_source_ids uuid[];
  v_source public.accounting_source_documents%rowtype;
  v_receivable public.accounting_receivables%rowtype;
  v_action text;
  v_confidence text;
  v_previous jsonb;
  v_previous_balance numeric(20,4);
  v_total integer;
  v_summary jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Solo el servicio interno puede preparar lecturas Facto.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'Cada lote debe contener entre 0 y 100 registros.';
  end if;

  select * into v_run
  from public.integration_sync_runs
  where id = p_run_id and provider = 'facto' and resource = 'receivables'
  for update;
  if v_run.id is null then raise exception 'Ejecución Facto inexistente.'; end if;
  if v_run.status not in ('pending','running') then
    raise exception 'La ejecución Facto ya no acepta registros.';
  end if;

  update public.integration_sync_runs
  set status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
  where id = p_run_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_normalized := coalesce(v_item->'normalized', '{}'::jsonb);
    v_errors := case when jsonb_typeof(v_item->'validation_errors') = 'array'
      then v_item->'validation_errors' else '[]'::jsonb end;
    v_evidence := case when jsonb_typeof(v_item->'evidence') = 'object'
      then v_item->'evidence' else '{}'::jsonb end;
    v_external_id := nullif(trim(v_normalized->>'external_id'), '');
    v_canonical_key := nullif(trim(v_item->>'canonical_key'), '');
    v_document_type := nullif(trim(v_normalized->>'document_type'), '');
    v_folio := nullif(trim(v_normalized->>'folio'), '');
    v_tax_id := upper(regexp_replace(coalesce(v_normalized->>'customer_tax_id', ''), '[^0-9kK]', '', 'g'));
    v_issued_on := case when coalesce(v_normalized->>'issued_on', '') ~ '^\d{4}-\d{2}-\d{2}$'
      then (v_normalized->>'issued_on')::date else null end;
    v_original := case when coalesce(v_normalized->>'original_amount_clp', '') ~ '^-?[0-9]+([.][0-9]+)?$'
      then (v_normalized->>'original_amount_clp')::numeric else -1 end;
    v_outstanding := case when coalesce(v_normalized->>'outstanding_amount_clp', '') ~ '^-?[0-9]+([.][0-9]+)?$'
      then (v_normalized->>'outstanding_amount_clp')::numeric else -1 end;
    v_source_ids := null;
    v_source := null;
    v_receivable := null;
    v_action := 'invalid';
    v_confidence := 'none';
    v_previous := '{}'::jsonb;

    if v_canonical_key is null then v_errors := v_errors || '"canonical_key_missing"'::jsonb; end if;
    if coalesce((v_normalized->>'api_verified')::boolean, false) is not true then
      v_errors := v_errors || '"api_document_not_verified"'::jsonb;
    end if;
    if v_document_type not in ('sales_invoice','sales_exempt_invoice','sales_receipt','sales_exempt_receipt') then
      v_errors := v_errors || '"document_type_requires_review"'::jsonb;
    end if;
    if v_folio is null then v_errors := v_errors || '"folio_missing"'::jsonb; end if;
    if v_tax_id = '' then v_errors := v_errors || '"customer_tax_id_missing"'::jsonb; end if;
    if v_issued_on is null or v_issued_on < v_run.from_date or v_issued_on > v_run.to_date then
      v_errors := v_errors || '"issue_date_out_of_scope"'::jsonb;
    end if;
    if v_original <= 0 then v_errors := v_errors || '"original_amount_invalid"'::jsonb; end if;
    if v_outstanding < 0 or v_outstanding > v_original + 0.5 then
      v_errors := v_errors || '"outstanding_amount_invalid"'::jsonb;
    end if;
    if v_outstanding > 0 and coalesce((v_normalized->>'browser_verified')::boolean, false) is not true then
      v_errors := v_errors || '"browser_balance_not_verified"'::jsonb;
    end if;
    if v_outstanding = 0 and coalesce((v_normalized->>'closure_evidence')::boolean, false) is not true then
      v_errors := v_errors || '"closure_not_verified"'::jsonb;
    end if;

    if jsonb_array_length(v_errors) = 0 then
      if v_external_id is not null then
        select array_agg(id order by created_at) into v_source_ids
        from public.accounting_source_documents
        where entity_id = v_run.entity_id
          and source_type = 'FACTO'
          and external_id = v_external_id
          and document_type like 'sales_%';
      end if;
      if coalesce(cardinality(v_source_ids), 0) = 0 then
        select array_agg(id order by created_at) into v_source_ids
        from public.accounting_source_documents
        where entity_id = v_run.entity_id
          and source_type = 'FACTO'
          and document_type = v_document_type
          and folio = v_folio
          and upper(regexp_replace(coalesce(counterpart_tax_id, ''), '[^0-9kK]', '', 'g')) = v_tax_id;
      end if;

      if coalesce(cardinality(v_source_ids), 0) > 1 then
        v_action := 'ambiguous';
        v_confidence := 'possible';
        v_errors := v_errors || '"multiple_crm_documents_match"'::jsonb;
      elsif coalesce(cardinality(v_source_ids), 0) = 0 then
        -- A complete unpaid portfolio can prove that a known CRM receivable was
        -- closed. It cannot prove that an unknown historical API document should
        -- be created as a paid receivable.
        v_action := case
          when v_outstanding = 0 and coalesce((v_normalized->>'closure_evidence')::boolean, false)
            then 'unchanged'
          else 'create'
        end;
        v_confidence := 'exact';
      else
        select * into v_source from public.accounting_source_documents where id = v_source_ids[1];
        select * into v_receivable
        from public.accounting_receivables
        where entity_id = v_run.entity_id and source_document_id = v_source.id;
        v_previous := jsonb_build_object(
          'source_document_id', v_source.id,
          'receivable_id', v_receivable.id,
          'external_id', v_source.external_id,
          'document_type', v_source.document_type,
          'folio', v_source.folio,
          'customer_tax_id', v_source.counterpart_tax_id,
          'customer_name', v_source.counterpart_name,
          'issued_on', v_source.issued_on,
          'due_on', v_source.due_on,
          'original_amount_clp', v_receivable.original_amount_clp,
          'bank_confirmed_paid_amount_clp', v_receivable.paid_amount_clp,
          'facto_reported_balance_clp', v_receivable.reported_balance_clp,
          'crm_balance_clp', v_receivable.balance_clp
        );
        if v_source.document_type <> v_document_type then
          v_action := 'ambiguous';
          v_confidence := 'possible';
          v_errors := v_errors || '"document_type_conflict"'::jsonb;
        elsif v_source.issued_on is not null and v_source.issued_on <> v_issued_on then
          v_action := 'ambiguous';
          v_confidence := 'possible';
          v_errors := v_errors || '"issue_date_conflict"'::jsonb;
        elsif v_source.counterpart_tax_id is not null
           and upper(regexp_replace(v_source.counterpart_tax_id, '[^0-9kK]', '', 'g')) <> v_tax_id then
          v_action := 'ambiguous';
          v_confidence := 'possible';
          v_errors := v_errors || '"customer_tax_id_conflict"'::jsonb;
        elsif v_source.total_clp > 0 and abs(v_source.total_clp - v_original) > 0.5 then
          v_action := 'ambiguous';
          v_confidence := 'possible';
          v_errors := v_errors || '"source_original_amount_conflict"'::jsonb;
        elsif v_receivable.id is not null and abs(v_receivable.original_amount_clp - v_original) > 0.5 then
          v_action := 'ambiguous';
          v_confidence := 'possible';
          v_errors := v_errors || '"original_amount_conflict"'::jsonb;
        elsif v_receivable.id is null then
          v_action := 'create';
          v_confidence := 'exact';
        else
          v_previous_balance := coalesce(v_receivable.reported_balance_clp, v_receivable.balance_clp);
          v_confidence := 'exact';
          if abs(v_previous_balance - v_outstanding) <= 0.5 then
            v_action := 'unchanged';
          elsif v_outstanding = 0 then
            v_action := 'close';
          else
            v_action := 'update';
          end if;
        end if;
      end if;
    end if;

    insert into public.integration_sync_items(
      run_id, entity_id, provider, resource, external_id, canonical_key,
      action, match_confidence, matched_source_document_id, matched_receivable_id,
      previous_payload, normalized_payload, raw_payload_hash, normalized_hash,
      validation_errors, evidence, observed_at, updated_at
    ) values (
      p_run_id, v_run.entity_id, 'facto', 'receivables', v_external_id, v_canonical_key,
      v_action, v_confidence, v_source.id, v_receivable.id,
      v_previous, v_normalized, nullif(v_item->>'raw_payload_hash', ''), md5(v_normalized::text),
      v_errors, v_evidence,
      coalesce(nullif(v_normalized->>'observed_at', '')::timestamptz, now()), now()
    )
    on conflict (run_id, canonical_key) do update set
      external_id = excluded.external_id,
      action = excluded.action,
      match_confidence = excluded.match_confidence,
      matched_source_document_id = excluded.matched_source_document_id,
      matched_receivable_id = excluded.matched_receivable_id,
      previous_payload = excluded.previous_payload,
      normalized_payload = excluded.normalized_payload,
      raw_payload_hash = excluded.raw_payload_hash,
      normalized_hash = excluded.normalized_hash,
      validation_errors = excluded.validation_errors,
      evidence = excluded.evidence,
      observed_at = excluded.observed_at,
      applied_at = null,
      updated_at = now();
  end loop;

  select count(*)::integer into v_total
  from public.integration_sync_items where run_id = p_run_id;
  select jsonb_object_agg(action, amount) into v_summary
  from (
    select action, count(*)::integer amount
    from public.integration_sync_items where run_id = p_run_id group by action
  ) counts;

  update public.integration_sync_runs
  set read_count = v_total, summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object(
    'items', v_total, 'actions', coalesce(v_summary, '{}'::jsonb)
  ), updated_at = now()
  where id = p_run_id;

  return jsonb_build_object('items', v_total, 'actions', coalesce(v_summary, '{}'::jsonb));
end
$$;

create or replace function public.accounting_apply_facto_receivables_sync_run(
  p_run_id uuid,
  p_actor_id uuid,
  p_correlation_id uuid default gen_random_uuid()
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.integration_sync_runs%rowtype;
  v_item public.integration_sync_items%rowtype;
  v_source_id uuid;
  v_receivable_id uuid;
  v_original numeric(20,4);
  v_original_source numeric(20,4);
  v_outstanding numeric(20,4);
  v_currency text;
  v_exchange_rate numeric(20,8);
  v_due_on date;
  v_created integer := 0;
  v_updated integer := 0;
  v_closed integer := 0;
  v_unchanged integer := 0;
  v_blockers integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Solo el servicio financiero puede aplicar una previsualización Facto.';
  end if;

  select * into v_run
  from public.integration_sync_runs
  where id = p_run_id and provider = 'facto' and resource = 'receivables'
  for update;
  if v_run.id is null then raise exception 'Ejecución Facto inexistente.'; end if;
  if v_run.status <> 'preview_ready' then
    raise exception 'La ejecución Facto no está lista para aplicar.';
  end if;
  if coalesce((v_run.coverage->>'complete')::boolean, false) is not true then
    raise exception 'La lectura Facto no tiene cobertura completa.';
  end if;

  select count(*)::integer into v_blockers
  from public.integration_sync_items
  where run_id = p_run_id and action in ('ambiguous','invalid');
  if v_blockers > 0 then
    raise exception 'La previsualización contiene % coincidencia(s) que requieren revisión.', v_blockers;
  end if;

  update public.integration_sync_runs
  set status = 'applying', approved_by = p_actor_id, approved_at = now(), updated_at = now()
  where id = p_run_id;

  for v_item in
    select * from public.integration_sync_items where run_id = p_run_id order by created_at, id
  loop
    v_original := (v_item.normalized_payload->>'original_amount_clp')::numeric;
    v_original_source := coalesce(nullif(v_item.normalized_payload->>'original_amount', '')::numeric, v_original);
    v_outstanding := (v_item.normalized_payload->>'outstanding_amount_clp')::numeric;
    v_currency := upper(coalesce(nullif(v_item.normalized_payload->>'currency', ''), 'CLP'));
    v_exchange_rate := coalesce(nullif(v_item.normalized_payload->>'exchange_rate', '')::numeric, 1);
    v_due_on := nullif(v_item.normalized_payload->>'due_on', '')::date;
    v_source_id := v_item.matched_source_document_id;
    v_receivable_id := v_item.matched_receivable_id;

    if v_item.action = 'create' then
      if v_source_id is null then
        insert into public.accounting_source_documents(
          entity_id, source_type, source_id, source_key, document_type, external_id, folio,
          counterpart_tax_id, counterpart_name, issued_on, due_on, currency, exchange_rate,
          net_amount, tax_amount, exempt_amount, total_amount, total_clp,
          status, data_quality, raw_payload, source_created_at, source_updated_at, observed_at, updated_at
        ) values (
          v_run.entity_id, 'FACTO', p_run_id::text, v_item.canonical_key,
          v_item.normalized_payload->>'document_type', v_item.external_id,
          v_item.normalized_payload->>'folio', v_item.normalized_payload->>'customer_tax_id',
          v_item.normalized_payload->>'customer_name', (v_item.normalized_payload->>'issued_on')::date,
          v_due_on, v_currency, v_exchange_rate,
          coalesce(nullif(v_item.normalized_payload->>'net_amount', '')::numeric, 0),
          coalesce(nullif(v_item.normalized_payload->>'tax_amount', '')::numeric, 0),
          coalesce(nullif(v_item.normalized_payload->>'exempt_amount', '')::numeric, 0),
          v_original_source, v_original, 'validated', 'validated',
          jsonb_build_object('facto_receivables_sync', v_item.normalized_payload, 'evidence', v_item.evidence),
          nullif(v_item.normalized_payload->>'source_created_at', '')::timestamptz,
          v_item.observed_at, v_item.observed_at, now()
        )
        on conflict (entity_id, source_type, source_key) do update set
          external_id = coalesce(excluded.external_id, accounting_source_documents.external_id),
          due_on = excluded.due_on,
          counterpart_tax_id = excluded.counterpart_tax_id,
          counterpart_name = excluded.counterpart_name,
          raw_payload = excluded.raw_payload,
          source_updated_at = excluded.source_updated_at,
          observed_at = excluded.observed_at,
          updated_at = now()
        returning id into v_source_id;
      end if;

      insert into public.accounting_receivables(
        entity_id, source_document_id, customer_tax_id, customer_name, document_number,
        issued_on, due_on, currency, exchange_rate, original_amount, original_amount_clp,
        paid_amount_clp, reported_paid_amount_clp, reported_balance_clp, reported_at,
        status, notes, updated_at
      ) values (
        v_run.entity_id, v_source_id, v_item.normalized_payload->>'customer_tax_id',
        v_item.normalized_payload->>'customer_name', v_item.normalized_payload->>'folio',
        (v_item.normalized_payload->>'issued_on')::date, v_due_on, v_currency, v_exchange_rate,
        v_original_source, v_original, 0, greatest(v_original - v_outstanding, 0), v_outstanding,
        v_item.observed_at,
        case when v_outstanding <= 0.5 then 'paid'
             when v_due_on is not null and v_due_on < current_date then 'overdue'
             when v_outstanding < v_original then 'partial'
             else 'pending' end,
        'Saldo operativo informado por Facto; pendiente de conciliación bancaria.', now()
      )
      on conflict (entity_id, source_document_id) do update set
        customer_tax_id = excluded.customer_tax_id,
        customer_name = excluded.customer_name,
        document_number = excluded.document_number,
        due_on = excluded.due_on,
        reported_paid_amount_clp = excluded.reported_paid_amount_clp,
        reported_balance_clp = excluded.reported_balance_clp,
        reported_at = excluded.reported_at,
        updated_at = now()
      returning id into v_receivable_id;
      v_created := v_created + 1;
    elsif v_item.action in ('update','close') then
      update public.accounting_source_documents
      set external_id = coalesce(v_item.external_id, external_id),
          counterpart_tax_id = v_item.normalized_payload->>'customer_tax_id',
          counterpart_name = v_item.normalized_payload->>'customer_name',
          due_on = v_due_on,
          raw_payload = raw_payload || jsonb_build_object(
            'latest_facto_receivables_sync', v_item.normalized_payload,
            'latest_facto_receivables_evidence', v_item.evidence
          ),
          source_updated_at = v_item.observed_at,
          observed_at = v_item.observed_at,
          updated_at = now()
      where id = v_source_id and entity_id = v_run.entity_id;

      update public.accounting_receivables
      set customer_tax_id = v_item.normalized_payload->>'customer_tax_id',
          customer_name = v_item.normalized_payload->>'customer_name',
          due_on = v_due_on,
          reported_paid_amount_clp = greatest(original_amount_clp - v_outstanding, 0),
          reported_balance_clp = v_outstanding,
          reported_at = v_item.observed_at,
          status = case
            when status not in ('pending','partial','paid','overdue') then status
            when v_outstanding <= 0.5 then 'paid'
            when v_due_on is not null and v_due_on < current_date then 'overdue'
            when v_outstanding < original_amount_clp then 'partial'
            else 'pending'
          end,
          updated_at = now()
      where id = v_receivable_id and entity_id = v_run.entity_id;
      if not found then raise exception 'La cuenta por cobrar vinculada dejó de existir.'; end if;
      if v_item.action = 'close' then v_closed := v_closed + 1; else v_updated := v_updated + 1; end if;
    else
      v_unchanged := v_unchanged + 1;
    end if;

    insert into public.integration_records(provider, resource, external_id, payload, payload_hash, observed_at, updated_at)
    values ('facto', 'receivables', v_item.canonical_key, v_item.normalized_payload,
      v_item.normalized_hash, v_item.observed_at, now())
    on conflict (provider, resource, external_id) do update set
      payload = excluded.payload,
      payload_hash = excluded.payload_hash,
      observed_at = excluded.observed_at,
      updated_at = now();

    insert into public.accounting_audit_events(
      entity_id, actor_id, action, entity_type, entity_id_text, reason,
      previous_value, new_value, correlation_id
    ) values (
      v_run.entity_id, p_actor_id, 'facto.receivable.' || v_item.action,
      'integration_sync_item', v_item.id::text,
      'Previsualización Facto aprobada; no crea pagos, cartolas ni asientos.',
      v_item.previous_payload, v_item.normalized_payload, p_correlation_id
    );

    update public.integration_sync_items
    set matched_source_document_id = coalesce(v_source_id, matched_source_document_id),
        matched_receivable_id = coalesce(v_receivable_id, matched_receivable_id),
        applied_at = now(), updated_at = now()
    where id = v_item.id;
  end loop;

  update public.integration_sync_runs
  set status = 'completed', run_mode = 'apply',
      written_count = v_created + v_updated + v_closed,
      finished_at = now(), duration_ms = greatest(0, floor(extract(epoch from (now() - created_at)) * 1000)::integer),
      summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object(
        'applied', jsonb_build_object(
          'created', v_created, 'updated', v_updated, 'closed', v_closed, 'unchanged', v_unchanged
        ),
        'bank_movements_created', 0,
        'journal_entries_created', 0
      ),
      updated_at = now()
  where id = p_run_id;

  perform public.accounting_refresh_controls(v_run.entity_id);

  return jsonb_build_object(
    'runId', p_run_id,
    'created', v_created,
    'updated', v_updated,
    'closed', v_closed,
    'unchanged', v_unchanged,
    'bankMovementsCreated', 0,
    'journalEntriesCreated', 0
  );
end
$$;

revoke all on function public.accounting_stage_facto_receivable_sync_items(uuid,jsonb) from public;
revoke all on function public.accounting_apply_facto_receivables_sync_run(uuid,uuid,uuid) from public;
revoke all on function public.claim_facto_receivables_sync_task(text,integer) from public;
revoke all on function public.accounting_request_facto_receivables_preview(uuid,uuid,date,date,text,uuid) from public;
grant execute on function public.accounting_stage_facto_receivable_sync_items(uuid,jsonb) to service_role;
grant execute on function public.accounting_apply_facto_receivables_sync_run(uuid,uuid,uuid) to service_role;
grant execute on function public.claim_facto_receivables_sync_task(text,integer) to service_role;
grant execute on function public.accounting_request_facto_receivables_preview(uuid,uuid,date,date,text,uuid) to service_role;

comment on table public.integration_sync_items is
  'Previsualización auditable de lecturas Facto. No representa pagos bancarios ni asientos contables.';
comment on function public.accounting_apply_facto_receivables_sync_run(uuid,uuid,uuid) is
  'Aplica saldos operativos Facto aprobados sin alterar abonos bancarios, conciliaciones ni el libro contable.';
comment on function public.claim_facto_receivables_sync_task(text,integer) is
  'Arrienda exclusivamente tareas sync_facto_receivables para que este worker no intercepte otras tareas de cobranza.';
comment on function public.accounting_request_facto_receivables_preview(uuid,uuid,date,date,text,uuid) is
  'Crea atómicamente la ejecución dry-run, su tarea especializada y la trazabilidad inicial.';

commit;
