-- Credentials only: no prospecting runs, candidates or accounting data are changed.
-- Encryption/decryption belongs to the server, never to browser roles.
create table if not exists public.prospecting_ai_integrations (
  provider text primary key check (provider = 'deepseek'),
  api_key_encrypted text,
  status text not null default 'disconnected' check (status in ('verified','error','disconnected')),
  models jsonb not null default '[]'::jsonb check (jsonb_typeof(models) = 'array'),
  last_checked_at timestamptz,
  last_error_code text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.prospecting_ai_integrations enable row level security;
revoke all on public.prospecting_ai_integrations from public, anon, authenticated;
grant select, insert, update on public.prospecting_ai_integrations to service_role;
comment on table public.prospecting_ai_integrations is
  'Server-only encrypted provider credentials. Never exposed through browser REST or prospecting snapshots.';
