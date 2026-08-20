-- Clima Activa CRM - Centro de Contenido Inteligente
-- Ejecutar despues de schema.sql y agent_hub.sql.
-- La migracion es idempotente y nunca almacena secretos de proveedores.

create extension if not exists pgcrypto;

-- Meta Social es una conexion distinta de Meta WhatsApp. Las credenciales
-- permanecen en el entorno de la Edge Function y se administran desde el CRM.
alter table public.integration_connections
  drop constraint if exists integration_connections_provider_check;

alter table public.integration_connections
  add constraint integration_connections_provider_check check (
    provider in ('facto','tiendanube','gmail','brave','meta_whatsapp','meta_social')
  );

insert into public.integration_connections(provider, enabled, read_only, status, message)
values (
  'meta_social', false, false, 'pending_configuration',
  'Configura Instagram y Facebook desde Administracion > Integraciones.'
)
on conflict (provider) do nothing;

create table if not exists public.content_role_permissions (
  role public.app_role not null,
  permission text not null check (permission in (
    'content.view','content.generate','content.edit','content.approve',
    'content.schedule','content.publish','content.automation.manage',
    'content.brand.manage','content.templates.manage','content.metrics.view',
    'content.settings.manage'
  )),
  allowed boolean not null default true,
  primary key (role, permission)
);

insert into public.content_role_permissions(role, permission, allowed)
select 'administrador'::public.app_role, permission, true
from unnest(array[
  'content.view','content.generate','content.edit','content.approve',
  'content.schedule','content.publish','content.automation.manage',
  'content.brand.manage','content.templates.manage','content.metrics.view',
  'content.settings.manage'
]) as permission
on conflict (role, permission) do nothing;

insert into public.content_role_permissions(role, permission, allowed)
select 'vendedor'::public.app_role, permission, true
from unnest(array[
  'content.view','content.generate','content.edit','content.schedule',
  'content.metrics.view'
]) as permission
on conflict (role, permission) do nothing;

insert into public.content_role_permissions(role, permission, allowed)
values
  ('visualizador', 'content.view', true),
  ('visualizador', 'content.metrics.view', true)
on conflict (role, permission) do nothing;

create or replace function public.content_has_permission(p_permission text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.content_role_permissions rp
    where rp.role = public.current_role()
      and rp.permission = p_permission
      and rp.allowed = true
  )
$$;

create table if not exists public.content_channels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code in ('instagram','facebook')),
  name text not null,
  integration_provider text not null default 'meta_social'
    references public.integration_connections(provider),
  enabled boolean not null default false,
  operation_mode text not null default 'approval'
    check (operation_mode in ('manual','approval','autopilot')),
  external_account_id text,
  external_account_name text,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.content_channels(code, name)
values ('instagram', 'Instagram'), ('facebook', 'Facebook')
on conflict (code) do nothing;

create table if not exists public.content_products (
  id uuid primary key default gen_random_uuid(),
  source_provider text not null default 'tiendanube'
    references public.integration_connections(provider),
  external_id text not null,
  payload_hash text not null,
  sku text,
  name text not null,
  description_html text,
  description_text text,
  category text,
  categories jsonb not null default '[]'::jsonb check (jsonb_typeof(categories) = 'array'),
  variants jsonb not null default '[]'::jsonb check (jsonb_typeof(variants) = 'array'),
  price numeric(14,2),
  promotional_price numeric(14,2),
  stock integer,
  has_stock boolean,
  brand text,
  images jsonb not null default '[]'::jsonb check (jsonb_typeof(images) = 'array'),
  primary_image_url text,
  product_url text,
  source_status text not null default 'active'
    check (source_status in ('active','unpublished','deleted','invalid')),
  sync_status text not null default 'synced'
    check (sync_status in ('synced','incomplete','error')),
  missing_fields text[] not null default '{}'::text[],
  paused boolean not null default false,
  pause_reason text,
  source_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_provider, external_id)
);

