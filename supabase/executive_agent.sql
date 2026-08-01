-- Agente Gerente: agenda, canal de entrega y auditoria de notificaciones.
-- Seguro para ejecutar varias veces despues de supabase/agent_hub.sql.

create table if not exists public.executive_agent_settings (
  id text primary key default 'default',
  timezone text not null default 'America/Santiago',
  email_enabled boolean not null default true,
  email_to text not null default 'msanhueza237@gmail.com',
  whatsapp_enabled boolean not null default false,
  whatsapp_to text,
  morning_time time not null default '08:30',
  review_interval_hours integer not null default 3 check (review_interval_hours between 1 and 12),
  cutoff_time time not null default '20:00',
  only_relevant_after_morning boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.executive_agent_settings (
  id, timezone, email_enabled, email_to, whatsapp_enabled,
  morning_time, review_interval_hours, cutoff_time, only_relevant_after_morning
) values (
  'default', 'America/Santiago', true, 'msanhueza237@gmail.com', false,
  '08:30', 3, '20:00', true
) on conflict (id) do update set
  timezone = excluded.timezone,
  email_enabled = excluded.email_enabled,
  email_to = excluded.email_to,
  morning_time = excluded.morning_time,
  review_interval_hours = excluded.review_interval_hours,
  cutoff_time = excluded.cutoff_time,
  only_relevant_after_morning = excluded.only_relevant_after_morning,
  updated_at = now();

create table if not exists public.executive_schedule_slots (
  id uuid primary key default gen_random_uuid(),
  slot_key text not null unique,
  scheduled_for timestamptz not null,
  slot_kind text not null check (slot_kind in ('morning','review','manual')),
  task_id uuid references public.business_agent_tasks(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued','completed','not_relevant','notified','failed')),
  snapshot_keys jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.executive_notifications (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.business_agent_tasks(id) on delete cascade,
  channel text not null check (channel in ('email','whatsapp')),
  recipient text not null,
  status text not null default 'pending'
    check (status in ('pending','sending','sent','skipped','failed')),
  attempts integer not null default 0,
  error text,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, channel)
);

create index if not exists executive_schedule_slots_scheduled_idx
  on public.executive_schedule_slots(scheduled_for desc);
create index if not exists executive_notifications_dispatch_idx
  on public.executive_notifications(status, next_attempt_at, created_at);

create or replace function public.schedule_executive_agent_task(
  p_slot_key text,
  p_scheduled_for timestamptz,
  p_slot_kind text,
  p_payload jsonb,
  p_snapshot_keys jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_task_id uuid; v_slot_id uuid;
begin
  if p_slot_kind not in ('morning','review','manual') then
    raise exception 'invalid_slot_kind';
  end if;

  select task_id into v_task_id
  from public.executive_schedule_slots where slot_key=p_slot_key;
  if v_task_id is not null then return v_task_id; end if;

  insert into public.business_agent_tasks(
    agent_type, action, payload, status, priority, requested_by
  ) values (
    'executive', 'analyze_company', coalesce(p_payload,'{}'::jsonb),
    'pending', case when p_slot_kind='morning' then 100 else 80 end, null
  ) returning id into v_task_id;

  insert into public.executive_schedule_slots(
    slot_key,scheduled_for,slot_kind,task_id,snapshot_keys
  ) values (
    p_slot_key,p_scheduled_for,p_slot_kind,v_task_id,coalesce(p_snapshot_keys,'{}'::jsonb)
  ) on conflict (slot_key) do nothing returning id into v_slot_id;

  if v_slot_id is null then
    delete from public.business_agent_tasks where id=v_task_id;
    select task_id into v_task_id from public.executive_schedule_slots where slot_key=p_slot_key;
  end if;
  return v_task_id;
end $$;

create or replace function public.complete_business_agent_task(
 p_task_id uuid,p_worker_id text,p_lease_token uuid,p_result jsonb
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_proposal jsonb;
  v_agent_type text;
  v_notify boolean := false;
  v_settings public.executive_agent_settings%rowtype;
begin
 update public.business_agent_tasks set status='completed',result=p_result,
   completed_at=now(),updated_at=now(),lease_expires_at=null
 where id=p_task_id and status='in_progress' and worker_id=p_worker_id and lease_token=p_lease_token
 returning agent_type into v_agent_type;
 if not found then raise exception 'lease_lost'; end if;

 for v_proposal in select value from jsonb_array_elements(coalesce(p_result->'proposals','[]'::jsonb))
 loop
   insert into public.action_proposals(task_id,kind,title,summary,payload,risk_level)
   values(p_task_id,v_proposal->>'kind',v_proposal->>'title',v_proposal->>'summary',
     coalesce(v_proposal->'payload','{}'::jsonb),coalesce(v_proposal->>'risk_level','medium'));
 end loop;

 if v_agent_type='executive' then
   v_notify := coalesce((p_result->'metrics'->>'notification_required')::boolean,false);
   update public.executive_schedule_slots set
     status=case when v_notify then 'completed' else 'not_relevant' end,
     completed_at=now()
   where task_id=p_task_id;

   if v_notify and coalesce((
     select (payload->'delivery'->>'auto_send')::boolean
     from public.business_agent_tasks where id=p_task_id
   ),false) then
     select * into v_settings from public.executive_agent_settings where id='default';
     if v_settings.email_enabled and nullif(trim(v_settings.email_to),'') is not null then
       insert into public.executive_notifications(task_id,channel,recipient)
       values(p_task_id,'email',v_settings.email_to)
       on conflict (task_id,channel) do nothing;
     end if;
     if v_settings.whatsapp_enabled and nullif(trim(v_settings.whatsapp_to),'') is not null then
       insert into public.executive_notifications(task_id,channel,recipient,status)
       values(p_task_id,'whatsapp',v_settings.whatsapp_to,'pending')
       on conflict (task_id,channel) do nothing;
     end if;
   end if;
 end if;
end $$;

create or replace function public.claim_executive_notification()
returns table(notification jsonb, task jsonb)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_notification public.executive_notifications%rowtype;
begin
  select * into v_notification from public.executive_notifications
  where status in ('pending','failed') and attempts < 5 and next_attempt_at <= now()
  order by created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.executive_notifications n set
    status='sending',attempts=attempts+1,updated_at=now()
  where n.id=v_notification.id returning to_jsonb(n) into notification;
  select to_jsonb(bat.*) into task from public.business_agent_tasks bat where bat.id=v_notification.task_id;
  return next;
end $$;

create or replace function public.finish_executive_notification(
  p_notification_id uuid,p_success boolean,p_error text default null
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_task_id uuid;
begin
  update public.executive_notifications set
    status=case when p_success then 'sent' else 'failed' end,
    sent_at=case when p_success then now() else null end,
    error=case when p_success then null else left(coalesce(p_error,'delivery_failed'),500) end,
    next_attempt_at=case when p_success then now() else now()+interval '15 minutes' end,
    updated_at=now()
  where id=p_notification_id returning task_id into v_task_id;
  if p_success then
    update public.executive_schedule_slots set status='notified' where task_id=v_task_id;
  end if;
end $$;

alter table public.executive_agent_settings enable row level security;
alter table public.executive_schedule_slots enable row level security;
alter table public.executive_notifications enable row level security;

drop policy if exists executive_settings_authenticated_read on public.executive_agent_settings;
create policy executive_settings_authenticated_read on public.executive_agent_settings
  for select to authenticated using (true);
drop policy if exists executive_settings_admin_write on public.executive_agent_settings;
create policy executive_settings_admin_write on public.executive_agent_settings
  for all to authenticated using (public.current_role()='administrador')
  with check (public.current_role()='administrador');
drop policy if exists executive_slots_authenticated_read on public.executive_schedule_slots;
create policy executive_slots_authenticated_read on public.executive_schedule_slots
  for select to authenticated using (true);
drop policy if exists executive_notifications_authenticated_read on public.executive_notifications;
create policy executive_notifications_authenticated_read on public.executive_notifications
  for select to authenticated using (true);

grant select on public.executive_agent_settings,public.executive_schedule_slots,public.executive_notifications to authenticated;
grant all on public.executive_agent_settings,public.executive_schedule_slots,public.executive_notifications to service_role;
revoke all on function public.schedule_executive_agent_task(text,timestamptz,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.claim_executive_notification() from public,anon,authenticated;
revoke all on function public.finish_executive_notification(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.schedule_executive_agent_task(text,timestamptz,text,jsonb,jsonb) to service_role;
grant execute on function public.claim_executive_notification() to service_role;
grant execute on function public.finish_executive_notification(uuid,boolean,text) to service_role;

comment on table public.executive_notifications is
  'Auditoria de avisos del Agente Gerente. WhatsApp permanece deshabilitado hasta aprobacion de Meta.';
