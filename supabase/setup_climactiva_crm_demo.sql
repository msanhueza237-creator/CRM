-- Clima Activa CRM - Setup completo Demo
-- Ejecutar en Supabase SQL Editor sobre una base nueva o vacia.
--
-- IMPORTANTE:
-- - Este script crea tablas, tipos, indices, triggers, RLS, politicas y datos de ejemplo.
-- - No crea usuarios reales de Supabase Auth.
-- - Para usar la app con login real, crea un usuario desde Auth y luego inserta su profile.
-- - Si ya tienes tablas creadas y quieres reiniciar desde cero, usa con cuidado:
--
-- drop schema public cascade;
-- create schema public;
-- grant usage on schema public to postgres, anon, authenticated, service_role;
-- grant all on schema public to postgres, service_role;
-- alter default privileges in schema public grant all on tables to postgres, service_role;
-- alter default privileges in schema public grant all on functions to postgres, service_role;
-- alter default privileges in schema public grant all on sequences to postgres, service_role;

create extension if not exists "pgcrypto";

create type public.app_role as enum ('administrador', 'vendedor', 'visualizador');
create type public.company_type as enum ('distribuidor', 'tienda comercial', 'tecnico', 'instalador grande', 'competencia', 'otro');
create type public.company_status as enum ('prospecto', 'contactado', 'interesado', 'cotizado', 'cliente', 'descartado');
create type public.priority_level as enum ('alta', 'media', 'baja');
create type public.interaction_type as enum ('llamada', 'correo', 'whatsapp', 'reunion', 'cotizacion', 'nota');
create type public.campaign_type as enum ('email', 'whatsapp', 'mixta');
create type public.campaign_status as enum ('borrador', 'programada', 'enviada', 'pausada', 'finalizada');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role public.app_role not null default 'vendedor',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  description text,
  rut text,
  business_line text,
  type public.company_type not null default 'otro',
  city text,
  region text,
  address text,
  website text,
  instagram text,
  facebook text,
  whatsapp text,
  phone text,
  email text,
  contact_name text,
  contact_role text,
  priority public.priority_level not null default 'media',
  source text,
  notes text,
  status public.company_status not null default 'prospecto',
  next_follow_up date,
  owner_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  full_name text not null,
  role text,
  email text,
  phone text,
  whatsapp text,
  is_primary boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.interactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  type public.interaction_type not null,
  owner_id uuid references public.profiles(id) on delete set null,
  description text not null,
  result text,
  next_action text,
  related_url text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type public.campaign_type not null,
  segment text,
  message text,
  status public.campaign_status not null default 'borrador',
  product text,
  coupon text,
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  created_by uuid references public.profiles(id) on delete set null,
  send_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  rendered_message text,
  sent_at timestamptz,
  replied_at timestamptz,
  interested boolean not null default false,
  discarded boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index campaign_recipients_unique_company
on public.campaign_recipients (campaign_id, company_id)
where contact_id is null;

create unique index campaign_recipients_unique_contact
on public.campaign_recipients (campaign_id, company_id, contact_id)
where contact_id is not null;

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  body text not null,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text,
  created_at timestamptz not null default now()
);

