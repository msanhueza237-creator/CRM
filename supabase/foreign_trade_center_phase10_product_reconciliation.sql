-- Clima Activa CRM - Centro de Comercio Exterior
-- Fase 10: conciliacion segura de productos por proveedor.
-- Ejecutar despues de foreign_trade_center_phase3.sql.

begin;

create or replace function public.normalize_foreign_trade_product_text(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  with folded as (
    select translate(lower(coalesce(p_value, '')),
      'áéíóúüñÁÉÍÓÚÜÑ',
      'aeiouunAEIOUUN') value
  ), units_joined as (
    select regexp_replace(
      value,
      '([0-9]+([.,][0-9]+)?)\s*(cfm|vac|vdc|hz|kw|btu|psi|bar|hp|mm|cm|kg|ml|v|w|a|g|l)(\M|$)',
      '\1\3',
      'gi'
    ) value
    from folded
  )
  select nullif(trim(regexp_replace(value, '[^a-z0-9]+', ' ', 'g')), '')
  from units_joined
$$;

create or replace function public.normalize_foreign_trade_product_code(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select nullif(upper(regexp_replace(coalesce(p_value, ''), '[^a-zA-Z0-9]+', '', 'g')), '')
$$;

create or replace function public.foreign_trade_product_tokens(p_value text)
returns text[]
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct token order by token), '{}'::text[])
  from regexp_split_to_table(coalesce(public.normalize_foreign_trade_product_text(p_value), ''), '\s+') token
  where length(token) >= 3
    and token not in (
      'para','con','sin','del','las','los','una','uno','por','and','the','with','from',
      'product','producto','modelo','model','unidad','unidades','unit','units','pcs','piece'
    )
$$;

create or replace function public.foreign_trade_technical_tokens(p_value text)
returns text[]
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct token order by token), '{}'::text[])
  from unnest(public.foreign_trade_product_tokens(p_value)) token
  where token ~ '[0-9]'
$$;

create or replace function public.foreign_trade_token_similarity(p_left text, p_right text)
returns numeric
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  with left_tokens as (
    select unnest(public.foreign_trade_product_tokens(p_left)) token
  ), right_tokens as (
    select unnest(public.foreign_trade_product_tokens(p_right)) token
  ), shared as (
    select count(*)::numeric value from left_tokens join right_tokens using (token)
  ), total as (
    select count(*)::numeric value
    from (select token from left_tokens union select token from right_tokens) tokens
  )
  select case when total.value = 0 then 0 else round(shared.value / total.value, 6) end
  from shared cross join total
$$;

create or replace function public.foreign_trade_technical_similarity(p_left text, p_right text)
returns numeric
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  with left_tokens as (
    select unnest(public.foreign_trade_technical_tokens(p_left)) token
  ), right_tokens as (
    select unnest(public.foreign_trade_technical_tokens(p_right)) token
  ), shared as (
    select count(*)::numeric value from left_tokens join right_tokens using (token)
  ), expected as (
    select count(*)::numeric value from left_tokens
  )
  select case when expected.value = 0 then 0 else round(shared.value / expected.value, 6) end
  from shared cross join expected
$$;

create table if not exists public.product_supplier_mappings (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  internal_product_id uuid not null references public.content_products(id) on delete restrict,
  supplier_product_code text,
  supplier_sku text,
  supplier_model text,
  supplier_reference text,
  normalized_key text not null,
  original_description text,
  translated_description text,
  normalized_description text,
  supplier_brand text,
  confirmed boolean not null default true,
  confidence numeric(7,6) not null default 1 check (confidence between 0 and 1),
  matching_method text not null default 'manual' check (matching_method in (
    'manual','learned_mapping','exact_internal_sku','exact_model','technical_text','semantic_fallback'
  )),
  match_reasons jsonb not null default '[]'::jsonb,
  source_document_id uuid references public.foreign_trade_documents(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  observations_count integer not null default 1 check (observations_count > 0),
  created_by uuid references public.profiles(id) on delete set null,
  confirmed_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(match_reasons) = 'array')
);

create unique index if not exists product_supplier_mappings_identity_idx
  on public.product_supplier_mappings(supplier_id, normalized_key);
create index if not exists product_supplier_mappings_product_idx
  on public.product_supplier_mappings(internal_product_id, supplier_id);