create index if not exists content_products_status_idx
  on public.content_products(source_status, sync_status, paused);
create index if not exists content_products_category_idx
  on public.content_products(category);
create index if not exists content_products_synced_idx
  on public.content_products(last_synced_at desc);

create table if not exists public.brand_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  brand_name text not null,
  description text not null default '',
  tone text not null default 'profesional y cercano',
  formality smallint not null default 3 check (formality between 1 and 5),
  emoji_policy text not null default 'moderate'
    check (emoji_policy in ('none','low','moderate','expressive')),
  commercial_style text not null default '',
  technical_style text not null default '',
  recommended_words text[] not null default '{}'::text[],
  forbidden_words text[] not null default '{}'::text[],
  cta_style text not null default '',
  hashtag_rules text not null default '',
  key_messages text[] not null default '{}'::text[],
  differentiators text[] not null default '{}'::text[],
  additional_instructions text not null default '',
  active boolean not null default true,
  is_default boolean not null default false,
  configured boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists brand_profiles_one_default_idx
  on public.brand_profiles(is_default) where is_default = true;

insert into public.brand_profiles(name, brand_name, description, is_default)
values (
  'Marca principal', 'Clima Activa',
  'Marca especializada en climatizacion y herramientas para tecnicos e instaladores.',
  true
)
on conflict (name) do nothing;

create table if not exists public.content_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text not null default '',
  category text not null,
  channels text[] not null default array['instagram','facebook'],
  instruction text not null,
  structure jsonb not null default '{}'::jsonb check (jsonb_typeof(structure) = 'object'),
  active boolean not null default true,
  system_template boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(channels) > 0)
);

insert into public.content_templates(name, slug, description, category, instruction, structure, system_template)
values
  ('Comercial', 'comercial', 'Presenta el producto con foco en decision de compra.', 'comercial', 'Explica el valor comercial usando solo hechos confirmados. Cierra con una llamada a la accion clara.', '{"opening":"benefit","body":"facts","closing":"cta"}', true),
  ('Tecnico', 'tecnico', 'Destaca especificaciones verificadas y usos profesionales.', 'tecnico', 'Prioriza datos tecnicos presentes en la ficha. Si falta un dato, omite la afirmacion.', '{"opening":"product","body":"verified_specs","closing":"professional_cta"}', true),
  ('Educativo', 'educativo', 'Enseña una practica o concepto relacionado.', 'educativo', 'Entrega aprendizaje util y conecta el producto sin inventar capacidades.', '{"opening":"lesson","body":"explanation","closing":"soft_cta"}', true),
  ('Producto destacado', 'producto-destacado', 'Presentacion editorial de un producto.', 'producto', 'Presenta el producto, sus datos principales y una razon verificable para conocerlo.', '{"opening":"product_name","body":"highlights","closing":"cta"}', true),
  ('Promocion', 'promocion', 'Comunica precio promocional cuando existe.', 'promocion', 'Menciona promocion solo si promotional_price contiene un valor vigente en Tiendanube.', '{"opening":"promotion","body":"product_facts","closing":"urgency_without_pressure"}', true),
  ('Novedad', 'novedad', 'Introduce una incorporacion reciente.', 'novedad', 'Usa lenguaje de novedad solo cuando el contexto proporcionado lo autorice.', '{"opening":"news","body":"facts","closing":"discover"}', true),
  ('Beneficios', 'beneficios', 'Traduce caracteristicas verificadas en valor de uso.', 'beneficios', 'Relaciona cada beneficio con una caracteristica existente en la fuente.', '{"opening":"need","body":"fact_to_benefit","closing":"cta"}', true),
  ('Temporada', 'temporada', 'Adapta el mensaje al contexto estacional.', 'temporada', 'Vincula el producto con la temporada indicada sin afirmar demanda, stock o descuentos no confirmados.', '{"opening":"season","body":"relevance","closing":"cta"}', true),
  ('Problema y solucion', 'problema-solucion', 'Parte de una necesidad real y presenta una alternativa.', 'educativo', 'Describe un problema general y explica como los hechos confirmados del producto pueden ayudar.', '{"opening":"problem","body":"solution_with_facts","closing":"question"}', true),
  ('Pregunta al cliente', 'pregunta-cliente', 'Invita a conversar con la audiencia.', 'comunidad', 'Formula una pregunta relevante, aporta contexto verificable y promueve respuestas.', '{"opening":"question","body":"context","closing":"conversation"}', true),
  ('CTA directo', 'cta-directo', 'Mensaje breve con accion concreta.', 'comercial', 'Redacta de forma breve, precisa y accionable sin crear urgencia falsa.', '{"opening":"product","body":"one_fact","closing":"direct_cta"}', true),
  ('Informativo', 'informativo', 'Resume informacion confirmada del producto.', 'informativo', 'Resume la ficha con lenguaje claro y neutral.', '{"opening":"summary","body":"facts","closing":"learn_more"}', true),
  ('Cercano y alegre', 'cercano-alegre', 'Mensaje humano y positivo.', 'tono', 'Usa un tono cercano sin exageraciones ni afirmaciones no verificadas.', '{"opening":"friendly","body":"facts","closing":"warm_cta"}', true),
  ('Profesional', 'profesional', 'Comunicacion sobria para clientes y empresas.', 'tono', 'Usa lenguaje profesional, concreto y confiable.', '{"opening":"context","body":"verified_value","closing":"professional_cta"}', true),
  ('Minimalista', 'minimalista', 'Una idea principal con muy poco texto.', 'tono', 'Usa solo nombre, un hecho importante y una llamada a la accion.', '{"opening":"product","body":"single_fact","closing":"short_cta"}', true)
