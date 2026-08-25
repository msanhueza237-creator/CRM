-- Clima Activa CRM - Comercio Exterior fase 13
-- Packing List completa empaque, volumen y peso sobre las lineas comerciales
-- ya importadas. Nunca crea productos ni reemplaza costos del Invoice.

begin;

-- El trigger de perfiles logisticos (fase 11) utiliza estos normalizadores.
-- Se vuelven a declarar aqui para que la confirmacion de Packing List funcione
-- tambien en instalaciones donde la fase 11 se aplico sin ejecutar la fase 10.
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

create or replace function public.foreign_trade_packing_text_key(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(
    regexp_replace(
      regexp_replace(lower(coalesce(p_value, '')), '(brand|super|stars)', '', 'g'),
      '[^a-z0-9]',
      '',
      'g'
    ),
    ''
  )
$$;

create or replace function public.foreign_trade_packing_model_key(p_value text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_match text[];
begin
  v_match := regexp_match(
    regexp_replace(upper(coalesce(p_value, '')), '\mSTARS\M', '', 'g'),
    '\mST[- ]?[A-Z0-9-]+\M'
  );
  if v_match is null then return null; end if;
  return nullif(regexp_replace(v_match[1], '[^A-Z0-9]', '', 'g'), '');
end
$$;

create or replace function public.confirm_foreign_trade_packing_list_document(
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
  v_line jsonb;
  v_source_index integer;
  v_product_name text;
  v_text_key text;
  v_model_key text;
  v_content_product_id uuid;
  v_target_line_id uuid;
  v_quantity numeric(18,6);
  v_box_count numeric(18,6);
  v_cbm_total numeric(18,6);
  v_gross_weight numeric(18,6);
  v_net_weight numeric(18,6);
  v_confidence numeric(7,6);
  v_selected integer := 0;
  v_matched integer := 0;
  v_unmatched integer := 0;
  v_updated integer := 0;
begin
  if not public.foreign_trade_has_permission('foreign_trade.documents.manage')
     or not public.foreign_trade_has_permission('foreign_trade.operations.manage') then
    raise exception 'foreign_trade_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_review, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(p_review->'lines') <> 'array' then
    raise exception 'foreign_trade_invalid_review';
  end if;
  if jsonb_array_length(p_review->'lines') > 500 then
    raise exception 'foreign_trade_too_many_document_lines';
  end if;

  select * into v_document
  from public.foreign_trade_documents
  where id = p_document_id
  for update;
  if not found then raise exception 'foreign_trade_document_not_found'; end if;
  if v_document.operation_id is null then raise exception 'foreign_trade_document_without_operation'; end if;
  if v_document.document_type <> 'packing_list' then
    raise exception 'foreign_trade_document_is_not_packing_list';
  end if;
  if v_document.parse_status not in ('review_required', 'confirmed') then
    raise exception 'foreign_trade_document_not_ready';
  end if;

  create temporary table if not exists foreign_trade_packing_matches (
    target_line_id uuid primary key,
    packing_quantity numeric(18,6),
    box_count numeric(18,6),
    cbm_total numeric(18,6),
    gross_weight_kg numeric(18,6),
    net_weight_kg numeric(18,6),
    confidence numeric(7,6),
    source_indexes jsonb not null default '[]'::jsonb
  ) on commit drop;
  truncate table pg_temp.foreign_trade_packing_matches;

  for v_line in select value from jsonb_array_elements(p_review->'lines') loop
    if coalesce((v_line->>'include')::boolean, true) is false then continue; end if;
    v_selected := v_selected + 1;
    v_source_index := coalesce(nullif(trim(v_line->>'source_index'), '')::integer, v_selected);
    v_product_name := trim(coalesce(
      nullif(v_line->>'product_name', ''),
      nullif(v_line->>'description_original', ''),
      nullif(v_line->>'description', ''),
      ''
    ));
    v_text_key := public.foreign_trade_packing_text_key(v_product_name);
    v_model_key := coalesce(
      public.foreign_trade_packing_model_key(v_line->>'model'),
      public.foreign_trade_packing_model_key(v_product_name)
    );
    v_content_product_id := nullif(trim(v_line->>'content_product_id'), '')::uuid;
    v_quantity := nullif(trim(v_line->>'quantity'), '')::numeric;
    v_box_count := nullif(trim(v_line->>'box_count'), '')::numeric;
    v_cbm_total := nullif(trim(v_line->>'cbm_total'), '')::numeric;
    v_gross_weight := nullif(trim(v_line->>'gross_weight_kg'), '')::numeric;
    v_net_weight := nullif(trim(v_line->>'net_weight_kg'), '')::numeric;
    v_confidence := nullif(trim(v_line->>'confidence'), '')::numeric;
    v_target_line_id := null;

    select candidate.id into v_target_line_id
    from public.foreign_trade_operation_lines candidate
    left join pg_temp.foreign_trade_packing_matches assigned
      on assigned.target_line_id = candidate.id
    where candidate.operation_id = v_document.operation_id
      and candidate.source_document_id is distinct from p_document_id
      and (
        (v_content_product_id is not null and candidate.content_product_id = v_content_product_id)
        or (
          nullif(trim(v_line->>'supplier_sku'), '') is not null
          and lower(coalesce(candidate.supplier_sku, candidate.sku, '')) = lower(trim(v_line->>'supplier_sku'))
        )
        or (
          v_model_key is not null
          and (
            public.foreign_trade_packing_model_key(candidate.supplier_model) = v_model_key
            or public.foreign_trade_packing_model_key(candidate.product_name) = v_model_key
            or public.foreign_trade_packing_model_key(candidate.description) = v_model_key
          )
        )
        or (
          v_text_key is not null
          and (
            public.foreign_trade_packing_text_key(candidate.product_name) = v_text_key
            or public.foreign_trade_packing_text_key(candidate.description) = v_text_key
            or (
              length(coalesce(public.foreign_trade_packing_text_key(candidate.product_name), '')) >= 12
              and v_text_key like public.foreign_trade_packing_text_key(candidate.product_name) || '%'
            )
          )
        )
      )
    order by
      case
        when v_content_product_id is not null and candidate.content_product_id = v_content_product_id then 1000
        when nullif(trim(v_line->>'supplier_sku'), '') is not null
          and lower(coalesce(candidate.supplier_sku, candidate.sku, '')) = lower(trim(v_line->>'supplier_sku')) then 950
        when v_model_key is not null
          and (
            public.foreign_trade_packing_model_key(candidate.supplier_model) = v_model_key
            or public.foreign_trade_packing_model_key(candidate.product_name) = v_model_key
            or public.foreign_trade_packing_model_key(candidate.description) = v_model_key
          ) then 900
        when v_text_key is not null
          and (
            public.foreign_trade_packing_text_key(candidate.product_name) = v_text_key
            or public.foreign_trade_packing_text_key(candidate.description) = v_text_key
          ) then 850
        else 800
      end desc,
      case
        when v_quantity is null then 0
        else abs(candidate.quantity - (coalesce(assigned.packing_quantity, 0) + v_quantity))
      end,
      candidate.line_number
    limit 1;

    if v_target_line_id is null then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;
    v_matched := v_matched + 1;

    insert into pg_temp.foreign_trade_packing_matches(
      target_line_id, packing_quantity, box_count, cbm_total,
      gross_weight_kg, net_weight_kg, confidence, source_indexes
    ) values (
      v_target_line_id, v_quantity, v_box_count, v_cbm_total,
      v_gross_weight, v_net_weight, v_confidence, jsonb_build_array(v_source_index)
    )
    on conflict (target_line_id) do update set
      packing_quantity = case
        when foreign_trade_packing_matches.packing_quantity is null and excluded.packing_quantity is null then null
        else coalesce(foreign_trade_packing_matches.packing_quantity, 0) + coalesce(excluded.packing_quantity, 0)
      end,
      box_count = case
        when foreign_trade_packing_matches.box_count is null and excluded.box_count is null then null
        else coalesce(foreign_trade_packing_matches.box_count, 0) + coalesce(excluded.box_count, 0)
      end,
      cbm_total = case
        when foreign_trade_packing_matches.cbm_total is null and excluded.cbm_total is null then null
        else coalesce(foreign_trade_packing_matches.cbm_total, 0) + coalesce(excluded.cbm_total, 0)
      end,
      gross_weight_kg = case
        when foreign_trade_packing_matches.gross_weight_kg is null and excluded.gross_weight_kg is null then null
        else coalesce(foreign_trade_packing_matches.gross_weight_kg, 0) + coalesce(excluded.gross_weight_kg, 0)
      end,
      net_weight_kg = case
        when foreign_trade_packing_matches.net_weight_kg is null and excluded.net_weight_kg is null then null
        else coalesce(foreign_trade_packing_matches.net_weight_kg, 0) + coalesce(excluded.net_weight_kg, 0)
      end,
      confidence = greatest(coalesce(foreign_trade_packing_matches.confidence, 0), coalesce(excluded.confidence, 0)),
      source_indexes = foreign_trade_packing_matches.source_indexes || excluded.source_indexes;
  end loop;

  if v_matched = 0 then
    raise exception 'foreign_trade_packing_list_without_matching_products';
  end if;

  update public.foreign_trade_operation_lines operation_line
  set quantity_per_box = case
        when match.box_count > 0 and operation_line.quantity > 0 then round(operation_line.quantity / match.box_count, 6)
        else operation_line.quantity_per_box
      end,
      box_count = coalesce(match.box_count, operation_line.box_count),
      unit_weight_kg = case
        when match.net_weight_kg > 0 and operation_line.quantity > 0 then round(match.net_weight_kg / operation_line.quantity, 6)
        else operation_line.unit_weight_kg
      end,
      gross_weight_kg = coalesce(match.gross_weight_kg, operation_line.gross_weight_kg),
      net_weight_kg = coalesce(match.net_weight_kg, operation_line.net_weight_kg),
      cbm_per_box = case
        when match.cbm_total > 0 and match.box_count > 0 then round(match.cbm_total / match.box_count, 9)
        else operation_line.cbm_per_box
      end,
      cbm_total = coalesce(match.cbm_total, operation_line.cbm_total),
      extraction_confidence = greatest(coalesce(operation_line.extraction_confidence, 0), coalesce(match.confidence, 0)),
      source_snapshot = coalesce(operation_line.source_snapshot, '{}'::jsonb) || jsonb_build_object(
        'packing_list_document_id', p_document_id,
        'packing_list_source_indexes', match.source_indexes,
        'packing_list_quantity', match.packing_quantity,
        'packing_list_confirmed_at', now()
      ),
      missing_fields = array_remove(array_remove(array_remove(array_remove(array_remove(
        operation_line.missing_fields,
        'quantity_per_box'
      ), 'box_count'), 'unit_weight_kg'), 'cbm_per_box'), 'cbm_total'),
      warnings = coalesce(operation_line.warnings, '[]'::jsonb) || case
        when match.packing_quantity is not null
          and operation_line.quantity > 0
          and abs(match.packing_quantity - operation_line.quantity) > 0.001
        then jsonb_build_array(format(
          'Packing List informa %s unidades y Commercial Invoice %s; revisar diferencia.',
          match.packing_quantity,
          operation_line.quantity
        ))
        else '[]'::jsonb
      end,
      updated_by = auth.uid(),
      updated_at = now()
  from pg_temp.foreign_trade_packing_matches match
  where operation_line.id = match.target_line_id;
  get diagnostics v_updated = row_count;

  update public.foreign_trade_documents
  set parse_status = 'confirmed',
      review_result = p_review || jsonb_build_object(
        'packing_list_enrichment', jsonb_build_object(
          'updated_lines', v_updated,
          'matched_packing_lines', v_matched,
          'unmatched_lines', v_unmatched
        )
      ),
      confirmed_at = now(),
      confirmed_by = auth.uid(),
      extraction_error = null
  where id = p_document_id;

  return jsonb_build_object(
    'document_id', p_document_id,
    'operation_id', v_document.operation_id,
    'inserted_lines', 0,
    'skipped_lines', greatest(v_selected - v_matched - v_unmatched, 0),
    'updated_lines', v_updated,
    'matched_packing_lines', v_matched,
    'unmatched_lines', v_unmatched,
    'status', 'confirmed'
  );
end
$$;

revoke all on function public.foreign_trade_packing_text_key(text) from public;
revoke all on function public.foreign_trade_packing_model_key(text) from public;
revoke all on function public.confirm_foreign_trade_packing_list_document(uuid, jsonb) from public;
grant execute on function public.confirm_foreign_trade_packing_list_document(uuid, jsonb) to authenticated, service_role;

comment on function public.confirm_foreign_trade_packing_list_document(uuid, jsonb) is
  'Completa cajas, pesos y CBM de productos existentes sin crear lineas comerciales duplicadas.';

commit;