create table if not exists public.foreign_trade_product_reconciliations (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.foreign_trade_documents(id) on delete cascade,
  operation_id uuid not null references public.import_shipments(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  source_index integer not null check (source_index > 0),
  source_page integer,
  source_row_label text,
  supplier_product_code text,
  supplier_sku text,
  supplier_model text,
  supplier_reference text,
  original_description text,
  translated_description text,
  normalized_description text,
  suggested_product_id uuid references public.content_products(id) on delete set null,
  selected_product_id uuid references public.content_products(id) on delete set null,
  status text not null default 'unmatched' check (status in (
    'auto_matched','suggested','review','unmatched','confirmed','rejected'
  )),
  confidence numeric(7,6) check (confidence between 0 and 1),
  matching_method text check (matching_method in (
    'manual','learned_mapping','exact_internal_sku','exact_model','technical_text','semantic_fallback'
  )),
  match_reasons jsonb not null default '[]'::jsonb,
  candidates jsonb not null default '[]'::jsonb,
  remember_mapping boolean not null default false,
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, source_index),
  check (jsonb_typeof(match_reasons) = 'array'),
  check (jsonb_typeof(candidates) = 'array')
);

create index if not exists foreign_trade_product_reconciliations_operation_idx
  on public.foreign_trade_product_reconciliations(operation_id, status, source_index);
create index if not exists foreign_trade_product_reconciliations_pending_idx
  on public.foreign_trade_product_reconciliations(document_id, status)
  where status in ('suggested','review','unmatched');

drop trigger if exists set_product_supplier_mappings_updated_at on public.product_supplier_mappings;
create trigger set_product_supplier_mappings_updated_at
before update on public.product_supplier_mappings
for each row execute function public.set_updated_at();

drop trigger if exists set_foreign_trade_product_reconciliations_updated_at on public.foreign_trade_product_reconciliations;
create trigger set_foreign_trade_product_reconciliations_updated_at
before update on public.foreign_trade_product_reconciliations
for each row execute function public.set_updated_at();

drop trigger if exists audit_product_supplier_mappings on public.product_supplier_mappings;
create trigger audit_product_supplier_mappings
after insert or update or delete on public.product_supplier_mappings
for each row execute function public.foreign_trade_write_audit();

drop trigger if exists audit_foreign_trade_product_reconciliations on public.foreign_trade_product_reconciliations;
create trigger audit_foreign_trade_product_reconciliations
after insert or update or delete on public.foreign_trade_product_reconciliations
for each row execute function public.foreign_trade_write_audit();

alter table public.product_supplier_mappings enable row level security;
alter table public.foreign_trade_product_reconciliations enable row level security;

drop policy if exists product_supplier_mappings_read on public.product_supplier_mappings;
create policy product_supplier_mappings_read on public.product_supplier_mappings
for select to authenticated using (public.foreign_trade_has_permission('foreign_trade.view'));
drop policy if exists product_supplier_mappings_manage on public.product_supplier_mappings;
create policy product_supplier_mappings_manage on public.product_supplier_mappings
for all to authenticated
using (public.foreign_trade_has_permission('foreign_trade.suppliers.manage'))
with check (public.foreign_trade_has_permission('foreign_trade.suppliers.manage'));

drop policy if exists foreign_trade_product_reconciliations_read on public.foreign_trade_product_reconciliations;
create policy foreign_trade_product_reconciliations_read on public.foreign_trade_product_reconciliations
for select to authenticated using (public.foreign_trade_has_permission('foreign_trade.view'));
drop policy if exists foreign_trade_product_reconciliations_manage on public.foreign_trade_product_reconciliations;
create policy foreign_trade_product_reconciliations_manage on public.foreign_trade_product_reconciliations
for all to authenticated
using (public.foreign_trade_has_permission('foreign_trade.documents.manage'))
with check (public.foreign_trade_has_permission('foreign_trade.documents.manage'));

