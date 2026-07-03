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
  created_at timestamptz not null default now(),
  unique (campaign_id, company_id, contact_id)
);

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

create policy "authenticated can read crm" on public.companies for select to authenticated using (true);
create policy "sales can write companies" on public.companies for all to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));

create policy "authenticated can read contacts" on public.contacts for select to authenticated using (true);
create policy "sales can write contacts" on public.contacts for all to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));

create policy "authenticated can read interactions" on public.interactions for select to authenticated using (true);
create policy "sales can write interactions" on public.interactions for all to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));

create policy "authenticated can read campaigns" on public.campaigns for select to authenticated using (true);
create policy "admin can write campaigns" on public.campaigns for all to authenticated using (public.current_role() = 'administrador') with check (public.current_role() = 'administrador');

create policy "authenticated can read campaign recipients" on public.campaign_recipients for select to authenticated using (true);
create policy "admin can write campaign recipients" on public.campaign_recipients for all to authenticated using (public.current_role() = 'administrador') with check (public.current_role() = 'administrador');

create policy "authenticated can read templates" on public.message_templates for select to authenticated using (true);
create policy "admin can write templates" on public.message_templates for all to authenticated using (public.current_role() = 'administrador') with check (public.current_role() = 'administrador');

create policy "authenticated can read tags" on public.tags for select to authenticated using (true);
create policy "sales can write tags" on public.tags for all to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));

create policy "authenticated can read company tags" on public.company_tags for select to authenticated using (true);
create policy "sales can write company tags" on public.company_tags for all to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));

create policy "authenticated can read tasks" on public.tasks for select to authenticated using (true);
create policy "sales can write tasks" on public.tasks for all to authenticated using (public.current_role() in ('administrador', 'vendedor')) with check (public.current_role() in ('administrador', 'vendedor'));

create policy "users can read own profile" on public.profiles for select to authenticated using (id = auth.uid() or public.current_role() = 'administrador');
create policy "admin can manage profiles" on public.profiles for all to authenticated using (public.current_role() = 'administrador') with check (public.current_role() = 'administrador');

create policy "admins can read activity logs" on public.activity_logs for select to authenticated using (public.current_role() = 'administrador');
create policy "system users can insert activity logs" on public.activity_logs for insert to authenticated with check (true);
