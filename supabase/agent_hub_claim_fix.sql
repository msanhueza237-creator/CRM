-- Corrige la ambiguedad entre la columna lease_expires_at y el parametro
-- de salida homonimo de la funcion. Es seguro ejecutar este archivo varias veces.
create or replace function public.claim_business_agent_task(
  p_worker_id text, p_lease_seconds integer default 120
) returns table(task jsonb, lease_token uuid, lease_expires_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_task public.business_agent_tasks%rowtype;
  v_token uuid := gen_random_uuid();
begin
  select bat.* into v_task
  from public.business_agent_tasks as bat
  where bat.status = 'pending'
     or (bat.status = 'in_progress' and bat.lease_expires_at < now())
  order by bat.priority desc, bat.created_at
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.business_agent_tasks as bat
  set status = 'in_progress',
      worker_id = p_worker_id,
      lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => greatest(30, p_lease_seconds)),
      attempts = bat.attempts + 1,
      started_at = coalesce(bat.started_at, now()),
      updated_at = now()
  where bat.id = v_task.id
  returning to_jsonb(bat.*), bat.lease_token, bat.lease_expires_at
  into task, lease_token, lease_expires_at;

  return next;
end
$$;

revoke all on function public.claim_business_agent_task(text,integer) from public;
grant execute on function public.claim_business_agent_task(text,integer) to service_role;