create or replace function public.foreign_trade_product_match_candidates(
  p_line jsonb,
  p_supplier_id uuid default null,
  p_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_code text := public.normalize_foreign_trade_product_code(coalesce(
    nullif(trim(p_line->>'supplier_product_code'), ''),
    nullif(trim(p_line->>'supplier_sku'), ''),
    nullif(trim(p_line->>'supplier_reference'), ''),
    nullif(trim(p_line->>'model'), '')
  ));
  v_internal_sku text := public.normalize_foreign_trade_product_code(nullif(trim(p_line->>'sku'), ''));
  v_description text := coalesce(
    nullif(trim(p_line->>'description_translated'), ''),
    nullif(trim(p_line->>'description'), ''),
    nullif(trim(p_line->>'product_name'), ''),
    ''
  );
  v_brand text := public.normalize_foreign_trade_product_text(p_line->>'brand');
  v_lookup_key text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 5), 10));
  v_mapping public.product_supplier_mappings%rowtype;
  v_result jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.view') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;

  v_lookup_key := coalesce(v_code, case
    when public.normalize_foreign_trade_product_text(v_description) is not null
      then 'DESCRIPTION:' || md5(public.normalize_foreign_trade_product_text(v_description))
    else null
  end);

  if p_supplier_id is not null and v_lookup_key is not null then
    select * into v_mapping
    from public.product_supplier_mappings
    where supplier_id = p_supplier_id
      and normalized_key = v_lookup_key
      and confirmed
    order by updated_at desc
    limit 1;
    if found then
      select jsonb_build_array(jsonb_build_object(
        'mapping_id', v_mapping.id,
        'product_id', cp.id,
        'sku', cp.sku,
        'name', cp.name,
        'category', cp.category,
        'brand', cp.brand,
        'score', 1,
        'method', 'learned_mapping',
        'reasons', jsonb_build_array('Equivalencia confirmada previamente para este proveedor.')
      )) into v_result
      from public.content_products cp
      where cp.id = v_mapping.internal_product_id;
      return coalesce(v_result, '[]'::jsonb);
    end if;
  end if;

  if p_supplier_id is not null and v_code is not null then
    select jsonb_build_array(jsonb_build_object(
      'mapping_id', null,
      'product_id', cp.id,
      'sku', cp.sku,
      'name', cp.name,
      'category', cp.category,
      'brand', cp.brand,
      'score', 0.98,
      'method', 'exact_model',
      'reasons', jsonb_build_array('Relación histórica exacta encontrada para el proveedor.')
    )) into v_result
    from public.supplier_products sp
    join public.content_products cp on cp.id = sp.content_product_id
    where sp.supplier_id = p_supplier_id
      and sp.content_product_id is not null
      and v_code in (
        public.normalize_foreign_trade_product_code(sp.supplier_sku),
        public.normalize_foreign_trade_product_code(sp.supplier_model),
        public.normalize_foreign_trade_product_code(sp.sku)
      )
    order by sp.updated_at desc
    limit 1;
    if v_result is not null then return v_result; end if;
  end if;

  with scored as (
    select cp.id, cp.sku, cp.name, cp.category, cp.brand,
      public.normalize_foreign_trade_product_code(cp.sku) = v_internal_sku and v_internal_sku is not null as exact_sku,
      public.foreign_trade_token_similarity(v_description, concat_ws(' ', cp.name, cp.sku, cp.description_text,
        cp.category, cp.brand, supplier_aliases.alias_text, learned_aliases.alias_text)) as text_score,
      public.foreign_trade_technical_similarity(v_description, concat_ws(' ', cp.name, cp.sku, cp.description_text,
        cp.category, cp.brand, supplier_aliases.alias_text, learned_aliases.alias_text)) as technical_score,
      case when v_brand is not null and public.normalize_foreign_trade_product_text(cp.brand) = v_brand then 1 else 0 end as brand_score
    from public.content_products cp
    left join lateral (
      select string_agg(concat_ws(' ', sp.supplier_sku, sp.supplier_model, sp.supplier_description), ' ') alias_text
      from public.supplier_products sp
      where sp.content_product_id = cp.id
        and (p_supplier_id is null or sp.supplier_id = p_supplier_id)
    ) supplier_aliases on true
    left join lateral (
      select string_agg(concat_ws(' ', mapping.supplier_product_code, mapping.supplier_sku,
        mapping.supplier_model, mapping.supplier_reference, mapping.original_description,
        mapping.translated_description), ' ') alias_text
      from public.product_supplier_mappings mapping
      where mapping.internal_product_id = cp.id
        and mapping.confirmed
        and (p_supplier_id is null or mapping.supplier_id = p_supplier_id)
    ) learned_aliases on true
    where cp.source_status <> 'deleted'
  ), ranked as (
    select *, case
      -- Un codigo de proveedor nunca se considera identidad interna suficiente.
      -- Incluso una coincidencia textual con el SKU maestro requiere revision
      -- hasta que exista una equivalencia confirmada para ese proveedor.
      when exact_sku then 0.95::numeric
      when public.normalize_foreign_trade_product_text(name) = public.normalize_foreign_trade_product_text(v_description)
        then 0.93::numeric
      when cardinality(public.foreign_trade_technical_tokens(v_description)) > 0
        then least(0.94::numeric, round(text_score * 0.70 + technical_score * 0.25 + brand_score * 0.05, 6))
      else least(0.89::numeric, round(text_score * 0.90 + brand_score * 0.10, 6))
    end score
    from scored
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'mapping_id', null,
    'product_id', id,
    'sku', sku,
    'name', name,
    'category', category,
    'brand', brand,
    'score', score,
    'method', case
      when exact_sku then 'exact_internal_sku'
      when technical_score > 0 then 'technical_text'
      else 'semantic_fallback'
    end,
    'reasons', jsonb_strip_nulls(jsonb_build_array(
      case when exact_sku then 'Código exacto con SKU interno.' end,
      case when text_score >= 0.5 then 'Coincidencia relevante de descripción.' end,
      case when technical_score >= 0.8 then 'Atributos técnicos compatibles.' end,
      case when brand_score = 1 then 'Marca coincidente.' end
    ))
  ) order by score desc, name), '[]'::jsonb)
  into v_result
  from (
    select * from ranked
    where score >= 0.15
    order by score desc, name
    limit v_limit
  ) candidates;

  return v_result;