on conflict (slug) do nothing;

create table if not exists public.content_publications (
  id uuid primary key default gen_random_uuid(),
  generation_group_id uuid not null default gen_random_uuid(),
  product_id uuid references public.content_products(id) on delete set null,
  channel_id uuid not null references public.content_channels(id),
  template_id uuid references public.content_templates(id) on delete set null,
  brand_profile_id uuid references public.brand_profiles(id) on delete set null,
  publication_type text not null default 'feed',
  objective text not null default '',
  cta text not null default '',
  body text not null,
  hashtags text[] not null default '{}'::text[],
  image_url text,
  source_facts jsonb not null default '{}'::jsonb check (jsonb_typeof(source_facts) = 'object'),
  missing_facts text[] not null default '{}'::text[],
  content_fingerprint text not null,
  model_name text,
  generator_type text not null default 'user'
    check (generator_type in ('user','agent','autopilot')),
  generator_id text,
  operation_mode text not null default 'manual'
    check (operation_mode in ('manual','approval','autopilot')),
  status text not null default 'draft'
    check (status in ('draft','pending_approval','approved','scheduled','publishing','published','failed','partial','paused','cancelled')),
  scheduled_at timestamptz,
  published_at timestamptz,
  external_id text,
  external_url text,
  error_code text,
  error_message text,
  retry_count integer not null default 0 check (retry_count >= 0),
  idempotency_key text unique,
  correlation_id uuid not null default gen_random_uuid(),
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_publications_calendar_idx
  on public.content_publications(scheduled_at, status);
create index if not exists content_publications_product_idx
  on public.content_publications(product_id, created_at desc);
create index if not exists content_publications_channel_idx
  on public.content_publications(channel_id, created_at desc);
create index if not exists content_publications_fingerprint_idx
  on public.content_publications(content_fingerprint, created_at desc);

create table if not exists public.content_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  channel_ids uuid[] not null,
  recurrence_type text not null default 'interval_days'
    check (recurrence_type in ('once','daily','interval_days','weekdays')),
  recurrence_rule jsonb not null default '{}'::jsonb check (jsonb_typeof(recurrence_rule) = 'object'),
  product_filter jsonb not null default '{}'::jsonb check (jsonb_typeof(product_filter) = 'object'),
  operation_mode text not null default 'approval'
    check (operation_mode in ('manual','approval','autopilot')),
  timezone text not null default 'America/Santiago',
  starts_at timestamptz not null,
  ends_at timestamptz,
  next_run_at timestamptz,
  last_run_at timestamptz,
  active boolean not null default true,
  paused_until timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(channel_ids) > 0),
  check (ends_at is null or ends_at > starts_at)
);

