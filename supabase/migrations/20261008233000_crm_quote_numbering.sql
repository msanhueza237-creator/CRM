begin;
create table if not exists public.crm_quote_counter (
 singleton boolean primary key default true check (singleton),
 next_number bigint not null default 100 check (next_number >= 100)
);
insert into public.crm_quote_counter(singleton,next_number) values(true,100) on conflict do nothing;
alter table public.crm_quote_counter enable row level security;
revoke all on public.crm_quote_counter from public, anon, authenticated;

create or replace function public.register_numbered_crm_quote(p_quote jsonb,p_company_id uuid,p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
 v_id uuid; v_number bigint; v_quote jsonb; v_existing public.interactions%rowtype;
begin
 if p_quote->>'kind' <> 'crm_quote_v1' or p_company_id is null or p_owner_id is null then
  raise exception 'Invalid quote';
 end if;
 v_id := (p_quote->>'id')::uuid;
 if v_id is null then raise exception 'Invalid quote id'; end if;
 -- Serialize registration; retrying an existing id never consumes another number.
 select next_number into strict v_number from public.crm_quote_counter where singleton for update;
 select * into v_existing from public.interactions where id=v_id;
 if found then
  if v_existing.company_id<>p_company_id or v_existing.type::text<>'cotizacion' then raise exception 'Quote id already used'; end if;
  return jsonb_build_object('quote',v_existing.result::jsonb,'alreadyRegistered',true);
 end if;
 v_quote := p_quote || jsonb_build_object('quoteNumber',v_number,'folio','CRM-'||v_number::text);
 insert into public.interactions(id,company_id,type,owner_id,description,result,occurred_at)
 values(v_id,p_company_id,'cotizacion',p_owner_id,
  'Cotización CRM-'||v_number::text||' · '||coalesce(p_quote#>>'{customer,name}','')||' · $'||(p_quote->>'total')||' CLP',
  v_quote::text,(p_quote->>'date')::timestamptz);
 update public.crm_quote_counter set next_number=v_number+1 where singleton;
 return jsonb_build_object('quote',v_quote,'alreadyRegistered',false);
end;
$$;
revoke all on function public.register_numbered_crm_quote(jsonb,uuid,uuid) from public, anon, authenticated;
grant execute on function public.register_numbered_crm_quote(jsonb,uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
