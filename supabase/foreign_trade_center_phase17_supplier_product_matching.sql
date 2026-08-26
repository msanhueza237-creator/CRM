-- Clima Activa CRM - Comercio Exterior fase 17
-- Motor de conciliacion de productos por proveedor.
-- Ejecutar despues de foreign_trade_center_phase16_cif_allocation.sql.

begin;

create or replace function public.foreign_trade_extract_product_code(p_line jsonb)
returns text
language plpgsql
immutable
parallel safe
set search_path = public, pg_temp
as $$
declare
  v_explicit text;
  v_text text;
  v_match text[];
begin
  v_explicit := coalesce(
    nullif(trim(p_line->>'supplier_product_code'), ''),
    nullif(trim(p_line->>'supplier_sku'), ''),
    nullif(trim(p_line->>'supplier_reference'), ''),
    nullif(trim(p_line->>'model'), ''),
    nullif(trim(p_line->>'sku'), '')
  );
  if v_explicit is not null then return upper(v_explicit); end if;

  v_text := upper(concat_ws(' ',
    p_line->>'item', p_line->>'description_original', p_line->>'description',
    p_line->>'product_name', p_line->>'specification', p_line->>'part_number',
    p_line->>'reference'
  ));
  v_match := regexp_match(
    v_text,
    '\m([A-Z][A-Z0-9]{0,7}[- ][A-Z0-9-]*[0-9][A-Z0-9-]*|[A-Z]{1,8}[0-9][A-Z0-9-]{1,})\M'
  );
  return case when v_match is null then null else trim(v_match[1]) end;
end
$$;

create or replace function public.foreign_trade_technical_conflict_count(p_left text, p_right text)
returns integer
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  with left_tokens as (
    select token, regexp_replace(token, '[0-9.,-]+', '', 'g') unit
    from unnest(public.foreign_trade_technical_tokens(p_left)) token
  ), right_tokens as (
    select token, regexp_replace(token, '[0-9.,-]+', '', 'g') unit
    from unnest(public.foreign_trade_technical_tokens(p_right)) token
  )
  select count(*)::integer
  from left_tokens expected
  where expected.unit ~ '^(cfm|vac|vdc|hz|kw|btu|psi|bar|hp|mm|cm|kg|ml|v|w|a|g|l)$'
    and exists (
      select 1 from right_tokens candidate
      where candidate.unit = expected.unit
        and candidate.token <> expected.token
    )
    and not exists (
      select 1 from right_tokens candidate
      where candidate.token = expected.token
    )
$$;