create index if not exists content_schedules_due_idx
  on public.content_schedules(active, next_run_at) where active = true;

create table if not exists public.content_automation_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  channel_id uuid references public.content_channels(id) on delete cascade,
  enabled boolean not null default false,
  operation_mode text not null default 'approval'
    check (operation_mode in ('approval','autopilot')),
  min_product_gap_days integer not null default 14 check (min_product_gap_days between 1 and 365),
  min_text_similarity_gap_days integer not null default 30 check (min_text_similarity_gap_days between 1 and 365),
  category_rotation boolean not null default true,
  require_stock boolean not null default true,
  require_image boolean not null default true,
  max_retries integer not null default 4 check (max_retries between 0 and 10),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists content_automation_rules_channel_idx
  on public.content_automation_rules(channel_id) where channel_id is not null;

create table if not exists public.content_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('catalog_sync','generate','publish','metrics_sync','automation_tick')),
  publication_id uuid references public.content_publications(id) on delete cascade,
  schedule_id uuid references public.content_schedules(id) on delete set null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending'
    check (status in ('pending','running','completed','retry','failed','cancelled')),
  priority smallint not null default 50 check (priority between 0 and 100),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 4 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  worker_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  idempotency_key text not null unique,
  correlation_id uuid not null default gen_random_uuid(),
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists content_jobs_claim_idx
  on public.content_jobs(status, next_attempt_at, priority desc, created_at);

create table if not exists public.content_history (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid references public.content_publications(id) on delete set null,
  product_id uuid references public.content_products(id) on delete set null,
  job_id uuid references public.content_jobs(id) on delete set null,
  event_type text not null,
  level text not null default 'info' check (level in ('debug','info','warning','error')),
  message text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  correlation_id uuid,
  actor_type text not null default 'system' check (actor_type in ('user','agent','worker','system')),
  actor_id text,
  created_at timestamptz not null default now()
);

create index if not exists content_history_publication_idx
  on public.content_history(publication_id, created_at desc);
create index if not exists content_history_correlation_idx
  on public.content_history(correlation_id, created_at);

create table if not exists public.content_metrics (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.content_publications(id) on delete cascade,
  observed_at timestamptz not null,
  impressions integer,
  reach integer,
  likes integer,
  comments integer,
  shares integer,
  saves integer,
  clicks integer,
  engagement_rate numeric(8,4),
  raw_metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_metrics) = 'object'),
  created_at timestamptz not null default now(),
  unique (publication_id, observed_at)
);

create index if not exists content_metrics_publication_idx
  on public.content_metrics(publication_id, observed_at desc);

