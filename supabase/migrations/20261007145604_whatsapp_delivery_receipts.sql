begin;

alter table public.whatsapp_messages
  add column sent_at timestamptz,
  add column delivered_at timestamptz,
  add column read_at timestamptz,
  add column failed_at timestamptz;

-- Keep API acceptance separate from signed delivery receipts. Never infer read from a reply.
drop function public.crm_whatsapp_message_status(text,jsonb);
create function public.crm_whatsapp_message_status(p_meta_id text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v jsonb := p_payload#>'{entry,0,changes,0,value,statuses,0}';
  incoming_status text := v->>'status'; event_at timestamptz; event_id uuid;
  message_row public.whatsapp_messages%rowtype; final_status text;
begin
  if p_meta_id is null or v->>'id' is distinct from p_meta_id then raise exception 'Invalid message identity'; end if;
  if incoming_status is null or incoming_status not in ('sent','delivered','read','failed') then
    return jsonb_build_object('processed',true,'ignored',true);
  end if;
  if coalesce(v->>'timestamp','') !~ '^[0-9]{1,12}$' then raise exception 'Missing receipt timestamp'; end if;
  event_at := to_timestamp((v->>'timestamp')::double precision);
  if event_at <= '2000-01-01'::timestamptz or event_at > now()+interval '5 minutes' then raise exception 'Invalid receipt timestamp'; end if;
  insert into public.whatsapp_webhook_events(event_type,meta_message_id,phone_number,payload,event_key)
    values('status',p_meta_id,v->>'recipient_id',p_payload,
      'delivery:'||md5(jsonb_build_array(p_payload#>>'{entry,0,id}',p_payload#>>'{entry,0,changes,0,value,metadata,phone_number_id}',p_meta_id,incoming_status,v->>'timestamp')::text))
    on conflict(event_key) where event_key is not null do update set event_key=excluded.event_key
    returning id into event_id;
  select * into message_row from public.whatsapp_messages where meta_message_id=p_meta_id and direction='outbound' for update;
  if not found then return jsonb_build_object('processed',false,'pendingMessage',true); end if;
  if nullif(v->>'recipient_id','') is not null and public.crm_whatsapp_inbox_phone(v->>'recipient_id') is distinct from public.crm_whatsapp_inbox_phone(message_row.phone_number) then
    raise exception 'Receipt recipient mismatch';
  end if;
  final_status := case
    when message_row.status='read' or incoming_status='read' then 'read'
    when message_row.status='delivered' or incoming_status='delivered' then 'delivered'
    when message_row.status='failed' or incoming_status='failed' then 'failed'
    else 'sent' end;
  update public.whatsapp_messages set status=final_status,
    sent_at=case when incoming_status='sent' then least(sent_at,event_at) else sent_at end,
    delivered_at=case when incoming_status='delivered' then least(delivered_at,event_at) else delivered_at end,
    read_at=case when incoming_status='read' then least(read_at,event_at) else read_at end,
    failed_at=case when incoming_status='failed' then least(failed_at,event_at) else failed_at end,
    pricing=coalesce(v->'pricing',pricing),provider_error=coalesce(v->'errors',provider_error)
    where id=message_row.id;
  update public.whatsapp_campaign_recipients set status=case when replied_at is not null then 'replied' else final_status end,
    sent_at=case when incoming_status='sent' then least(sent_at,event_at) else sent_at end,
    delivered_at=case when incoming_status='delivered' then least(delivered_at,event_at) else delivered_at end,
    read_at=case when incoming_status='read' then least(read_at,event_at) else read_at end,
    failed_at=case when incoming_status='failed' then least(failed_at,event_at) else failed_at end
    where meta_message_id=p_meta_id;
  update public.whatsapp_webhook_events set processed=true,processing_error=null,company_id=message_row.company_id where id=event_id;
  return jsonb_build_object('processed',true);
end $$;
revoke all on function public.crm_whatsapp_message_status(text,jsonb) from public,anon,authenticated;
grant execute on function public.crm_whatsapp_message_status(text,jsonb) to service_role;

-- Recover receipts which arrived before the provider response was saved.
create function public.crm_whatsapp_replay_delivery() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare e record;
begin
  for e in select payload from public.whatsapp_webhook_events where event_type='status' and meta_message_id=new.meta_message_id and not processed order by received_at loop
    perform public.crm_whatsapp_message_status(new.meta_message_id,e.payload);
  end loop;
  return new;
end $$;
revoke all on function public.crm_whatsapp_replay_delivery() from public,anon,authenticated;
create trigger whatsapp_replay_delivery after insert or update of meta_message_id on public.whatsapp_messages
  for each row when (new.direction='outbound' and new.meta_message_id is not null)
  execute function public.crm_whatsapp_replay_delivery();

-- Reconstruct only from actual stored receipts; preserve all original events and message bodies.
do $$ declare e record; begin
  for e in select meta_message_id,payload from public.whatsapp_webhook_events
    where event_type='status' and payload#>>'{entry,0,changes,0,value,statuses,0,status}' in ('sent','delivered','read','failed')
      and coalesce(payload#>>'{entry,0,changes,0,value,statuses,0,timestamp}','') ~ '^[0-9]{1,12}$'
    order by received_at loop
    perform public.crm_whatsapp_message_status(e.meta_message_id,e.payload);
  end loop;
end $$;

notify pgrst,'reload schema';
commit;
