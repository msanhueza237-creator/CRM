-- Isolated administrator workflow. No business data, legacy keys or pilot settings are changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(81734001);
create table if not exists public.market_native_policy (
  id boolean primary key default true check(id),
  enabled boolean not null default true,
  daily_usd numeric not null default 2.50 check(daily_usd>0 and daily_usd<=2.50),
  daily_jobs integer not null default 10 check(daily_jobs between 1 and 10)
);
insert into public.market_native_policy(id,daily_usd) values(true,0.25) on conflict do nothing;
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
-- Approved 2026-10-06: upgrade the native module only; preserve every receipt.
do $$
begin
  if exists(select 1 from public.market_native_jobs where state='running') then
    raise exception 'A market study is running; apply the limit change after it finishes';
  end if;
  if exists(select 1 from public.market_native_policy where daily_usd not in (0.25,2.50) or daily_jobs<>10) then
    raise exception 'Market policy changed; review before applying the approved limit';
  end if;
end $$;
alter table public.market_native_policy drop constraint market_native_policy_daily_usd_check;
alter table public.market_native_policy add constraint market_native_policy_daily_usd_check check(daily_usd>0 and daily_usd<=2.50);
alter table public.market_native_policy alter column daily_usd set default 2.50;
update public.market_native_policy set daily_usd=2.50 where id=true and daily_usd=0.25;
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
    return jsonb_build_object('enabled',config.enabled,'web_search_supported',true,'daily_usd',config.daily_usd,'daily_jobs',config.daily_jobs,'spent_usd',spent,'jobs_today',jobs,
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
    if p_data->>'kind'='market_search' then
      -- Hold USD 0.25 per search, including uncertain provider-side web usage.
      -- The shared daily amount and attempt limits below remain authoritative.
      amount := 0.25;
    else
      amount := (30000*(p_data->'selection'->>'input_usd_per_million')::numeric+1024*(p_data->'selection'->>'output_usd_per_million')::numeric)/1000000;
    end if;
    if amount is null or amount<=0 or amount::text in ('NaN','Infinity','-Infinity') or amount>0.25 then raise exception 'Invalid reservation'; end if;
    if spent+amount>config.daily_usd or jobs>=config.daily_jobs then raise exception 'Daily study budget reached'; end if;
    if length(p_data->>'sku') not between 1 and 120 or length(p_data->>'hash')<>64 or length(p_data->>'url') not between 10 and 1500 then raise exception 'Invalid study'; end if;
    insert into market_native_jobs(id,actor,input_hash,sku,source_url,selection,reserved_usd)
      values((p_data->>'id')::uuid,p_actor,p_data->>'hash',p_data->>'sku',p_data->>'url',
        (p_data->'selection')||jsonb_build_object('kind',case when p_data->>'kind'='market_search' then 'market_search' else 'source' end),amount) returning * into job;
    return jsonb_build_object('created',true,'ticket',job.ticket,'job',to_jsonb(job)-'actor'-'input_hash'-'ticket');
  elsif p_action='finish' then
    select * into job from market_native_jobs where id=(p_data->>'id')::uuid and actor=p_actor and ticket=(p_data->>'ticket')::uuid;
    if not found then raise exception 'Study receipt unavailable'; end if;
    if job.state='running' then
      cost := (p_data->>'cost')::numeric;
      if job.selection->>'kind'='market_search' then cost:=null; end if;
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