-- Lee correctamente campos localizados de Tiendanube sin asumir que siempre
-- llegan como texto simple.
create or replace function public.content_localized_text(p_value jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(trim(case
    when p_value is null or p_value = 'null'::jsonb then ''
    when jsonb_typeof(p_value) = 'string' then p_value #>> '{}'
    when jsonb_typeof(p_value) = 'object' then coalesce(
      p_value->>'es', p_value->>'es_CL', p_value->>'en',
      (select value from jsonb_each_text(p_value) limit 1), ''
    )
    else p_value::text
  end), '')
$$;

create or replace function public.sync_content_products_from_tiendanube()
returns table(synchronized integer, incomplete integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(public.current_role()::text, '');
begin
  if auth.uid() is not null
     and v_role <> 'administrador'
     and current_user not in ('postgres','supabase_admin','service_role') then
    raise exception 'Solo administradores pueden sincronizar el catalogo de contenido';
  end if;

  return query
  with source as (
    select
      ir.external_id,
      ir.payload,
      ir.payload_hash,
      ir.updated_at,
      public.content_localized_text(ir.payload->'name') as product_name,
      public.content_localized_text(ir.payload->'description') as product_description_html,
      public.content_localized_text(ir.payload->'handle') as product_handle,
      public.content_localized_text((ir.payload->'categories')->0->'name') as product_category,
      nullif(trim(ir.payload->>'brand'), '') as product_brand,
      nullif(trim((ir.payload->'images')->0->>'src'), '') as image_url,
      (
        select nullif(trim(variant->>'sku'), '')
        from jsonb_array_elements(coalesce(ir.payload->'variants', '[]'::jsonb)) variant
        where nullif(trim(variant->>'sku'), '') is not null
        limit 1
      ) as product_sku,
      (
        select min(nullif(variant->>'price', '')::numeric)
        from jsonb_array_elements(coalesce(ir.payload->'variants', '[]'::jsonb)) variant
      ) as product_price,
      (
        select min(nullif(variant->>'promotional_price', '')::numeric)
        from jsonb_array_elements(coalesce(ir.payload->'variants', '[]'::jsonb)) variant
        where nullif(variant->>'promotional_price', '') is not null
      ) as product_promotional_price,
      (
        select sum(coalesce(nullif(variant->>'stock', '')::integer, 0))
        from jsonb_array_elements(coalesce(ir.payload->'variants', '[]'::jsonb)) variant
      ) as product_stock,
      exists (
        select 1
        from jsonb_array_elements(coalesce(ir.payload->'variants', '[]'::jsonb)) variant
        where coalesce((variant->>'stock_management')::boolean, false) = false
           or coalesce(nullif(variant->>'stock', '')::integer, 0) > 0
      ) as product_has_stock
    from public.integration_records ir
    where ir.provider = 'tiendanube' and ir.resource = 'products'
  ), normalized as (
    select
      source.*,
      nullif(trim(regexp_replace(coalesce(product_description_html, ''), '<[^>]+>', ' ', 'g')), '') as product_description_text,
      array_remove(array[
        case when product_name is null then 'name' end,
        case when product_description_html is null then 'description' end,
        case when image_url is null then 'image' end,
        case when product_price is null then 'price' end
      ], null) as missing,
      case
        when payload->>'invalid_at' is not null then 'deleted'
        when coalesce((payload->>'published')::boolean, false) = false then 'unpublished'
        else 'active'
      end as normalized_source_status
    from source
  ), upserted as (
    insert into public.content_products(
      source_provider, external_id, payload_hash, sku, name,
      description_html, description_text, category, categories, variants,
      price, promotional_price, stock, has_stock, brand, images,
      primary_image_url, product_url, source_status, sync_status,
      missing_fields, source_updated_at, last_synced_at
    )
    select
      'tiendanube', external_id, payload_hash, product_sku,
      coalesce(product_name, 'Producto ' || external_id),
      product_description_html, product_description_text, product_category,
      coalesce(payload->'categories', '[]'::jsonb),
      coalesce(payload->'variants', '[]'::jsonb),
      product_price, product_promotional_price, product_stock,
      case
        when payload ? 'has_stock' then (payload->>'has_stock')::boolean
        else product_has_stock
      end,
      product_brand, coalesce(payload->'images', '[]'::jsonb), image_url,
      case when product_handle is not null then 'https://climactiva.cl/productos/' || product_handle else null end,
      normalized_source_status,
      case when cardinality(missing) > 0 then 'incomplete' else 'synced' end,
      missing,
      nullif(payload->>'updated_at', '')::timestamptz,
      now()
    from normalized
    on conflict (source_provider, external_id) do update set
      payload_hash = excluded.payload_hash,
      sku = excluded.sku,
      name = excluded.name,
      description_html = excluded.description_html,
      description_text = excluded.description_text,
      category = excluded.category,
      categories = excluded.categories,
      variants = excluded.variants,
      price = excluded.price,
      promotional_price = excluded.promotional_price,
      stock = excluded.stock,
      has_stock = excluded.has_stock,
      brand = excluded.brand,
      images = excluded.images,
      primary_image_url = excluded.primary_image_url,
      product_url = excluded.product_url,
      source_status = excluded.source_status,
      sync_status = excluded.sync_status,
      missing_fields = excluded.missing_fields,
      source_updated_at = excluded.source_updated_at,
      last_synced_at = now(),
      updated_at = now()
    where public.content_products.payload_hash is distinct from excluded.payload_hash
       or public.content_products.source_status is distinct from excluded.source_status
    returning sync_status
  )
  select
    (select count(*)::integer from normalized),
    (select count(*)::integer from normalized where cardinality(missing) > 0)
  from (select count(*) from upserted) applied;

  update public.content_products cp
  set source_status = 'deleted',
      updated_at = now(),
      last_synced_at = now()
  where cp.source_provider = 'tiendanube'
    and cp.source_status <> 'deleted'
    and not exists (
      select 1
      from public.integration_records ir
      where ir.provider = 'tiendanube'
        and ir.resource = 'products'
        and ir.external_id = cp.external_id
    );
end
$$;

create or replace function public.claim_content_job(
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns table(job jsonb, lease_token uuid, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.content_jobs%rowtype;
  v_token uuid := gen_random_uuid();
  v_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 120), 900));
begin
  select cj.* into v_job
  from public.content_jobs cj
  where (
      cj.status in ('pending','retry') and cj.next_attempt_at <= now()
    ) or (
      cj.status = 'running' and cj.lease_expires_at < now()
    )
  order by cj.priority desc, cj.created_at
  for update skip locked
  limit 1;

  if not found then return; end if;

  update public.content_jobs cj
  set status = 'running',
      worker_id = trim(p_worker_id),
      lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => v_seconds),
      attempts = cj.attempts + 1,
      started_at = coalesce(cj.started_at, now()),
      updated_at = now()
  where cj.id = v_job.id
  returning to_jsonb(cj.*), cj.lease_token, cj.lease_expires_at
  into job, lease_token, lease_expires_at;

  return next;
