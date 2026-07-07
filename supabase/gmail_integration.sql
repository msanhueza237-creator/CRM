-- CRM LatinChile - Gmail API integration
-- Ejecutar en Supabase SQL Editor despues del setup principal.
--
-- No guarda secretos en el frontend. El refresh token se guarda cifrado por
-- la Edge Function usando GMAIL_TOKEN_ENCRYPTION_KEY.

create table if not exists public.gmail_integrations (
  id uuid primary key default gen_random_uuid(),
  connected_email text,
  refresh_token_encrypted text,
  status text not null default 'disconnected',
  daily_limit integer not null default 50,
  sent_today integer not null default 0,
  sent_today_date date not null default current_date,
  last_connected_at timestamptz,
  last_health_check_at timestamptz,
  last_error text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_integrations_status_check check (status in ('connected', 'disconnected', 'error')),
  constraint gmail_integrations_daily_limit_check check (daily_limit between 1 and 2000)
);

create table if not exists public.gmail_oauth_states (
  state text primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  redirect_after text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  body_html text,
  body_text text not null,
  status text not null default 'draft',
  segment_filters jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_campaigns_status_check check (status in ('draft', 'ready', 'sending', 'sent', 'paused', 'failed')),
  constraint email_campaigns_name_not_empty check (length(trim(name)) > 0),
  constraint email_campaigns_subject_not_empty check (length(trim(subject)) > 0)
);

create table if not exists public.email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  contact_email text not null,
  status text not null default 'pending',
  sent_at timestamptz,
  error_message text,
  gmail_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_campaign_recipients_status_check check (status in ('pending', 'sent', 'failed', 'skipped')),
  constraint email_campaign_recipients_email_not_empty check (length(trim(contact_email)) > 0)
);

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete set null,
  campaign_id uuid references public.email_campaigns(id) on delete set null,
  to_email text not null,
  subject text not null,
  body_preview text,
  status text not null default 'pending',
  gmail_message_id text,
  sent_at timestamptz,
  error_message text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint email_messages_status_check check (status in ('pending', 'sent', 'failed')),
  constraint email_messages_to_email_not_empty check (length(trim(to_email)) > 0)
);

create index if not exists gmail_integrations_status_idx on public.gmail_integrations(status);
create index if not exists gmail_oauth_states_expires_at_idx on public.gmail_oauth_states(expires_at);
create index if not exists email_campaigns_status_idx on public.email_campaigns(status);
create index if not exists email_campaign_recipients_campaign_id_idx on public.email_campaign_recipients(campaign_id);
create index if not exists email_campaign_recipients_company_id_idx on public.email_campaign_recipients(company_id);
create index if not exists email_messages_company_id_idx on public.email_messages(company_id);
create index if not exists email_messages_campaign_id_idx on public.email_messages(campaign_id);
create index if not exists email_messages_created_at_idx on public.email_messages(created_at desc);

drop trigger if exists set_gmail_integrations_updated_at on public.gmail_integrations;
create trigger set_gmail_integrations_updated_at
before update on public.gmail_integrations
for each row execute function public.set_updated_at();

drop trigger if exists set_email_campaigns_updated_at on public.email_campaigns;
create trigger set_email_campaigns_updated_at
before update on public.email_campaigns
for each row execute function public.set_updated_at();

drop trigger if exists set_email_campaign_recipients_updated_at on public.email_campaign_recipients;
create trigger set_email_campaign_recipients_updated_at
before update on public.email_campaign_recipients
for each row execute function public.set_updated_at();

alter table public.gmail_integrations enable row level security;
alter table public.gmail_oauth_states enable row level security;
alter table public.email_campaigns enable row level security;
alter table public.email_campaign_recipients enable row level security;
alter table public.email_messages enable row level security;

drop policy if exists "admins can read gmail integrations" on public.gmail_integrations;
create policy "admins can read gmail integrations"
on public.gmail_integrations for select to authenticated
using (public.current_role() = 'administrador');

drop policy if exists "admins can manage gmail integrations" on public.gmail_integrations;
create policy "admins can manage gmail integrations"
on public.gmail_integrations for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "admins can manage gmail oauth states" on public.gmail_oauth_states;
create policy "admins can manage gmail oauth states"
on public.gmail_oauth_states for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "authenticated can read email campaigns" on public.email_campaigns;
create policy "authenticated can read email campaigns"
on public.email_campaigns for select to authenticated
using (true);

drop policy if exists "admins can manage email campaigns" on public.email_campaigns;
create policy "admins can manage email campaigns"
on public.email_campaigns for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "authenticated can read email campaign recipients" on public.email_campaign_recipients;
create policy "authenticated can read email campaign recipients"
on public.email_campaign_recipients for select to authenticated
using (true);

drop policy if exists "admins can manage email campaign recipients" on public.email_campaign_recipients;
create policy "admins can manage email campaign recipients"
on public.email_campaign_recipients for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "authenticated can read email messages" on public.email_messages;
create policy "authenticated can read email messages"
on public.email_messages for select to authenticated
using (true);

drop policy if exists "admins can manage email messages" on public.email_messages;
create policy "admins can manage email messages"
on public.email_messages for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');