end
$$;

create or replace function public.reconcile_foreign_trade_document(
  p_document_id uuid,
  p_supplier_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_document public.foreign_trade_documents%rowtype;
  v_effective_supplier_id uuid;
  v_line jsonb;
  v_source_index integer;
  v_candidates jsonb;
  v_best jsonb;
  v_score numeric;
  v_method text;
  v_status text;
  v_selected uuid;
  v_lines jsonb := '[]'::jsonb;
  v_summary jsonb;
  v_position integer := 0;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  select * into v_document from public.foreign_trade_documents where id = p_document_id;
  if not found then raise exception 'foreign_trade_document_not_found'; end if;
  if v_document.operation_id is null then raise exception 'foreign_trade_document_without_operation'; end if;
  if jsonb_typeof(v_document.extraction_result->'lines') <> 'array' then
    raise exception 'foreign_trade_document_without_product_lines';
  end if;
  select coalesce(
    p_supplier_id,
    nullif(trim(v_document.extraction_result->'general'->>'supplier_id'), '')::uuid,
    v_document.supplier_id,
    o.supplier_id
  ) into v_effective_supplier_id
  from public.import_shipments o where o.id = v_document.operation_id;

  for v_line in select value from jsonb_array_elements(v_document.extraction_result->'lines') loop
    v_position := v_position + 1;
    v_source_index := coalesce(nullif(trim(v_line->>'source_index'), '')::integer, v_position);
    v_candidates := public.foreign_trade_product_match_candidates(v_line, v_effective_supplier_id, 5);
    v_best := case when jsonb_array_length(v_candidates) > 0 then v_candidates->0 else '{}'::jsonb end;
    v_score := nullif(v_best->>'score', '')::numeric;
    v_method := nullif(v_best->>'method', '');
    v_selected := null;
    v_status := case
      when v_score is null then 'unmatched'
      when v_method in ('learned_mapping','exact_model') and v_score >= 0.98 then 'auto_matched'
      when v_score >= 0.80 then 'suggested'
      when v_score >= 0.55 then 'review'
      else 'unmatched'
    end;
    if v_status = 'auto_matched' then v_selected := nullif(v_best->>'product_id', '')::uuid; end if;

    insert into public.foreign_trade_product_reconciliations(
      document_id, operation_id, supplier_id, source_index, source_page, source_row_label,
      supplier_product_code, supplier_sku, supplier_model, supplier_reference,
      original_description, translated_description, normalized_description,
      suggested_product_id, selected_product_id, status, confidence, matching_method,
      match_reasons, candidates
    ) values (
      p_document_id, v_document.operation_id, v_effective_supplier_id, v_source_index,
      nullif(trim(v_line->>'source_page'), '')::integer, nullif(trim(v_line->>'source_row_label'), ''),
      nullif(trim(v_line->>'supplier_product_code'), ''), nullif(trim(v_line->>'supplier_sku'), ''),
      nullif(trim(v_line->>'model'), ''), nullif(trim(v_line->>'supplier_reference'), ''),
      coalesce(nullif(trim(v_line->>'description_original'), ''), nullif(trim(v_line->>'description'), ''), nullif(trim(v_line->>'product_name'), '')),
      nullif(trim(v_line->>'description_translated'), ''),
      public.normalize_foreign_trade_product_text(coalesce(v_line->>'description_translated', v_line->>'description', v_line->>'product_name')),
      nullif(v_best->>'product_id', '')::uuid, v_selected, v_status, v_score, v_method,
      coalesce(v_best->'reasons', '[]'::jsonb), v_candidates
    )
    on conflict (document_id, source_index) do update set
      supplier_id = excluded.supplier_id,
      source_page = excluded.source_page,
      source_row_label = excluded.source_row_label,
      supplier_product_code = excluded.supplier_product_code,
      supplier_sku = excluded.supplier_sku,
      supplier_model = excluded.supplier_model,
      supplier_reference = excluded.supplier_reference,
      original_description = excluded.original_description,
      translated_description = excluded.translated_description,
      normalized_description = excluded.normalized_description,
      suggested_product_id = excluded.suggested_product_id,
      selected_product_id = case
        when public.foreign_trade_product_reconciliations.status in ('confirmed','rejected')
          then public.foreign_trade_product_reconciliations.selected_product_id
        else excluded.selected_product_id
      end,
      status = case
        when public.foreign_trade_product_reconciliations.status in ('confirmed','rejected')
          then public.foreign_trade_product_reconciliations.status
        else excluded.status
      end,
      confidence = excluded.confidence,
      matching_method = excluded.matching_method,
      match_reasons = excluded.match_reasons,
      candidates = excluded.candidates,
      updated_at = now();
  end loop;

  delete from public.foreign_trade_product_reconciliations reconciliation
  where reconciliation.document_id = p_document_id
    and not exists (
      select 1
      from jsonb_array_elements(v_document.extraction_result->'lines') line
      where coalesce(nullif(trim(line->>'source_index'), '')::integer, -1) = reconciliation.source_index
    );

  select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.source_index), '[]'::jsonb)
  into v_lines
  from (
    select r.*
    from public.foreign_trade_product_reconciliations r
    where r.document_id = p_document_id
  ) row_data;

  select jsonb_build_object(
    'total', count(*),
    'auto_matched', count(*) filter (where status = 'auto_matched'),
    'suggested', count(*) filter (where status = 'suggested'),
    'review', count(*) filter (where status = 'review'),
    'unmatched', count(*) filter (where status = 'unmatched'),
    'confirmed', count(*) filter (where status = 'confirmed'),
    'rejected', count(*) filter (where status = 'rejected')
  ) into v_summary
  from public.foreign_trade_product_reconciliations
  where document_id = p_document_id;

  return jsonb_build_object('document_id', p_document_id, 'supplier_id', v_effective_supplier_id, 'summary', v_summary, 'lines', v_lines);