end
$$;

create or replace function public.complete_content_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_result jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.content_jobs
  set status = 'completed', result = coalesce(p_result, '{}'::jsonb),
      completed_at = now(), lease_token = null, lease_expires_at = null,
      updated_at = now()
  where id = p_job_id and status = 'running'
    and worker_id = trim(p_worker_id) and lease_token = p_lease_token;
  if not found then raise exception 'content_job_lease_lost'; end if;
end
$$;

create or replace function public.fail_content_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
begin
  select attempts, max_attempts into v_attempts, v_max_attempts
  from public.content_jobs
  where id = p_job_id and status = 'running'
    and worker_id = trim(p_worker_id) and lease_token = p_lease_token
  for update;
  if not found then raise exception 'content_job_lease_lost'; end if;

  update public.content_jobs
  set status = case when p_retryable and v_attempts < v_max_attempts then 'retry' else 'failed' end,
      error_code = left(coalesce(p_error_code, 'content_job_failed'), 120),
      error_message = left(coalesce(p_error_message, 'Error no especificado'), 2000),
      next_attempt_at = case
        when p_retryable and v_attempts < v_max_attempts
          then now() + make_interval(secs => least(3600, 30 * (2 ^ greatest(0, v_attempts - 1))::integer))
        else now()
      end,
      completed_at = case when not p_retryable or v_attempts >= v_max_attempts then now() else null end,
      lease_token = null, lease_expires_at = null, updated_at = now()
  where id = p_job_id;