create or replace function public.foreign_trade_facto_product_alias(p_sku text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_alias text;
begin
  if p_sku is null or to_regclass('public.integration_records') is null then return null; end if;
  execute $query$
    select string_agg(concat_ws(' ', ir.external_id, ir.payload->>'sku', ir.payload->>'name',
      ir.payload->>'product_name', ir.payload->>'description', ir.payload->>'model',
      ir.payload->>'brand', ir.payload->>'category'), ' ')
    from public.integration_records ir
    where ir.provider = 'facto'
      and public.normalize_foreign_trade_product_code(ir.payload->>'sku') =
          public.normalize_foreign_trade_product_code($1)
  $query$ into v_alias using p_sku;
  return v_alias;
end
$$;

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
  v_code text := public.normalize_foreign_trade_product_code(public.foreign_trade_extract_product_code(p_line));
  v_internal_sku text := public.normalize_foreign_trade_product_code(nullif(trim(p_line->>'sku'), ''));
  v_description text := concat_ws(' ',
    nullif(trim(p_line->>'description_translated'), ''),
    nullif(trim(p_line->>'description_original'), ''),
    nullif(trim(p_line->>'description'), ''),
    nullif(trim(p_line->>'product_name'), '')
  );
  v_description_basis text := coalesce(
    nullif(trim(p_line->>'description_translated'), ''),
    nullif(trim(p_line->>'description'), ''),
    nullif(trim(p_line->>'product_name'), ''),
    nullif(trim(p_line->>'description_original'), '')
  );
  v_brand text := public.normalize_foreign_trade_product_text(p_line->>'brand');
  v_lookup_key text;
  v_description_key text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 5), 10));
  v_mapping public.product_supplier_mappings%rowtype;
  v_result jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.view') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;

  v_description_key := case
    when public.normalize_foreign_trade_product_text(v_description_basis) is not null
      then 'DESCRIPTION:' || md5(public.normalize_foreign_trade_product_text(v_description_basis))
    else null
  end;
  v_lookup_key := coalesce(v_code, v_description_key);

  if p_supplier_id is not null and v_lookup_key is not null then
    select * into v_mapping
    from public.product_supplier_mappings
    where supplier_id = p_supplier_id
      and normalized_key in (v_code, v_description_key)
      and confirmed
    order by case when normalized_key = v_code then 0 else 1 end, updated_at desc
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
      'reasons', jsonb_build_array('Codigo o modelo historico exacto para este proveedor.')
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
        cp.category, cp.brand, supplier_aliases.alias_text, learned_aliases.alias_text, facto_aliases.alias_text)) as text_score,
      public.foreign_trade_technical_similarity(v_description, concat_ws(' ', cp.name, cp.sku, cp.description_text,
        cp.category, cp.brand, supplier_aliases.alias_text, learned_aliases.alias_text, facto_aliases.alias_text)) as technical_score,
      public.foreign_trade_technical_conflict_count(v_description, concat_ws(' ', cp.name, cp.sku, cp.description_text,
        cp.category, cp.brand, supplier_aliases.alias_text, learned_aliases.alias_text, facto_aliases.alias_text)) as technical_conflicts,
      facto_aliases.alias_text as facto_alias_text,
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
    left join lateral (
      select public.foreign_trade_facto_product_alias(cp.sku) alias_text
    ) facto_aliases on true
    where cp.source_status <> 'deleted'
  ), base_ranked as (
    select *, case
      when exact_sku then 0.95::numeric
      when public.normalize_foreign_trade_product_text(name) = public.normalize_foreign_trade_product_text(v_description)
        then 0.93::numeric
      when cardinality(public.foreign_trade_technical_tokens(v_description)) > 0
        then least(0.94::numeric, round(text_score * 0.70 + technical_score * 0.25 + brand_score * 0.05, 6))
      else least(0.89::numeric, round(text_score * 0.90 + brand_score * 0.10, 6))
    end base_score
    from scored
  ), ranked as (
    select *, case when exact_sku then base_score else
      greatest(0::numeric, base_score - least(0.45::numeric, technical_conflicts * 0.25::numeric))
    end score
    from base_ranked
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
    'reasons', jsonb_build_array(
      case when exact_sku then 'Coincidencia exacta con SKU interno; requiere confirmacion si aun no existe equivalencia del proveedor.' end,
      case when text_score >= 0.5 then 'Coincidencia relevante de descripcion original o traducida.' end,
      case when technical_score >= 0.8 then 'Atributos tecnicos compatibles.' end,
      case when technical_conflicts > 0 then format('Se detectaron %s atributo(s) tecnico(s) incompatibles.', technical_conflicts) end,
      case when brand_score = 1 then 'Marca coincidente.' end,
      case when facto_alias_text is not null then 'Alias de Facto enlazado mediante SKU interno exacto.' end
    )
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
  v_second_score numeric;
  v_method text;
  v_status text;
  v_selected uuid;
  v_reasons jsonb;
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
    operation.supplier_id
  ) into v_effective_supplier_id
  from public.import_shipments operation where operation.id = v_document.operation_id;

  for v_line in select value from jsonb_array_elements(v_document.extraction_result->'lines') loop
    v_position := v_position + 1;
    v_source_index := coalesce(nullif(trim(v_line->>'source_index'), '')::integer, v_position);
    v_candidates := public.foreign_trade_product_match_candidates(v_line, v_effective_supplier_id, 5);
    v_best := case when jsonb_array_length(v_candidates) > 0 then v_candidates->0 else '{}'::jsonb end;
    v_score := nullif(v_best->>'score', '')::numeric;
    v_second_score := case when jsonb_array_length(v_candidates) > 1 then nullif(v_candidates->1->>'score', '')::numeric else null end;
    v_method := nullif(v_best->>'method', '');
    v_selected := null;
    v_reasons := coalesce(v_best->'reasons', '[]'::jsonb);
    v_status := case
      when v_score is null then 'unmatched'
      when v_method in ('learned_mapping','exact_model') and v_score >= 0.98 then 'auto_matched'
      when v_score >= 0.80 and v_second_score is not null and v_score - v_second_score < 0.08 then 'review'
      when v_score >= 0.80 then 'suggested'
      when v_score >= 0.55 then 'review'
      else 'unmatched'
    end;
    if v_score is not null and v_second_score is not null and v_score - v_second_score < 0.08 then
      v_reasons := v_reasons || jsonb_build_array('Hay candidatos con puntajes cercanos; se requiere confirmacion humana.');
    end if;
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
      coalesce(nullif(trim(v_line->>'supplier_product_code'), ''), public.foreign_trade_extract_product_code(v_line)),
      nullif(trim(v_line->>'supplier_sku'), ''), nullif(trim(v_line->>'model'), ''),
      nullif(trim(v_line->>'supplier_reference'), ''),
      coalesce(nullif(trim(v_line->>'description_original'), ''), nullif(trim(v_line->>'description'), ''), nullif(trim(v_line->>'product_name'), '')),
      nullif(trim(v_line->>'description_translated'), ''),
      public.normalize_foreign_trade_product_text(concat_ws(' ', v_line->>'description_translated', v_line->>'description_original', v_line->>'description', v_line->>'product_name')),
      nullif(v_best->>'product_id', '')::uuid, v_selected, v_status, v_score, v_method,
      v_reasons, v_candidates
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
      select 1 from jsonb_array_elements(v_document.extraction_result->'lines') line
      where coalesce(nullif(trim(line->>'source_index'), '')::integer, -1) = reconciliation.source_index
    );

  select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.source_index), '[]'::jsonb)
  into v_lines
  from (
    select reconciliation.*
    from public.foreign_trade_product_reconciliations reconciliation
    where reconciliation.document_id = p_document_id
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

create or replace function public.foreign_trade_operation_product_reconciliation(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_summary jsonb;
  v_lines jsonb;
begin
  if not public.foreign_trade_has_permission('foreign_trade.view') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.import_shipments where id = p_operation_id) then
    raise exception 'foreign_trade_operation_not_found';
  end if;

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
  where operation_id = p_operation_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', reconciliation.id,
    'document_id', reconciliation.document_id,
    'document_name', document.original_file_name,
    'document_type', document.document_type,
    'operation_id', reconciliation.operation_id,
    'supplier_id', reconciliation.supplier_id,
    'supplier_name', supplier.name,
    'source_index', reconciliation.source_index,
    'source_page', reconciliation.source_page,
    'source_row_label', reconciliation.source_row_label,
    'supplier_product_code', reconciliation.supplier_product_code,
    'supplier_sku', reconciliation.supplier_sku,
    'supplier_model', reconciliation.supplier_model,
    'supplier_reference', reconciliation.supplier_reference,
    'original_description', reconciliation.original_description,
    'translated_description', reconciliation.translated_description,
    'normalized_description', reconciliation.normalized_description,
    'suggested_product_id', reconciliation.suggested_product_id,
    'suggested_product_name', suggested.name,
    'suggested_product_sku', suggested.sku,
    'selected_product_id', reconciliation.selected_product_id,
    'selected_product_name', selected.name,
    'selected_product_sku', selected.sku,
    'status', reconciliation.status,
    'confidence', reconciliation.confidence,
    'matching_method', reconciliation.matching_method,
    'match_reasons', reconciliation.match_reasons,
    'candidates', reconciliation.candidates,
    'remember_mapping', reconciliation.remember_mapping
  ) order by
    case reconciliation.status when 'unmatched' then 1 when 'review' then 2 when 'suggested' then 3 else 4 end,
    document.created_at desc, reconciliation.source_index), '[]'::jsonb)
  into v_lines
  from public.foreign_trade_product_reconciliations reconciliation
  join public.foreign_trade_documents document on document.id = reconciliation.document_id
  left join public.suppliers supplier on supplier.id = reconciliation.supplier_id
  left join public.content_products suggested on suggested.id = reconciliation.suggested_product_id
  left join public.content_products selected on selected.id = reconciliation.selected_product_id
  where reconciliation.operation_id = p_operation_id;

  return jsonb_build_object('operation_id', p_operation_id, 'summary', v_summary, 'lines', v_lines);
