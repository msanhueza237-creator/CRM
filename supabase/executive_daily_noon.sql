-- Agenda gerencial solicitada: un informe diario a las 12:00 America/Santiago.
-- No modifica destinatarios, canales, documentos ni asientos contables.
begin;
update public.executive_agent_settings set timezone='America/Santiago',
  morning_time='12:00', cutoff_time='20:00', review_interval_hours=12,
  only_relevant_after_morning=true, updated_at=now() where id='default';

create or replace function public.schedule_executive_agent_task(
  p_slot_key text,p_scheduled_for timestamptz,p_slot_kind text,p_payload jsonb,
  p_snapshot_keys jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_task_id uuid; v_day date := (now() at time zone 'America/Santiago')::date;
begin
  perform pg_advisory_xact_lock(hashtext('executive_daily_schedule'));
  if p_payload->>'mode' is distinct from 'daily'
    or p_slot_key is distinct from 'executive:'||v_day::text||':1200'
    or p_payload->>'report_date' is distinct from v_day::text
    or p_scheduled_for is distinct from ((v_day + time '12:00') at time zone 'America/Santiago')
    or (now() at time zone 'America/Santiago')::time < time '12:00'
    or (now() at time zone 'America/Santiago')::time >= time '20:00'
  then return null; end if;
  select task_id into v_task_id from public.executive_schedule_slots where slot_key=p_slot_key;
  if v_task_id is not null then return v_task_id; end if;
  -- A previous-version message already sent today also consumes today's allowance.
  if exists(select 1 from public.executive_notifications where status in ('sent','sending')
    and (coalesce(sent_at,updated_at) at time zone 'America/Santiago')::date=v_day)
  then return null; end if;
  insert into public.business_agent_tasks(agent_type,action,payload,status,priority,requested_by)
    values('executive','analyze_company',p_payload,'pending',100,null) returning id into v_task_id;
  insert into public.executive_schedule_slots(slot_key,scheduled_for,slot_kind,task_id,snapshot_keys)
    values(p_slot_key,p_scheduled_for,'morning',v_task_id,p_snapshot_keys);
  return v_task_id;
end $$;

create or replace function public.claim_executive_notification()
returns table(notification jsonb,task jsonb)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_notification public.executive_notifications%rowtype;
  v_day date := (now() at time zone 'America/Santiago')::date;
begin
  perform pg_advisory_xact_lock(hashtext('executive_daily_delivery'));
  -- Retain old queue rows as audit evidence; never replay an old day's report.
  update public.executive_notifications n set status='skipped',error='superseded_by_daily_noon_policy',updated_at=now()
    from public.business_agent_tasks t where n.task_id=t.id and n.status in ('pending','failed')
      and (t.payload->>'mode' is distinct from 'daily' or t.payload->>'report_date' is distinct from v_day::text);
  if (now() at time zone 'America/Santiago')::time < time '12:00'
    or (now() at time zone 'America/Santiago')::time >= time '20:00' then return; end if;
  if exists(select 1 from public.executive_notifications where status in ('sent','sending')
    and (coalesce(sent_at,updated_at) at time zone 'America/Santiago')::date=v_day) then return; end if;
  -- No automatic retry after an uncertain transport result: avoid duplicate mail.
  select n.* into v_notification from public.executive_notifications n
    join public.business_agent_tasks t on t.id=n.task_id
    where n.status='pending' and n.attempts=0 and n.next_attempt_at<=now()
      and n.channel='email' and t.status='completed'
      and t.payload->>'mode'='daily' and t.payload->>'report_date'=v_day::text
      and t.payload#>>'{delivery,auto_send}'='true'
      and exists(select 1 from public.executive_schedule_slots s where s.task_id=t.id and s.slot_key='executive:'||v_day::text||':1200')
    order by n.created_at for update of n skip locked limit 1;
  if not found then return; end if;
  update public.executive_notifications n set status='sending',attempts=attempts+1,updated_at=now()
    where n.id=v_notification.id returning to_jsonb(n) into notification;
  select to_jsonb(t.*) into task from public.business_agent_tasks t where t.id=v_notification.task_id;
  return next;
end $$;

revoke all on function public.schedule_executive_agent_task(text,timestamptz,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.claim_executive_notification() from public,anon,authenticated;
grant execute on function public.schedule_executive_agent_task(text,timestamptz,text,jsonb,jsonb),public.claim_executive_notification() to service_role;
commit;
