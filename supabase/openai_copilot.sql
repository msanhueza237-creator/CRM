-- Clima Activa CRM - Copiloto OpenAI seguro
-- Ejecutar en Supabase SQL Editor despues del setup principal.
--
-- Esta migracion crea almacenamiento y auditoria para un copiloto de texto
-- de solo lectura. No guarda API keys ni razonamiento interno del modelo.

create extension if not exists "pgcrypto";

create table if not exists public.copilot_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'Nueva conversacion',
  channel text not null default 'text' check (channel in ('text', 'voice')),
  status text not null default 'active' check (status in ('active', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.copilot_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.copilot_conversations(id) on delete cascade,
  tenant_id text not null default 'default',
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  redacted boolean not null default false,
  model text,
  prompt_version text,
  tokens_input integer,
  tokens_output integer,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create table if not exists public.copilot_tool_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.copilot_conversations(id) on delete cascade,
  message_id uuid references public.copilot_messages(id) on delete set null,
  tenant_id text not null default 'default',
  user_id uuid not null references public.profiles(id) on delete cascade,
  trace_id text not null,
  tool_name text not null,
  arguments_redacted jsonb not null default '{}'::jsonb,
  ok boolean not null default false,
  human_summary text,
  evidence jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  risk_level text not null default 'read' check (risk_level in ('read', 'low', 'medium', 'high')),
  requires_confirmation boolean not null default false,
  error_code text,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create table if not exists public.copilot_confirmations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid references public.copilot_conversations(id) on delete cascade,
  action_type text not null,
  human_description text not null,
  impact_summary text not null,
  target_count integer not null default 0,
  preview_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'expired', 'used')),
  idempotency_key text,
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.copilot_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'default',
  user_id uuid references public.profiles(id) on delete set null,
  conversation_id uuid references public.copilot_conversations(id) on delete set null,
  request_id text not null,
  trace_id text not null,
  channel text not null default 'text',
  event_type text not null,
  model text,
  prompt_version text,
  tool_name text,
  permission_decision text,
  risk_level text,
  result text,
  affected_count integer,
  latency_ms integer,
  tokens_input integer,
  tokens_output integer,
  error_code text,
  metadata_redacted jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists copilot_conversations_user_idx
on public.copilot_conversations(user_id, updated_at desc);

create index if not exists copilot_messages_conversation_idx
on public.copilot_messages(conversation_id, created_at);

create index if not exists copilot_tool_runs_conversation_idx
on public.copilot_tool_runs(conversation_id, created_at desc);

create index if not exists copilot_audit_events_trace_idx
on public.copilot_audit_events(trace_id, created_at desc);

drop trigger if exists set_copilot_conversations_updated_at on public.copilot_conversations;
create trigger set_copilot_conversations_updated_at
before update on public.copilot_conversations
for each row execute function public.set_updated_at();

alter table public.copilot_conversations enable row level security;
alter table public.copilot_messages enable row level security;
alter table public.copilot_tool_runs enable row level security;
alter table public.copilot_confirmations enable row level security;
alter table public.copilot_audit_events enable row level security;

drop policy if exists "users can read own copilot conversations" on public.copilot_conversations;
create policy "users can read own copilot conversations"
on public.copilot_conversations
for select to authenticated
using (user_id = auth.uid() or public.current_role() = 'administrador');

drop policy if exists "users can read own copilot messages" on public.copilot_messages;
create policy "users can read own copilot messages"
on public.copilot_messages
for select to authenticated
using (user_id = auth.uid() or public.current_role() = 'administrador');

drop policy if exists "admins can read copilot tool runs" on public.copilot_tool_runs;
create policy "admins can read copilot tool runs"
on public.copilot_tool_runs
for select to authenticated
using (user_id = auth.uid() or public.current_role() = 'administrador');

drop policy if exists "users can read own copilot confirmations" on public.copilot_confirmations;
create policy "users can read own copilot confirmations"
on public.copilot_confirmations
for select to authenticated
using (user_id = auth.uid() or public.current_role() = 'administrador');

drop policy if exists "admins can read copilot audit events" on public.copilot_audit_events;
create policy "admins can read copilot audit events"
on public.copilot_audit_events
for select to authenticated
using (public.current_role() = 'administrador');
