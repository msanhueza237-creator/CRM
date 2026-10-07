begin;

create table public.whatsapp_message_reads (
  user_id uuid not null references public.profiles(id) on delete cascade,
  message_id uuid not null references public.whatsapp_messages(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, message_id)
);
create index whatsapp_message_reads_message_idx on public.whatsapp_message_reads(message_id);
alter table public.whatsapp_message_reads enable row level security;
revoke all on public.whatsapp_message_reads from public, anon, authenticated;
grant select, insert, delete on public.whatsapp_message_reads to service_role;
comment on table public.whatsapp_message_reads is 'Internal CRM reading state per user. Does not change Meta delivery status or marketing consent. Access only through the authenticated administrator Edge Function.';

create function public.crm_whatsapp_inbox_phone(p_phone text) returns text
language sql immutable parallel safe security invoker set search_path = '' as $$
  select case when digits ~ '^9[0-9]{8}$' then '56' || digits else digits end
  from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') digits) p;
$$;

create function public.crm_whatsapp_inbox(p_user_id uuid, p_search text default '', p_filter text default 'all', p_offset integer default 0, p_limit integer default 30)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.profiles where id = p_user_id and role = 'administrador' and active is true) then
    raise exception 'Active administrator required' using errcode = '42501';
  end if;
  if p_filter is null or p_filter not in ('all','unread','new') or p_offset is null or p_offset < 0 or p_offset > 100000 or p_limit is null or p_limit < 0 or p_limit > 50 or length(coalesce(p_search,'')) > 160 then
    raise exception 'Invalid inbox query' using errcode = '22023';
  end if;
  with messages as (
    select m.id, m.company_id, public.crm_whatsapp_inbox_phone(m.phone_number) phone,
      m.direction, m.body, m.message_type, m.status, m.occurred_at, m.created_at,
      m.direction = 'inbound' and r.message_id is null unread,
      row_number() over(partition by m.company_id, public.crm_whatsapp_inbox_phone(m.phone_number) order by m.occurred_at desc, m.created_at desc, m.id desc) position
    from public.whatsapp_messages m
    left join public.whatsapp_message_reads r on r.message_id = m.id and r.user_id = p_user_id
  ), grouped as (
    select company_id, phone, count(*) filter(where unread)::integer unread_count,
      (array_agg(id order by occurred_at desc, created_at desc, id desc) filter(where direction = 'inbound'))[1] latest_inbound_id
    from messages group by company_id, phone
  ), conversations as (
    select g.company_id, g.phone, g.unread_count, g.latest_inbound_id, m.id latest_id,
      coalesce(c.name, 'Sin ficha vinculada') company_name,
      coalesce(nullif(contact.names,''), nullif(c.contact_name,''), c.name, '+' || g.phone) contact_name,
      coalesce(c.source = 'whatsapp_webhook' and c.status = 'prospecto', false) is_new,
      left(coalesce(nullif(m.body,''), '[' || coalesce(m.message_type,'Mensaje') || ']'), 240) preview,
      m.direction, m.status, m.occurred_at last_at, m.created_at
    from grouped g join messages m on m.company_id is not distinct from g.company_id and m.phone = g.phone and m.position = 1
    left join public.companies c on c.id = g.company_id
    left join lateral (
      select string_agg(distinct ct.full_name, ', ' order by ct.full_name) names from public.contacts ct
      where ct.company_id = g.company_id and g.phone <> '' and
        (public.crm_whatsapp_inbox_phone(ct.whatsapp) = g.phone or public.crm_whatsapp_inbox_phone(ct.phone) = g.phone)
    ) contact on true
  ), filtered as (
    select * from conversations where
      (p_filter = 'all' or (p_filter = 'unread' and unread_count > 0) or (p_filter = 'new' and is_new))
      and (strpos(translate(lower(company_name || ' ' || contact_name || ' ' || phone), U&'\00E1\00E9\00ED\00F3\00FA\00FC\00F1', 'aeiouun'),
        translate(lower(trim(coalesce(p_search,''))), U&'\00E1\00E9\00ED\00F3\00FA\00FC\00F1', 'aeiouun')) > 0
        or (trim(coalesce(p_search,'')) ~ '^[+0-9 ()-]{4,}$' and length(regexp_replace(p_search,'[^0-9]','','g')) >= 4 and strpos(phone,regexp_replace(p_search,'[^0-9]','','g')) > 0))
  ), page as (
    select * from filtered order by last_at desc, created_at desc, latest_id desc offset p_offset limit p_limit
  )
  select jsonb_build_object(
    'summary', (select jsonb_build_object('conversations',count(*),'unreadMessages',coalesce(sum(unread_count),0),'unreadConversations',count(*) filter(where unread_count>0),'newContacts',count(*) filter(where is_new)) from conversations),
    'total', (select count(*) from filtered),
    'offset',p_offset,'limit',p_limit,
    'conversations',coalesce((select jsonb_agg(jsonb_build_object('companyId',company_id,'phone',phone,'companyName',company_name,'name',contact_name,'isNew',is_new,'unreadCount',unread_count,'latestInboundId',latest_inbound_id,'preview',preview,'direction',direction,'status',status,'lastAt',last_at) order by last_at desc,created_at desc,latest_id desc) from page),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create function public.crm_whatsapp_set_read(p_user_id uuid, p_company_id uuid, p_phone text, p_message_ids uuid[], p_read boolean default true)
returns integer language plpgsql security invoker set search_path = '' as $$
declare valid_count integer;
begin
  if not exists(select 1 from public.profiles where id = p_user_id and role = 'administrador' and active is true) then
    raise exception 'Active administrator required' using errcode = '42501';
  end if;
  if p_read is null or p_message_ids is null or cardinality(p_message_ids) < 1 or cardinality(p_message_ids) > 50 or p_phone is null or p_phone !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'Invalid reading receipt' using errcode = '22023';
  end if;
  select count(*) into valid_count from public.whatsapp_messages m
    where m.id = any(p_message_ids) and m.company_id is not distinct from p_company_id
      and public.crm_whatsapp_inbox_phone(m.phone_number) = p_phone and m.direction = 'inbound';
  if valid_count <> cardinality(p_message_ids) then raise exception 'Messages do not belong to this conversation' using errcode = '22023'; end if;
  if p_read then
    insert into public.whatsapp_message_reads(user_id,message_id)
      select p_user_id, unnest(p_message_ids) on conflict(user_id,message_id) do nothing;
  else
    delete from public.whatsapp_message_reads where user_id = p_user_id and message_id = any(p_message_ids);
  end if;
  return valid_count;
end;
$$;

revoke all on function public.crm_whatsapp_inbox_phone(text) from public, anon, authenticated;
revoke all on function public.crm_whatsapp_inbox(uuid,text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.crm_whatsapp_set_read(uuid,uuid,text,uuid[],boolean) from public, anon, authenticated;
grant execute on function public.crm_whatsapp_inbox_phone(text) to service_role;
grant execute on function public.crm_whatsapp_inbox(uuid,text,text,integer,integer) to service_role;
grant execute on function public.crm_whatsapp_set_read(uuid,uuid,text,uuid[],boolean) to service_role;
notify pgrst, 'reload schema';
commit;