end
$$;

create or replace function public.enqueue_due_content_publications()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  insert into public.content_jobs(kind, publication_id, payload, priority, idempotency_key, correlation_id)
  select
    'publish', p.id, jsonb_build_object('publication_id', p.id), 90,
    'publish:' || p.id::text, p.correlation_id
  from public.content_publications p
  where p.status = 'scheduled' and p.scheduled_at <= now()
  on conflict (idempotency_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'content_channels','content_products','brand_profiles','content_templates',
    'content_publications','content_schedules','content_automation_rules','content_jobs'
  ] loop
    execute format('drop trigger if exists set_%I_updated_at on public.%I', table_name, table_name);
    execute format(
      'create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      table_name, table_name
    );
  end loop;
end
$$;

alter table public.content_role_permissions enable row level security;
alter table public.content_channels enable row level security;
alter table public.content_products enable row level security;
alter table public.brand_profiles enable row level security;
alter table public.content_templates enable row level security;
alter table public.content_publications enable row level security;
alter table public.content_schedules enable row level security;
alter table public.content_automation_rules enable row level security;
alter table public.content_jobs enable row level security;
alter table public.content_history enable row level security;
alter table public.content_metrics enable row level security;

drop policy if exists content_permissions_admin_read on public.content_role_permissions;
create policy content_permissions_admin_read on public.content_role_permissions
  for select to authenticated using (public.current_role() = 'administrador');

drop policy if exists content_channels_read on public.content_channels;
create policy content_channels_read on public.content_channels
  for select to authenticated using (public.content_has_permission('content.view'));
drop policy if exists content_channels_admin_write on public.content_channels;
create policy content_channels_admin_write on public.content_channels
  for all to authenticated using (public.content_has_permission('content.settings.manage'))
  with check (public.content_has_permission('content.settings.manage'));

drop policy if exists content_products_read on public.content_products;
create policy content_products_read on public.content_products
  for select to authenticated using (public.content_has_permission('content.view'));
drop policy if exists content_products_admin_write on public.content_products;
create policy content_products_admin_write on public.content_products
  for all to authenticated using (public.content_has_permission('content.settings.manage'))
  with check (public.content_has_permission('content.settings.manage'));

drop policy if exists brand_profiles_read on public.brand_profiles;
create policy brand_profiles_read on public.brand_profiles
  for select to authenticated using (public.content_has_permission('content.view'));
drop policy if exists brand_profiles_admin_write on public.brand_profiles;
create policy brand_profiles_admin_write on public.brand_profiles
  for all to authenticated using (public.content_has_permission('content.brand.manage'))
  with check (public.content_has_permission('content.brand.manage'));

drop policy if exists content_templates_read on public.content_templates;
create policy content_templates_read on public.content_templates
  for select to authenticated using (public.content_has_permission('content.view'));
drop policy if exists content_templates_admin_write on public.content_templates;
create policy content_templates_admin_write on public.content_templates
  for all to authenticated using (public.content_has_permission('content.templates.manage'))
  with check (public.content_has_permission('content.templates.manage'));

drop policy if exists content_publications_read on public.content_publications;
create policy content_publications_read on public.content_publications
  for select to authenticated using (public.content_has_permission('content.view'));
drop policy if exists content_publications_create on public.content_publications;
create policy content_publications_create on public.content_publications
  for insert to authenticated with check (
    public.content_has_permission('content.generate')
    and status in ('draft','pending_approval')
  );
drop policy if exists content_publications_edit_drafts on public.content_publications;
create policy content_publications_edit_drafts on public.content_publications
  for update to authenticated using (
    public.content_has_permission('content.edit')
    and status in ('draft','pending_approval','paused')
  ) with check (
    public.content_has_permission('content.edit')
    and status in ('draft','pending_approval','paused')
  );