create table public.company_tags (
  company_id uuid not null references public.companies(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (company_id, tag_id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  owner_id uuid references public.profiles(id) on delete set null,
  title text not null,
  description text,
  due_date date,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index companies_type_idx on public.companies(type);
create index companies_status_idx on public.companies(status);
create index companies_priority_idx on public.companies(priority);
create index companies_city_idx on public.companies(city);
create index companies_next_follow_up_idx on public.companies(next_follow_up);
create index contacts_company_id_idx on public.contacts(company_id);
create index interactions_company_id_idx on public.interactions(company_id);
create index interactions_occurred_at_idx on public.interactions(occurred_at desc);
create index campaign_recipients_campaign_id_idx on public.campaign_recipients(campaign_id);
create index tasks_due_date_idx on public.tasks(due_date);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger set_companies_updated_at before update on public.companies for each row execute function public.set_updated_at();
create trigger set_contacts_updated_at before update on public.contacts for each row execute function public.set_updated_at();
create trigger set_interactions_updated_at before update on public.interactions for each row execute function public.set_updated_at();
create trigger set_campaigns_updated_at before update on public.campaigns for each row execute function public.set_updated_at();
create trigger set_message_templates_updated_at before update on public.message_templates for each row execute function public.set_updated_at();
create trigger set_tasks_updated_at before update on public.tasks for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.contacts enable row level security;
alter table public.interactions enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.message_templates enable row level security;
alter table public.tags enable row level security;
alter table public.company_tags enable row level security;
alter table public.tasks enable row level security;
alter table public.activity_logs enable row level security;

create or replace function public.current_role()
returns public.app_role
language sql
security definer
set search_path = public
stable
as $$
  select role from public.profiles where id = auth.uid()
$$;

create policy "authenticated can read companies" on public.companies for select to authenticated using (true);
create policy "sales can insert companies" on public.companies for insert to authenticated with check (public.current_role() in ('administrador', 'vendedor'));
create policy "sales can update companies" on public.companies for update to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));
create policy "admin can delete companies" on public.companies for delete to authenticated using (public.current_role() = 'administrador');

create policy "authenticated can read contacts" on public.contacts for select to authenticated using (true);
create policy "sales can insert contacts" on public.contacts for insert to authenticated with check (public.current_role() in ('administrador', 'vendedor'));
create policy "sales can update contacts" on public.contacts for update to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));
create policy "admin can delete contacts" on public.contacts for delete to authenticated using (public.current_role() = 'administrador');

create policy "authenticated can read interactions" on public.interactions for select to authenticated using (true);
create policy "sales can insert interactions" on public.interactions for insert to authenticated with check (public.current_role() in ('administrador', 'vendedor'));
create policy "sales can update interactions" on public.interactions for update to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));
create policy "admin can delete interactions" on public.interactions for delete to authenticated using (public.current_role() = 'administrador');

create policy "authenticated can read campaigns" on public.campaigns for select to authenticated using (true);
create policy "admin can insert campaigns" on public.campaigns for insert to authenticated with check (public.current_role() = 'administrador');
create policy "admin can update campaigns" on public.campaigns for update to authenticated using (public.current_role() = 'administrador') with check (public.current_role() = 'administrador');
create policy "admin can delete campaigns" on public.campaigns for delete to authenticated using (public.current_role() = 'administrador');

create policy "authenticated can read campaign recipients" on public.campaign_recipients for select to authenticated using (true);
create policy "admin can insert campaign recipients" on public.campaign_recipients for insert to authenticated with check (public.current_role() = 'administrador');
create policy "admin can update campaign recipients" on public.campaign_recipients for update to authenticated using (public.current_role() = 'administrador') with check (public.current_role() = 'administrador');
create policy "admin can delete campaign recipients" on public.campaign_recipients for delete to authenticated using (public.current_role() = 'administrador');

create policy "authenticated can read templates" on public.message_templates for select to authenticated using (true);
create policy "admin can insert templates" on public.message_templates for insert to authenticated with check (public.current_role() = 'administrador');
create policy "admin can update templates" on public.message_templates for update to authenticated using (public.current_role() = 'administrador') with check (public.current_role() = 'administrador');
create policy "admin can delete templates" on public.message_templates for delete to authenticated using (public.current_role() = 'administrador');

create policy "authenticated can read tags" on public.tags for select to authenticated using (true);
create policy "sales can insert tags" on public.tags for insert to authenticated with check (public.current_role() in ('administrador', 'vendedor'));
create policy "sales can update tags" on public.tags for update to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));
create policy "admin can delete tags" on public.tags for delete to authenticated using (public.current_role() = 'administrador');

create policy "authenticated can read company tags" on public.company_tags for select to authenticated using (true);
create policy "sales can insert company tags" on public.company_tags for insert to authenticated with check (public.current_role() in ('administrador', 'vendedor'));
create policy "sales can delete company tags" on public.company_tags for delete to authenticated using (public.current_role() in ('administrador', 'vendedor'));

create policy "authenticated can read tasks" on public.tasks for select to authenticated using (true);
create policy "sales can insert tasks" on public.tasks for insert to authenticated with check (public.current_role() in ('administrador', 'vendedor'));
create policy "sales can update tasks" on public.tasks for update to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));
create policy "admin can delete tasks" on public.tasks for delete to authenticated using (public.current_role() = 'administrador');