end
$$;

create or replace function public.confirm_foreign_trade_document_with_reconciliation(
  p_document_id uuid,
  p_review jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_document public.foreign_trade_documents%rowtype;
  v_supplier_id uuid;
  v_line jsonb;
  v_source_index integer;
  v_product_id uuid;
  v_code text;
  v_normalized_review jsonb;
  v_result jsonb;
  v_include boolean;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage')
     or not public.foreign_trade_has_permission('foreign_trade.operations.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_review, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(p_review->'lines') <> 'array' then
    raise exception 'foreign_trade_invalid_review';
  end if;

  select * into v_document from public.foreign_trade_documents where id = p_document_id for update;
  if not found then raise exception 'foreign_trade_document_not_found'; end if;
  if v_document.parse_status not in ('review_required','confirmed') then
    raise exception 'foreign_trade_document_not_ready';
  end if;
  select coalesce(
    nullif(trim(p_review->'general'->>'supplier_id'), '')::uuid,
    v_document.supplier_id,
    o.supplier_id
  ) into v_supplier_id
  from public.import_shipments o where o.id = v_document.operation_id;

  for v_line in select value from jsonb_array_elements(p_review->'lines') loop
    v_source_index := coalesce(nullif(trim(v_line->>'source_index'), '')::integer, 1);
    v_include := coalesce((v_line->>'include')::boolean, true);
    v_product_id := case when v_include then nullif(trim(v_line->>'content_product_id'), '')::uuid else null end;
    if v_product_id is not null and not exists (select 1 from public.content_products where id = v_product_id) then
      raise exception 'foreign_trade_product_not_found';
    end if;
    v_code := public.normalize_foreign_trade_product_code(coalesce(
      nullif(trim(v_line->>'supplier_product_code'), ''),
      nullif(trim(v_line->>'supplier_sku'), ''),
      nullif(trim(v_line->>'supplier_reference'), ''),
      nullif(trim(v_line->>'model'), '')
    ));

    insert into public.foreign_trade_product_reconciliations(
      document_id, operation_id, supplier_id, source_index, source_page, source_row_label,
      supplier_product_code, supplier_sku, supplier_model, supplier_reference,
      original_description, translated_description, normalized_description,
      suggested_product_id, selected_product_id, status, confidence, matching_method,
      match_reasons, candidates, remember_mapping, confirmed_at, confirmed_by
    ) values (
      p_document_id, v_document.operation_id, v_supplier_id, v_source_index,
      nullif(trim(v_line->>'source_page'), '')::integer, nullif(trim(v_line->>'source_row_label'), ''),
      nullif(trim(v_line->>'supplier_product_code'), ''), nullif(trim(v_line->>'supplier_sku'), ''),
      nullif(trim(v_line->>'model'), ''), nullif(trim(v_line->>'supplier_reference'), ''),
      coalesce(nullif(trim(v_line->>'description_original'), ''), nullif(trim(v_line->>'description'), ''), nullif(trim(v_line->>'product_name'), '')),
      nullif(trim(v_line->>'description_translated'), ''),
      public.normalize_foreign_trade_product_text(coalesce(v_line->>'description_translated', v_line->>'description', v_line->>'product_name')),
      v_product_id, v_product_id,
      case when not v_include then 'rejected' when v_product_id is null then 'unmatched' else 'confirmed' end,
      case when v_product_id is null then null else 1 end,
      case when v_product_id is null then null else 'manual' end,
      case when v_product_id is null then '[]'::jsonb else jsonb_build_array('Producto confirmado por una persona.') end,
      '[]'::jsonb, coalesce((v_line->>'remember_link')::boolean, false),
      case when v_product_id is null then null else now() end,
      case when v_product_id is null then null else auth.uid() end
    )
    on conflict (document_id, source_index) do update set
      supplier_id = excluded.supplier_id,
      selected_product_id = excluded.selected_product_id,
      status = excluded.status,
      confidence = excluded.confidence,
      matching_method = excluded.matching_method,
      match_reasons = excluded.match_reasons,
      remember_mapping = excluded.remember_mapping,
      confirmed_at = excluded.confirmed_at,
      confirmed_by = excluded.confirmed_by,
      updated_at = now();

    if v_include and v_product_id is not null and v_supplier_id is not null
       and coalesce((v_line->>'remember_link')::boolean, false) then
      if v_code is null then
        v_code := 'DESCRIPTION:' || md5(coalesce(
          public.normalize_foreign_trade_product_text(coalesce(v_line->>'description_translated', v_line->>'description', v_line->>'product_name')),
          v_source_index::text
        ));
      end if;
      insert into public.product_supplier_mappings(
        supplier_id, internal_product_id, supplier_product_code, supplier_sku,
        supplier_model, supplier_reference, normalized_key, original_description,
        translated_description, normalized_description, supplier_brand, confirmed,
        confidence, matching_method, match_reasons, source_document_id,
        created_by, confirmed_by, updated_by
      ) values (
        v_supplier_id, v_product_id, nullif(trim(v_line->>'supplier_product_code'), ''),
        nullif(trim(v_line->>'supplier_sku'), ''), nullif(trim(v_line->>'model'), ''),
        nullif(trim(v_line->>'supplier_reference'), ''), v_code,
        coalesce(nullif(trim(v_line->>'description_original'), ''), nullif(trim(v_line->>'description'), ''), nullif(trim(v_line->>'product_name'), '')),
        nullif(trim(v_line->>'description_translated'), ''),
        public.normalize_foreign_trade_product_text(coalesce(v_line->>'description_translated', v_line->>'description', v_line->>'product_name')),
        nullif(trim(v_line->>'brand'), ''), true, 1, 'manual',
        jsonb_build_array('Equivalencia confirmada durante la revisión documental.'),
        p_document_id, auth.uid(), auth.uid(), auth.uid()
      )
      on conflict (supplier_id, normalized_key) do update set
        internal_product_id = excluded.internal_product_id,
        supplier_product_code = coalesce(excluded.supplier_product_code, public.product_supplier_mappings.supplier_product_code),
        supplier_sku = coalesce(excluded.supplier_sku, public.product_supplier_mappings.supplier_sku),
        supplier_model = coalesce(excluded.supplier_model, public.product_supplier_mappings.supplier_model),
        supplier_reference = coalesce(excluded.supplier_reference, public.product_supplier_mappings.supplier_reference),
        original_description = coalesce(excluded.original_description, public.product_supplier_mappings.original_description),
        translated_description = coalesce(excluded.translated_description, public.product_supplier_mappings.translated_description),
        normalized_description = coalesce(excluded.normalized_description, public.product_supplier_mappings.normalized_description),
        confirmed = true,
        confidence = 1,
        matching_method = 'manual',
        source_document_id = excluded.source_document_id,
        last_seen_at = now(),
        observations_count = public.product_supplier_mappings.observations_count + 1,
        confirmed_by = auth.uid(),
        updated_by = auth.uid(),
        updated_at = now();
    end if;
  end loop;

  select jsonb_set(
    p_review,
    '{lines}',
    coalesce(jsonb_agg(jsonb_set(line.value, '{remember_link}', 'false'::jsonb, true) order by line.ordinality), '[]'::jsonb),
    true
  ) into v_normalized_review
  from jsonb_array_elements(p_review->'lines') with ordinality line(value, ordinality);

  if v_document.parse_status = 'review_required' then
    v_result := public.confirm_foreign_trade_document(p_document_id, v_normalized_review);
  else
    v_result := jsonb_build_object(
      'document_id', p_document_id,
      'operation_id', v_document.operation_id,
      'inserted_lines', 0,
      'skipped_lines', 0,
      'status', 'confirmed'
    );
  end if;

  update public.foreign_trade_operation_lines operation_line
  set content_product_id = reconciliation.selected_product_id,
      temporary_product = reconciliation.selected_product_id is null,
      linked_manually = reconciliation.matching_method = 'manual',
      source_snapshot = operation_line.source_snapshot || jsonb_build_object(
        'product_reconciliation_status', reconciliation.status,
        'product_reconciliation_method', reconciliation.matching_method,
        'product_reconciliation_confidence', reconciliation.confidence
      )
  from public.foreign_trade_product_reconciliations reconciliation
  where reconciliation.document_id = p_document_id
    and operation_line.source_document_id = p_document_id
    and operation_line.source_line_index = reconciliation.source_index;

  return v_result || jsonb_build_object(
    'reconciliation_confirmed', (
      select count(*) from public.foreign_trade_product_reconciliations
      where document_id = p_document_id and status = 'confirmed'
    ),
    'reconciliation_unmatched', (
      select count(*) from public.foreign_trade_product_reconciliations
      where document_id = p_document_id and status = 'unmatched'
    )
  );
end
$$;

create or replace function public.delete_product_supplier_mapping(p_mapping_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.foreign_trade_has_permission('foreign_trade.suppliers.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  delete from public.product_supplier_mappings where id = p_mapping_id;
  if not found then raise exception 'foreign_trade_supplier_mapping_not_found'; end if;
end
$$;

-- Amplia el contrato documental existente para planillas CSV sin crear un
-- segundo flujo de archivos ni relajar la validacion del Storage privado.
update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/csv'
]
where id = 'foreign-trade-orders';

create or replace function public.register_foreign_trade_document(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
  v_operation_id uuid := nullif(trim(p_payload->>'operation_id'), '')::uuid;
  v_supplier_id uuid := nullif(trim(p_payload->>'supplier_id'), '')::uuid;
  v_operation_supplier_id uuid;
  v_document_type text := coalesce(nullif(trim(p_payload->>'document_type'), ''), 'proforma');
  v_file_name text := trim(coalesce(p_payload->>'original_file_name', ''));
  v_storage_path text := trim(coalesce(p_payload->>'storage_path', ''));
  v_mime_type text := lower(trim(coalesce(p_payload->>'mime_type', '')));
  v_file_size bigint := nullif(trim(p_payload->>'file_size'), '')::bigint;
  v_file_hash text := lower(nullif(trim(p_payload->>'file_hash'), ''));
  v_extension text;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  select supplier_id into v_operation_supplier_id from public.import_shipments where id = v_operation_id;
  if not found then raise exception 'foreign_trade_operation_not_found'; end if;
  v_supplier_id := coalesce(v_supplier_id, v_operation_supplier_id);
  if v_supplier_id is not null and not exists (select 1 from public.suppliers where id = v_supplier_id) then
    raise exception 'foreign_trade_supplier_not_found';
  end if;
  if v_operation_supplier_id is not null and v_supplier_id is distinct from v_operation_supplier_id then
    raise exception 'foreign_trade_document_supplier_mismatch';
  end if;
  if length(v_file_name) < 3 or length(v_file_name) > 240 then raise exception 'foreign_trade_invalid_document_name'; end if;
  v_extension := lower(regexp_replace(v_file_name, '^.*\.', ''));
  if v_extension not in ('pdf','xls','xlsx','csv') then raise exception 'foreign_trade_invalid_document_type'; end if;
  if v_mime_type not in (
    'application/pdf','application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv','application/csv'
  ) then raise exception 'foreign_trade_invalid_document_mime'; end if;
  if v_file_size is null or v_file_size <= 0 or v_file_size > 52428800 then raise exception 'foreign_trade_invalid_document_size'; end if;
  if v_storage_path = '' or position(v_operation_id::text || '/' in v_storage_path) <> 1 then raise exception 'foreign_trade_invalid_storage_path'; end if;
  if v_file_hash is not null and v_file_hash !~ '^[0-9a-f]{64}$' then raise exception 'foreign_trade_invalid_file_hash'; end if;
  if v_document_type not in (
    'proforma','purchase_order','commercial_invoice','packing_list','bill_of_lading',
    'certificate_of_origin','customs_document','payment_receipt','freight_quote',
    'fund_request','agency_settlement','other'
  ) then raise exception 'foreign_trade_invalid_document_type'; end if;

  insert into public.foreign_trade_documents(
    id, operation_id, supplier_id, document_type, original_file_name,
    storage_bucket, storage_path, mime_type, file_size, file_hash,
    parse_status, uploaded_by
  ) values (
    v_id, v_operation_id, v_supplier_id, v_document_type, v_file_name,
    'foreign-trade-orders', v_storage_path, v_mime_type, v_file_size, v_file_hash,
    case when v_document_type in ('proforma','purchase_order','commercial_invoice','packing_list') then 'queued' else 'uploaded' end,
    auth.uid()
  );
  return v_id;
end
$$;

create or replace function public.foreign_trade_product_catalog(
  p_search text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_term text := '%' || lower(trim(coalesce(p_search, ''))) || '%';
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_result jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.view') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(product_row)), '[]'::jsonb) into v_result
  from (
    select cp.id, cp.external_id, cp.sku, cp.name, cp.category, cp.brand, cp.price, cp.stock,
           cp.source_status, cp.sync_status, cp.primary_image_url, cp.last_synced_at
    from public.content_products cp
    where cp.source_status <> 'deleted'
      and (
        trim(coalesce(p_search, '')) = ''
        or lower(coalesce(cp.sku, '')) like v_term
        or lower(cp.name) like v_term
        or lower(coalesce(cp.description_text, '')) like v_term
        or lower(coalesce(cp.category, '')) like v_term
        or lower(coalesce(cp.brand, '')) like v_term
        or exists (
          select 1 from public.supplier_products sp
          where sp.content_product_id = cp.id
            and lower(concat_ws(' ', sp.supplier_sku, sp.supplier_model, sp.supplier_description)) like v_term
        )
        or exists (
          select 1 from public.product_supplier_mappings mapping
          where mapping.internal_product_id = cp.id
            and lower(concat_ws(' ', mapping.supplier_product_code, mapping.supplier_sku,
              mapping.supplier_model, mapping.supplier_reference, mapping.original_description,
              mapping.translated_description)) like v_term
        )
      )
    order by cp.name
    limit v_limit
  ) product_row;
  return v_result;
end
$$;

revoke all on function public.foreign_trade_product_match_candidates(jsonb, uuid, integer) from public;
revoke all on function public.reconcile_foreign_trade_document(uuid, uuid) from public;
revoke all on function public.confirm_foreign_trade_document_with_reconciliation(uuid, jsonb) from public;
revoke all on function public.delete_product_supplier_mapping(uuid) from public;
revoke all on function public.register_foreign_trade_document(jsonb) from public;
revoke all on function public.foreign_trade_product_catalog(text, integer) from public;
grant execute on function public.foreign_trade_product_match_candidates(jsonb, uuid, integer) to authenticated, service_role;
grant execute on function public.reconcile_foreign_trade_document(uuid, uuid) to authenticated, service_role;
grant execute on function public.confirm_foreign_trade_document_with_reconciliation(uuid, jsonb) to authenticated, service_role;
grant execute on function public.delete_product_supplier_mapping(uuid) to authenticated, service_role;
grant execute on function public.register_foreign_trade_document(jsonb) to authenticated, service_role;
grant execute on function public.foreign_trade_product_catalog(text, integer) to authenticated, service_role;

commit;
