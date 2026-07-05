-- Clima Activa CRM - API keys para agentes externos
-- Ejecutar en Supabase SQL Editor despues del setup principal.
--
-- La llave secreta se muestra solo una vez al crearla. La base guarda
-- solamente el hash SHA-256, mas un prefijo visible para identificarla.

create extension if not exists "pgcrypto";

create table if not exists public.agent_api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_prefix text not null unique,
  key_hash text not null unique,
  scopes text[] not null default array['crm:read'],
  active boolean not null default true,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint agent_api_keys_name_not_empty check (length(trim(name)) > 0),
  constraint agent_api_keys_scopes_not_empty check (array_length(scopes, 1) is not null)
);

create index if not exists agent_api_keys_active_idx
on public.agent_api_keys(active)
where active = true;

create index if not exists agent_api_keys_expires_at_idx
on public.agent_api_keys(expires_at);

drop trigger if exists set_agent_api_keys_updated_at on public.agent_api_keys;
create trigger set_agent_api_keys_updated_at
before update on public.agent_api_keys
for each row execute function public.set_updated_at();

alter table public.agent_api_keys enable row level security;

drop policy if exists "admins can read agent api keys" on public.agent_api_keys;
create policy "admins can read agent api keys"
on public.agent_api_keys
for select to authenticated
using (public.current_role() = 'administrador');

drop policy if exists "admins can update agent api keys" on public.agent_api_keys;
create policy "admins can update agent api keys"
on public.agent_api_keys
for update to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "admins can delete agent api keys" on public.agent_api_keys;
create policy "admins can delete agent api keys"
on public.agent_api_keys
for delete to authenticated
using (public.current_role() = 'administrador');

create or replace function public.create_agent_api_key(
  p_name text,
  p_scopes text[] default array['crm:read'],
  p_expires_at timestamptz default null
)
returns table (
  id uuid,
  name text,
  api_key text,
  key_prefix text,
  scopes text[],
  expires_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret text;
  v_hash text;
begin
  if coalesce(public.current_role()::text, '') <> 'administrador'
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Solo administradores pueden crear llaves API';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'El nombre de la llave API es obligatorio';
  end if;

  if p_scopes is null or array_length(p_scopes, 1) is null then
    raise exception 'Debes indicar al menos un permiso';
  end if;

  v_secret := 'ca_live_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_secret, 'sha256'), 'hex');

  insert into public.agent_api_keys (
    name,
    key_prefix,
    key_hash,
    scopes,
    expires_at,
    created_by
  )
  values (
    trim(p_name),
    left(v_secret, 16),
    v_hash,
    p_scopes,
    p_expires_at,
    auth.uid()
  )
  returning
    agent_api_keys.id,
    agent_api_keys.name,
    v_secret,
    agent_api_keys.key_prefix,
    agent_api_keys.scopes,
    agent_api_keys.expires_at,
    agent_api_keys.created_at
  into
    id,
    name,
    api_key,
    key_prefix,
    scopes,
    expires_at,
    created_at;

  return next;
end;
$$;

create or replace function public.validate_agent_api_key(
  p_api_key text,
  p_required_scope text default null
)
returns table (
  valid boolean,
  key_id uuid,
  key_name text,
  scopes text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text;
begin
  if p_api_key is null or length(trim(p_api_key)) = 0 then
    return query select false, null::uuid, null::text, null::text[];
    return;
  end if;

  v_hash := encode(extensions.digest(trim(p_api_key), 'sha256'), 'hex');

  update public.agent_api_keys k
  set last_used_at = now()
  where k.key_hash = v_hash
    and k.active = true
    and k.revoked_at is null
    and (k.expires_at is null or k.expires_at > now())
    and (p_required_scope is null or p_required_scope = any(k.scopes))
  returning true, k.id, k.name, k.scopes
  into valid, key_id, key_name, scopes;

  if valid is null then
    return query select false, null::uuid, null::text, null::text[];
  else
    return next;
  end if;
end;
$$;

create or replace function public.revoke_agent_api_key(p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.current_role()::text, '') <> 'administrador'
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Solo administradores pueden revocar llaves API';
  end if;

  update public.agent_api_keys
  set active = false,
      revoked_at = now()
  where id = p_key_id;
end;
$$;

revoke all on function public.create_agent_api_key(text, text[], timestamptz) from public;
revoke all on function public.revoke_agent_api_key(uuid) from public;
grant execute on function public.create_agent_api_key(text, text[], timestamptz) to authenticated;
grant execute on function public.revoke_agent_api_key(uuid) to authenticated;
grant execute on function public.validate_agent_api_key(text, text) to anon, authenticated, service_role;