create policy "users can read own profile or admins read all" on public.profiles for select to authenticated using (id = auth.uid() or public.current_role() = 'administrador');
create policy "admin can insert profiles" on public.profiles for insert to authenticated with check (public.current_role() = 'administrador');
create policy "admin can update profiles" on public.profiles for update to authenticated using (public.current_role() = 'administrador') with check (public.current_role() = 'administrador');
create policy "admin can delete profiles" on public.profiles for delete to authenticated using (public.current_role() = 'administrador');

create policy "admins can read activity logs" on public.activity_logs for select to authenticated using (public.current_role() = 'administrador');
create policy "authenticated can insert activity logs" on public.activity_logs for insert to authenticated with check (auth.uid() is not null);

-- Datos de ejemplo

insert into public.tags (id, name, color) values
  ('10000000-0000-0000-0000-000000000001', 'Mayorista', '#0b7285'),
  ('10000000-0000-0000-0000-000000000002', 'Santiago', '#2563eb'),
  ('10000000-0000-0000-0000-000000000003', 'Herramientas', '#16a34a'),
  ('10000000-0000-0000-0000-000000000004', 'Instaladores', '#9333ea'),
  ('10000000-0000-0000-0000-000000000005', 'Sur', '#0891b2'),
  ('10000000-0000-0000-0000-000000000006', 'Tienda', '#f59e0b'),
  ('10000000-0000-0000-0000-000000000007', 'Costa', '#0284c7'),
  ('10000000-0000-0000-0000-000000000008', 'Competencia', '#dc2626');

insert into public.companies (
  id, name, legal_name, description, rut, business_line, type, city, region, address,
  website, instagram, facebook, whatsapp, phone, email, contact_name, contact_role,
  priority, source, notes, status, next_follow_up
) values
  (
    '20000000-0000-0000-0000-000000000001',
    'FrioMarket Santiago',
    'FrioMarket Comercial SpA',
    'Distribuidor mayorista enfocado en insumos, repuestos y herramientas para empresas del rubro HVAC/R.',
    '76.555.120-8',
    'Venta mayorista de insumos de refrigeracion',
    'distribuidor',
    'Santiago',
    'Metropolitana',
    'Av. Matta 1020',
    'https://example.com',
    '@friomarket',
    'FrioMarket',
    '+56911112222',
    '+56225550120',
    'compras@friomarket.example',
    'Carolina Fuentes',
    'Jefa de compras',
    'alta',
    'Prospeccion web',
    'Cliente potencial para bombas de condensado, manifold y herramientas.',
    'interesado',
    '2026-07-08'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    'TecnoClima Sur',
    'Servicios TecnoClima Sur Ltda.',
    'Empresa tecnica con cuadrillas de instalacion y mantencion para clientes comerciales e industriales.',
    '77.210.990-1',
    'Instalacion y mantencion de aire acondicionado',
    'instalador grande',
    'Concepcion',
    'Biobio',
    'Los Carrera 450',
    null,
    '@tecnoclimasur',
    null,
    '+56933334444',
    '+56412222000',
    'operaciones@tecnoclimasur.example',
    'Mauricio Rivas',
    'Gerente tecnico',
    'media',
    'Referido',
    'Interesados en precios por volumen para instaladores.',
    'cotizado',
    '2026-07-10'
  ),
  (
    '20000000-0000-0000-0000-000000000003',
    'Refrigera Express',
    'Refrigera Express Chile SpA',
    'Tienda comercial de refrigeracion y aire acondicionado que atiende a publico instalador en la zona costa.',
    '76.901.300-K',
    'Tienda comercial de refrigeracion',
    'tienda comercial',
    'Valparaiso',
    'Valparaiso',
    'Pedro Montt 880',
    'https://example.org',
    null,
    'Refrigera Express',
    '+56955556666',
    '+56322222111',
    'ventas@refrigeraexpress.example',
    'Paula Morales',
    'Administradora',
    'alta',
    'Instagram',
    'Buen encaje para campana inicial de distribuidores y tiendas.',
    'contactado',
    '2026-07-06'
  ),
  (
    '20000000-0000-0000-0000-000000000004',
    'ClimaPro Competencia',
    'ClimaPro Comercial Ltda.',
    'Empresa competidora detectada para seguimiento de mercado, precios y cobertura regional.',
    '77.880.110-2',
    'Comercializacion de equipos e insumos HVAC',
    'competencia',
    'Santiago',
    'Metropolitana',
    'Av. Comercial 2200',
    'https://competencia.example',
    '@climapro',
    'ClimaPro',
    '+56977778888',
    '+56224440000',
    'contacto@climapro.example',
    'Equipo comercial',
    'Ventas',
    'baja',
    'Analisis competencia',
    'Usar solo para observacion comercial, no para campanas.',
    'prospecto',
    null
  );

