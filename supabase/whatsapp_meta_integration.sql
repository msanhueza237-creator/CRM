-- Clima Activa CRM - Integracion segura WhatsApp Meta Cloud API
-- Ejecutar en Supabase SQL Editor despues de setup_climactiva_crm_demo.sql
-- y agent_api_keys.sql.

alter table public.companies
  add column if not exists whatsapp_number text,
  add column if not exists whatsapp_opt_in boolean not null default false,
  add column if not exists last_whatsapp_message_at timestamptz,
  add column if not exists whatsapp_status text not null default 'sin_consentimiento';

alter table public.companies
  drop constraint if exists companies_whatsapp_status_check;

alter table public.companies
  add constraint companies_whatsapp_status_check
  check (whatsapp_status in ('sin_consentimiento', 'opt_in', 'bloqueado', 'invalido'));

create table if not exists public.whatsapp_settings (
  id uuid primary key default gen_random_uuid(),
  phone_number_id text not null,
  business_account_id text not null,
  official_phone_number text,
  webhook_verify_token_hash text,
  access_token_hint text,
  active boolean not null default false,
  last_connection_status text,
  last_connection_checked_at timestamptz,
  last_error text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  internal_name text not null,
  meta_template_name text not null,
  language text not null default 'es',
  category text,
  variables text[] not null default '{}',
  status text not null default 'draft',
  preview_body text not null,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.whatsapp_campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns(id) on delete set null,
  name text not null,
  template_id uuid references public.whatsapp_templates(id) on delete restrict,
  status text not null default 'draft',
  segment jsonb not null default '{}'::jsonb,
  variable_values jsonb not null default '{}'::jsonb,
  allow_without_opt_in boolean not null default false,
  admin_override_reason text,
  created_by uuid references public.profiles(id) on delete set null,
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.whatsapp_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  whatsapp_campaign_id uuid not null references public.whatsapp_campaigns(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  phone_number text not null,
  opt_in_at_send boolean not null default false,
  rendered_variables jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  meta_message_id text,
  error_message text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (whatsapp_campaign_id, company_id, contact_id)
);

create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  whatsapp_campaign_id uuid references public.whatsapp_campaigns(id) on delete set null,
  recipient_id uuid references public.whatsapp_campaign_recipients(id) on delete set null,
  direction text not null,
  phone_number text not null,
  meta_message_id text,
  message_type text not null default 'text',
  template_name text,
  body text,
  status text not null default 'received',
  raw_payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.whatsapp_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  meta_message_id text,
  phone_number text,
  company_id uuid references public.companies(id) on delete set null,
  payload jsonb not null,
  processed boolean not null default false,
  processing_error text,
  received_at timestamptz not null default now()
);

create index if not exists companies_whatsapp_opt_in_idx on public.companies(whatsapp_opt_in);
create index if not exists companies_whatsapp_number_idx on public.companies(whatsapp_number);
create index if not exists whatsapp_campaign_recipients_campaign_idx on public.whatsapp_campaign_recipients(whatsapp_campaign_id);
create index if not exists whatsapp_campaign_recipients_message_idx on public.whatsapp_campaign_recipients(meta_message_id);
create index if not exists whatsapp_messages_company_idx on public.whatsapp_messages(company_id);
create index if not exists whatsapp_messages_meta_message_idx on public.whatsapp_messages(meta_message_id);
create index if not exists whatsapp_webhook_events_meta_message_idx on public.whatsapp_webhook_events(meta_message_id);

drop trigger if exists set_whatsapp_settings_updated_at on public.whatsapp_settings;
create trigger set_whatsapp_settings_updated_at
before update on public.whatsapp_settings
for each row execute function public.set_updated_at();

drop trigger if exists set_whatsapp_templates_updated_at on public.whatsapp_templates;
create trigger set_whatsapp_templates_updated_at
before update on public.whatsapp_templates
for each row execute function public.set_updated_at();

drop trigger if exists set_whatsapp_campaigns_updated_at on public.whatsapp_campaigns;
create trigger set_whatsapp_campaigns_updated_at
before update on public.whatsapp_campaigns
for each row execute function public.set_updated_at();

drop trigger if exists set_whatsapp_campaign_recipients_updated_at on public.whatsapp_campaign_recipients;
create trigger set_whatsapp_campaign_recipients_updated_at
before update on public.whatsapp_campaign_recipients
for each row execute function public.set_updated_at();

alter table public.whatsapp_settings enable row level security;
alter table public.whatsapp_templates enable row level security;
alter table public.whatsapp_campaigns enable row level security;
alter table public.whatsapp_campaign_recipients enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_webhook_events enable row level security;

drop policy if exists "admins can manage whatsapp settings" on public.whatsapp_settings;
create policy "admins can manage whatsapp settings"
on public.whatsapp_settings
for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "authenticated can read whatsapp templates" on public.whatsapp_templates;
create policy "authenticated can read whatsapp templates"
on public.whatsapp_templates
for select to authenticated
using (true);

drop policy if exists "admins can manage whatsapp templates" on public.whatsapp_templates;
create policy "admins can manage whatsapp templates"
on public.whatsapp_templates
for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "authenticated can read whatsapp campaigns" on public.whatsapp_campaigns;
create policy "authenticated can read whatsapp campaigns"
on public.whatsapp_campaigns
for select to authenticated
using (true);

drop policy if exists "admins can manage whatsapp campaigns" on public.whatsapp_campaigns;
create policy "admins can manage whatsapp campaigns"
on public.whatsapp_campaigns
for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "authenticated can read whatsapp recipients" on public.whatsapp_campaign_recipients;
create policy "authenticated can read whatsapp recipients"
on public.whatsapp_campaign_recipients
for select to authenticated
using (true);

drop policy if exists "admins can manage whatsapp recipients" on public.whatsapp_campaign_recipients;
create policy "admins can manage whatsapp recipients"
on public.whatsapp_campaign_recipients
for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "authenticated can read whatsapp messages" on public.whatsapp_messages;
create policy "authenticated can read whatsapp messages"
on public.whatsapp_messages
for select to authenticated
using (true);

drop policy if exists "admins can manage whatsapp messages" on public.whatsapp_messages;
create policy "admins can manage whatsapp messages"
on public.whatsapp_messages
for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "admins can read whatsapp webhook events" on public.whatsapp_webhook_events;
create policy "admins can read whatsapp webhook events"
on public.whatsapp_webhook_events
for select to authenticated
using (public.current_role() = 'administrador');

-- Las Edge Functions usan service_role para insertar eventos y mensajes entrantes.