end
$$;

create or replace function public.confirm_foreign_trade_packing_list_with_reconciliation(
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
  v_key text;
  v_include boolean;
  v_result jsonb;
  v_position integer := 0;
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
  if v_document.document_type <> 'packing_list' then raise exception 'foreign_trade_document_is_not_packing_list'; end if;
  select coalesce(
    nullif(trim(p_review->'general'->>'supplier_id'), '')::uuid,
    v_document.supplier_id,
    operation.supplier_id
  ) into v_supplier_id
  from public.import_shipments operation where operation.id = v_document.operation_id;

  for v_line in select value from jsonb_array_elements(p_review->'lines') loop
    v_position := v_position + 1;
    v_source_index := coalesce(nullif(trim(v_line->>'source_index'), '')::integer, v_position);
    v_include := coalesce((v_line->>'include')::boolean, true);
    v_product_id := case when v_include then nullif(trim(v_line->>'content_product_id'), '')::uuid else null end;
    if v_product_id is not null and not exists (select 1 from public.content_products where id = v_product_id) then
      raise exception 'foreign_trade_product_not_found';
    end if;

    insert into public.foreign_trade_product_reconciliations(
      document_id, operation_id, supplier_id, source_index, source_page, source_row_label,
      supplier_product_code, supplier_sku, supplier_model, supplier_reference,
      original_description, translated_description, normalized_description,
      suggested_product_id, selected_product_id, status, confidence, matching_method,
      match_reasons, candidates, remember_mapping, confirmed_at, confirmed_by
    ) values (
      p_document_id, v_document.operation_id, v_supplier_id, v_source_index,
      nullif(trim(v_line->>'source_page'), '')::integer, nullif(trim(v_line->>'source_row_label'), ''),
      coalesce(nullif(trim(v_line->>'supplier_product_code'), ''), public.foreign_trade_extract_product_code(v_line)),
      nullif(trim(v_line->>'supplier_sku'), ''), nullif(trim(v_line->>'model'), ''), nullif(trim(v_line->>'supplier_reference'), ''),
      coalesce(nullif(trim(v_line->>'description_original'), ''), nullif(trim(v_line->>'description'), ''), nullif(trim(v_line->>'product_name'), '')),
      nullif(trim(v_line->>'description_translated'), ''),
      public.normalize_foreign_trade_product_text(concat_ws(' ', v_line->>'description_translated', v_line->>'description_original', v_line->>'description', v_line->>'product_name')),
      v_product_id, v_product_id,
      case when not v_include then 'rejected' when v_product_id is null then 'unmatched' else 'confirmed' end,
      case when v_product_id is null then null else 1 end,
      case when v_product_id is null then null else 'manual' end,
      case when v_product_id is null then '[]'::jsonb else jsonb_build_array('Producto de Packing List confirmado por una persona.') end,
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

    if v_product_id is not null and v_supplier_id is not null
       and coalesce((v_line->>'remember_link')::boolean, false) then
      v_key := public.normalize_foreign_trade_product_code(public.foreign_trade_extract_product_code(v_line));
      if v_key is null then
        v_key := 'DESCRIPTION:' || md5(coalesce(
          public.normalize_foreign_trade_product_text(concat_ws(' ', v_line->>'description_translated', v_line->>'description_original', v_line->>'description', v_line->>'product_name')),
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
        v_supplier_id, v_product_id, coalesce(nullif(trim(v_line->>'supplier_product_code'), ''), public.foreign_trade_extract_product_code(v_line)),
        nullif(trim(v_line->>'supplier_sku'), ''), nullif(trim(v_line->>'model'), ''), nullif(trim(v_line->>'supplier_reference'), ''), v_key,
        coalesce(nullif(trim(v_line->>'description_original'), ''), nullif(trim(v_line->>'description'), ''), nullif(trim(v_line->>'product_name'), '')),
        nullif(trim(v_line->>'description_translated'), ''),
        public.normalize_foreign_trade_product_text(concat_ws(' ', v_line->>'description_translated', v_line->>'description_original', v_line->>'description', v_line->>'product_name')),
        nullif(trim(v_line->>'brand'), ''), true, 1, 'manual',
        jsonb_build_array('Equivalencia confirmada desde Packing List.'),
        p_document_id, auth.uid(), auth.uid(), auth.uid()
      )
      on conflict (supplier_id, normalized_key) do update set
        internal_product_id = excluded.internal_product_id,
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

  v_result := public.confirm_foreign_trade_packing_list_document(p_document_id, p_review);
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
        or lower(coalesce(public.foreign_trade_facto_product_alias(cp.sku), '')) like v_term
      )
    order by cp.name
    limit v_limit
  ) product_row;
  return v_result;
end
$$;

revoke all on function public.foreign_trade_extract_product_code(jsonb) from public;
revoke all on function public.foreign_trade_technical_conflict_count(text, text) from public;
revoke all on function public.foreign_trade_facto_product_alias(text) from public;
revoke all on function public.foreign_trade_product_match_candidates(jsonb, uuid, integer) from public;
revoke all on function public.reconcile_foreign_trade_document(uuid, uuid) from public;
revoke all on function public.foreign_trade_operation_product_reconciliation(uuid) from public;
revoke all on function public.confirm_foreign_trade_packing_list_with_reconciliation(uuid, jsonb) from public;
revoke all on function public.foreign_trade_product_catalog(text, integer) from public;

grant execute on function public.foreign_trade_extract_product_code(jsonb) to authenticated, service_role;
grant execute on function public.foreign_trade_technical_conflict_count(text, text) to authenticated, service_role;
grant execute on function public.foreign_trade_facto_product_alias(text) to authenticated, service_role;
grant execute on function public.foreign_trade_product_match_candidates(jsonb, uuid, integer) to authenticated, service_role;
grant execute on function public.reconcile_foreign_trade_document(uuid, uuid) to authenticated, service_role;
grant execute on function public.foreign_trade_operation_product_reconciliation(uuid) to authenticated, service_role;
grant execute on function public.confirm_foreign_trade_packing_list_with_reconciliation(uuid, jsonb) to authenticated, service_role;
grant execute on function public.foreign_trade_product_catalog(text, integer) to authenticated, service_role;

comment on function public.foreign_trade_operation_product_reconciliation(uuid) is
  'Bandeja auditable de conciliaciones de producto de una operacion; no modifica el catalogo maestro.';
comment on function public.confirm_foreign_trade_packing_list_with_reconciliation(uuid, jsonb) is
  'Confirma equivalencias por proveedor y luego completa empaque sin crear productos ni reemplazar costos.';

commit;