insert into public.contacts (
  id, company_id, full_name, role, email, phone, whatsapp, is_primary, notes
) values
  (
    '30000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'Carolina Fuentes',
    'Jefa de compras',
    'compras@friomarket.example',
    '+56225550120',
    '+56911112222',
    true,
    'Contacto principal para listas mayoristas.'
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000002',
    'Mauricio Rivas',
    'Gerente tecnico',
    'operaciones@tecnoclimasur.example',
    '+56412222000',
    '+56933334444',
    true,
    'Interesado en herramientas para cuadrillas.'
  ),
  (
    '30000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000003',
    'Paula Morales',
    'Administradora',
    'ventas@refrigeraexpress.example',
    '+56322222111',
    '+56955556666',
    true,
    'Contacto de tienda comercial.'
  );

insert into public.company_tags (company_id, tag_id) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000004'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000005'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000006'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000007'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000008');

insert into public.interactions (
  id, company_id, contact_id, type, description, result, next_action, occurred_at
) values
  (
    '40000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'whatsapp',
    'Primer contacto con presentacion comercial y catalogo resumido.',
    'Solicita lista de precios distribuidor.',
    'Enviar cotizacion por volumen.',
    '2026-07-01 10:00:00-04'
  ),
  (
    '40000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000002',
    'cotizacion',
    'Cotizacion de kit de herramientas para cuadrillas.',
    'Pendiente de revision interna.',
    'Llamar despues del cierre semanal.',
    '2026-06-29 15:00:00-04'
  ),
  (
    '40000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000003',
    '30000000-0000-0000-0000-000000000003',
    'llamada',
    'Validacion de productos que venden actualmente.',
    'Interes inicial en bombas de condensado y capacitores.',
    'Enviar oferta para tiendas comerciales.',
    '2026-07-02 11:30:00-04'
  );

insert into public.message_templates (
  id, name, category, body, active
) values
  (
    '50000000-0000-0000-0000-000000000001',
    'Presentacion comercial Clima Activa',
    'Presentacion',
    'Hola {{nombre_contacto}}, soy de Clima Activa. Trabajamos insumos y herramientas para climatizacion y refrigeracion. Queremos evaluar condiciones comerciales para {{nombre_empresa}} en {{ciudad}}.',
    true
  ),
  (
    '50000000-0000-0000-0000-000000000002',
    'Oferta para distribuidores',
    'Distribuidores',
    'Hola {{nombre_contacto}}, tenemos condiciones para distribuidores en {{producto_destacado}}. Podemos preparar una propuesta para {{nombre_empresa}} con precios por volumen. Cupon de referencia: {{cupon}}.',
    true
  ),
  (
    '50000000-0000-0000-0000-000000000003',
    'Oferta para tiendas comerciales',
    'Tiendas',
    'Hola {{nombre_contacto}}, vimos que {{nombre_empresa}} atiende a publico instalador en {{ciudad}}. En Clima Activa podemos apoyar con {{producto_destacado}} y reposicion para tienda.',
    true
  ),
  (
    '50000000-0000-0000-0000-000000000004',
    'Oferta para tecnicos instaladores',
    'Instaladores',
    'Hola {{nombre_contacto}}, tenemos alternativas para {{tipo_empresa}} que buscan herramientas e insumos confiables. Podemos preparar una propuesta para {{nombre_empresa}}.',
    true
  ),
  (
    '50000000-0000-0000-0000-000000000005',
    'Seguimiento primer contacto',
    'Seguimiento',
    'Hola {{nombre_contacto}}, te escribo para dar seguimiento a la informacion enviada a {{nombre_empresa}}. Quedo atento para coordinar la siguiente accion.',
    true
  ),
  (
    '50000000-0000-0000-0000-000000000006',
    'Recuperacion cliente inactivo',
    'Reactivacion',
    'Hola {{nombre_contacto}}, queremos retomar contacto con {{nombre_empresa}} y compartir nuevas condiciones comerciales de Clima Activa para {{ciudad}}.',
    true
  );

