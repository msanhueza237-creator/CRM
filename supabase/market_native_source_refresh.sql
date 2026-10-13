-- Apply after market_native_studies.sql. No catalog, commercial price or review writes.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create table if not exists public.market_native_source_revisions (
 request_id uuid primary key,
 job_id uuid not null references public.market_native_jobs(id),
 actor uuid not null references public.profiles(id),
 revision integer not null check(revision>0),
 previous_job jsonb not null,
 refreshed_job jsonb not null,
 created_at timestamptz not null default now(),
 unique(job_id,revision)
);
alter table public.market_native_source_revisions enable row level security;
revoke all on public.market_native_source_revisions from public,anon,authenticated,service_role;
grant select,insert on public.market_native_source_revisions to service_role;
create or replace function public.market_native_sources_refresh(p_actor uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 job public.market_native_jobs; prior public.market_native_source_revisions;
 revision integer; expected integer; request uuid; before_job jsonb; stamp timestamptz := clock_timestamp();
begin
 if not exists(select 1 from profiles where id=p_actor and role='administrador' and active) then raise exception 'Forbidden'; end if;
 if p_action not in ('prepare','commit') then raise exception 'Invalid refresh action'; end if;
 expected := (p_data->>'revision')::integer; request := (p_data->>'request_id')::uuid;
 if expected is null or expected<0 or request is null then raise exception 'Invalid refresh identity'; end if;
 -- A request UUID cannot be rebound to another study/revision/actor, even concurrently.
 perform pg_advisory_xact_lock(hashtextextended(request::text,81734002));
 select * into prior from market_native_source_revisions where request_id=request;
 if found then
  if prior.actor<>p_actor or prior.job_id<>(p_data->>'id')::uuid or prior.revision<>expected+1 then raise exception 'Refresh identity conflict'; end if;
  return jsonb_build_object('replayed',true,'job',prior.refreshed_job);
 end if;
 select * into job from market_native_jobs where id=(p_data->>'id')::uuid for update;
 if not found then raise exception 'Study unavailable'; end if;
 if job.state<>'completed' or job.result->>'kind' is distinct from 'market_search' then raise exception 'Study not refreshable'; end if;
 revision := coalesce((job.result->>'source_revision')::integer,0);
 if revision<>expected then raise exception 'Source revision conflict'; end if;
 if p_action='prepare' then return jsonb_build_object('replayed',false,'job',to_jsonb(job)-'actor'-'input_hash'-'ticket'); end if;
 if jsonb_typeof(p_data->'result'->'offers') is distinct from 'array' or jsonb_array_length(p_data->'result'->'offers')>8 or octet_length((p_data->'result')::text)>200000 then raise exception 'Invalid refreshed sources'; end if;
 before_job := to_jsonb(job)-'actor'-'input_hash'-'ticket';
 -- Only source evidence and its revision change: provider receipt, timestamps, cost and all other history stay intact.
 update market_native_jobs set result=result||jsonb_build_object(
  'offers',p_data->'result'->'offers','refreshed_at',stamp,'source_revision',revision+1,
  'source_history',coalesce((select jsonb_agg(x.summary order by x.rev) from (
    select r.revision rev,jsonb_build_object('revision',r.revision,'refreshed_at',r.created_at,'request_id',r.request_id) summary
    from market_native_source_revisions r where r.job_id=job.id order by r.revision desc limit 19
  ) x),'[]'::jsonb)||jsonb_build_array(jsonb_build_object('revision',revision+1,'refreshed_at',stamp,'request_id',request)))
 where id=job.id returning * into job;
 insert into market_native_source_revisions(request_id,job_id,actor,revision,previous_job,refreshed_job,created_at)
 values(request,job.id,p_actor,revision+1,before_job,to_jsonb(job)-'actor'-'input_hash'-'ticket',stamp);
 return jsonb_build_object('replayed',false,'job',to_jsonb(job)-'actor'-'input_hash'-'ticket');
end $$;
revoke all on function public.market_native_sources_refresh(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.market_native_sources_refresh(uuid,text,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