drop policy if exists content_publications_admin_write on public.content_publications;
create policy content_publications_admin_write on public.content_publications
  for all to authenticated using (public.current_role() = 'administrador')
  with check (public.current_role() = 'administrador');

drop policy if exists content_schedules_read on public.content_schedules;
create policy content_schedules_read on public.content_schedules
  for select to authenticated using (public.content_has_permission('content.view'));
drop policy if exists content_schedules_write on public.content_schedules;
create policy content_schedules_write on public.content_schedules
  for all to authenticated using (
    public.content_has_permission('content.schedule')
    and (operation_mode <> 'autopilot' or public.content_has_permission('content.automation.manage'))
  ) with check (
    public.content_has_permission('content.schedule')
    and (operation_mode <> 'autopilot' or public.content_has_permission('content.automation.manage'))
  );

drop policy if exists content_automation_read on public.content_automation_rules;
create policy content_automation_read on public.content_automation_rules
  for select to authenticated using (public.content_has_permission('content.view'));
drop policy if exists content_automation_admin_write on public.content_automation_rules;
create policy content_automation_admin_write on public.content_automation_rules
  for all to authenticated using (public.content_has_permission('content.automation.manage'))
  with check (public.content_has_permission('content.automation.manage'));

drop policy if exists content_jobs_admin_read on public.content_jobs;
create policy content_jobs_admin_read on public.content_jobs
  for select to authenticated using (public.current_role() = 'administrador');
drop policy if exists content_history_read on public.content_history;
create policy content_history_read on public.content_history
  for select to authenticated using (public.content_has_permission('content.view'));
drop policy if exists content_metrics_read on public.content_metrics;
create policy content_metrics_read on public.content_metrics
  for select to authenticated using (public.content_has_permission('content.metrics.view'));

grant select on public.content_role_permissions, public.content_channels,
  public.content_products, public.brand_profiles, public.content_templates,
  public.content_publications, public.content_schedules, public.content_automation_rules,
  public.content_jobs, public.content_history, public.content_metrics to authenticated;
grant insert, update, delete on public.content_channels, public.content_products,
  public.brand_profiles, public.content_templates, public.content_publications,
  public.content_schedules, public.content_automation_rules to authenticated;
grant all on public.content_role_permissions, public.content_channels,
  public.content_products, public.brand_profiles, public.content_templates,
  public.content_publications, public.content_schedules, public.content_automation_rules,
  public.content_jobs, public.content_history, public.content_metrics to service_role;

revoke all on function public.content_has_permission(text) from public;
revoke all on function public.sync_content_products_from_tiendanube() from public;
revoke all on function public.claim_content_job(text, integer) from public;
revoke all on function public.complete_content_job(uuid, text, uuid, jsonb) from public;
revoke all on function public.fail_content_job(uuid, text, uuid, text, text, boolean) from public;
revoke all on function public.enqueue_due_content_publications() from public;

grant execute on function public.content_has_permission(text) to authenticated, service_role;
grant execute on function public.sync_content_products_from_tiendanube() to service_role;
grant execute on function public.claim_content_job(text, integer) to service_role;
grant execute on function public.complete_content_job(uuid, text, uuid, jsonb) to service_role;
grant execute on function public.fail_content_job(uuid, text, uuid, text, text, boolean) to service_role;
grant execute on function public.enqueue_due_content_publications() to service_role;

comment on table public.content_products is
  'Biblioteca normalizada desde integration_records. Tiendanube sigue siendo la fuente oficial.';
comment on table public.content_jobs is
  'Cola idempotente del Centro de Contenido. Solo workers con service_role pueden reclamarla.';
comment on table public.content_history is
  'Trazabilidad sin secretos para sincronizacion, IA, aprobaciones, publicaciones y reintentos.';