insert into public.campaigns (
  id, name, type, segment, message, status, product, coupon, send_at, confirmed_at
) values
  (
    '60000000-0000-0000-0000-000000000001',
    'Distribuidores climatizacion julio',
    'mixta',
    'Distribuidores y tiendas comerciales prioridad alta',
    'Campana inicial orientada a distribuidores y tiendas comerciales.',
    'borrador',
    'bombas de condensado y herramientas Super Stars',
    'CLIMA10',
    '2026-07-05 09:00:00-04',
    null
  ),
  (
    '60000000-0000-0000-0000-000000000002',
    'Seguimiento instaladores grandes',
    'whatsapp',
    'Instaladores grandes zona centro-sur',
    'Seguimiento para empresas tecnicas e instaladores grandes.',
    'programada',
    'kits de herramientas para cuadrillas',
    'INSTALA10',
    '2026-07-09 09:00:00-04',
    '2026-07-03 12:00:00-04'
  );

insert into public.campaign_recipients (
  campaign_id, company_id, contact_id, rendered_message, sent_at, replied_at, interested, discarded
) values
  (
    '60000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'Hola Carolina Fuentes, tenemos condiciones para distribuidores en bombas de condensado y herramientas Super Stars. Podemos preparar una propuesta para FrioMarket Santiago con precios por volumen. Cupon de referencia: CLIMA10.',
    null,
    null,
    false,
    false
  ),
  (
    '60000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000003',
    '30000000-0000-0000-0000-000000000003',
    'Hola Paula Morales, vimos que Refrigera Express atiende a publico instalador en Valparaiso. En Clima Activa podemos apoyar con bombas de condensado y herramientas Super Stars y reposicion para tienda.',
    null,
    null,
    false,
    false
  ),
  (
    '60000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000002',
    'Hola Mauricio Rivas, tenemos alternativas para instalador grande que buscan herramientas e insumos confiables. Podemos preparar una propuesta para TecnoClima Sur.',
    '2026-07-03 13:00:00-04',
    null,
    false,
    false
  );

insert into public.tasks (
  id, company_id, title, description, due_date
) values
  (
    '70000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000003',
    'Enviar oferta tienda comercial',
    'Enviar propuesta orientada a reposicion para tienda comercial.',
    '2026-07-06'
  ),
  (
    '70000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001',
    'Preparar lista mayorista',
    'Preparar lista de precios por volumen para distribuidor.',
    '2026-07-08'
  ),
  (
    '70000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000002',
    'Seguimiento cotizacion kit',
    'Llamar para revisar cotizacion de kit de herramientas.',
    '2026-07-10'
  );

insert into public.activity_logs (
  entity_type, entity_id, action, metadata
) values
  (
    'company',
    '20000000-0000-0000-0000-000000000003',
    'status_changed',
    '{"message":"Refrigera Express marcada como contactado."}'::jsonb
  ),
  (
    'interaction',
    '40000000-0000-0000-0000-000000000001',
    'interaction_created',
    '{"message":"FrioMarket Santiago solicito lista de precios."}'::jsonb
  ),
  (
    'campaign',
    '60000000-0000-0000-0000-000000000002',
    'campaign_created',
    '{"message":"Campana Seguimiento instaladores grandes creada."}'::jsonb
  );

-- Luego de crear un usuario real en Supabase Auth, puedes darle perfil asi:
--
-- insert into public.profiles (id, full_name, role)
-- values ('PEGAR_UUID_DEL_USUARIO_AUTH', 'Administrador Clima Activa', 'administrador');
