-- Isolated administrator workflow. No business data, legacy keys or pilot settings are changed.
begin;
create table if not exists public.market_native_policy (
  id boolean primary key default true check(id),
  enabled boolean not null default true,
  daily_usd numeric not null default 0.25 check(daily_usd>0 and daily_usd<=0.25),
  daily_jobs integer not null default 10 check(daily_jobs between 1 and 10)
);
insert into public.market_native_policy(id) values(true) on conflict do nothing;
create table if not exists public.market_native_jobs (
  id uuid primary key, actor uuid not null references public.profiles(id),
  input_hash text not null, sku text not null, source_url text not null,
  selection jsonb not null, ticket uuid not null default gen_random_uuid(),
  state text not null default 'running' check(state in ('running','completed','failed','unknown')),
  reserved_usd numeric not null check(reserved_usd>0 and reserved_usd<=0.25),
  estimated_usd numeric check(estimated_usd>=0 and estimated_usd<=reserved_usd),
  result jsonb not null default '{}', created_at timestamptz not null default now(), finished_at timestamptz
);
create index if not exists market_native_jobs_created_idx on public.market_native_jobs(created_at);
alter table public.market_native_jobs enable row level security;
alter table public.market_native_policy enable row level security;
revoke all on public.market_native_jobs,public.market_native_policy from public,anon,authenticated,service_role;
grant select,insert,update on public.market_native_jobs to service_role;
grant select on public.market_native_policy to service_role;

create or replace function public.market_native_run(p_actor uuid,p_action text,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  config public.market_native_policy; job public.market_native_jobs;
  spent numeric; jobs integer; amount numeric; cost numeric;
  day_start timestamptz := date_trunc('day',now() at time zone 'America/Santiago') at time zone 'America/Santiago';
begin
  perform pg_advisory_xact_lock(81734001);
  if not exists(select 1 from profiles where id=p_actor and role='administrador' and active) then raise exception 'Forbidden'; end if;
  select * into config from market_native_policy where id=true;
  if not found then raise exception 'Study policy unavailable'; end if;
  update market_native_jobs set state='unknown',finished_at=now(),result=jsonb_build_object('error','La consulta quedo sin confirmacion. No se repetira automaticamente.')
    where state='running' and created_at<now()-interval '2 minutes';
  select coalesce(sum(coalesce(estimated_usd,reserved_usd)),0),count(*) into spent,jobs from market_native_jobs where created_at>=day_start;
  if p_action='status' then
    return jsonb_build_object('enabled',config.enabled,'daily_usd',config.daily_usd,'daily_jobs',config.daily_jobs,'spent_usd',spent,'jobs_today',jobs,
      'jobs',coalesce((select jsonb_agg(to_jsonb(j)-'actor'-'input_hash'-'ticket' order by j.created_at desc) from (select * from market_native_jobs order by created_at desc limit 25) j),'[]'::jsonb));
  elsif p_action='reserve' then
    select * into job from market_native_jobs where id=(p_data->>'id')::uuid;
    if found then
      if job.actor<>p_actor or job.input_hash is distinct from p_data->>'hash' then raise exception 'Study identity conflict'; end if;
      return jsonb_build_object('created',false,'job',to_jsonb(job)-'actor'-'input_hash'-'ticket');
    end if;
    if not config.enabled then raise exception 'Study disabled'; end if;
    if not exists(select 1 from market_extraction_policy where revision=(p_data->>'revision')::integer and choice=p_data->'selection'->>'choice') then raise exception 'Model selection changed'; end if;
    if exists(select 1 from market_native_jobs where state='running') then raise exception 'Another study is running'; end if;
    amount := (30000*(p_data->'selection'->>'input_usd_per_million')::numeric+1024*(p_data->'selection'->>'output_usd_per_million')::numeric)/1000000;
    if amount is null or amount<=0 or amount::text in ('NaN','Infinity','-Infinity') or amount>0.25 then raise exception 'Invalid reservation'; end if;
    if spent+amount>config.daily_usd or jobs>=config.daily_jobs then raise exception 'Daily study budget reached'; end if;
    if length(p_data->>'sku') not between 1 and 120 or length(p_data->>'hash')<>64 or length(p_data->>'url') not between 10 and 1500 then raise exception 'Invalid study'; end if;
    insert into market_native_jobs(id,actor,input_hash,sku,source_url,selection,reserved_usd)
      values((p_data->>'id')::uuid,p_actor,p_data->>'hash',p_data->>'sku',p_data->>'url',p_data->'selection',amount) returning * into job;
    return jsonb_build_object('created',true,'ticket',job.ticket,'job',to_jsonb(job)-'actor'-'input_hash'-'ticket');
  elsif p_action='finish' then
    select * into job from market_native_jobs where id=(p_data->>'id')::uuid and actor=p_actor and ticket=(p_data->>'ticket')::uuid;
    if not found then raise exception 'Study receipt unavailable'; end if;
    if job.state='running' then
      cost := (p_data->>'cost')::numeric;
      if cost is not null and (cost<0 or cost>job.reserved_usd or cost::text in ('NaN','Infinity','-Infinity')) then raise exception 'Invalid study charge'; end if;
      if octet_length((p_data->'result')::text)>35000 or jsonb_typeof(p_data->'result')<>'object' then raise exception 'Invalid study result'; end if;
      update market_native_jobs set state=p_data->>'state',estimated_usd=cost,result=p_data->'result',finished_at=now()
        where id=job.id returning * into job;
    end if;
    return to_jsonb(job)-'actor'-'input_hash'-'ticket';
  end if;
  raise exception 'Unknown study action';
end $$;
revoke all on function public.market_native_run(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.market_native_run(uuid,text,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
