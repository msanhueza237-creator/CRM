-- Local proposal only. Do not apply to production without a separate release approval.
begin;
create table if not exists public.market_study_observations (
 id uuid primary key default gen_random_uuid(), provider text not null, external_id text not null,
 revision integer not null check(revision>0), payload jsonb not null check(jsonb_typeof(payload)='object'),
 created_at timestamptz not null default clock_timestamp(), created_by uuid not null references public.profiles(id),
 unique(provider,external_id,revision), check(length(provider) between 1 and 80),check(length(external_id) between 1 and 120)
);
create table if not exists public.market_study_reviews (
 id uuid primary key default gen_random_uuid(), observation_id uuid not null references public.market_study_observations(id),
 request_id uuid not null unique, payload jsonb not null check(jsonb_typeof(payload)='object'),
 created_at timestamptz not null default clock_timestamp(), created_by uuid not null references public.profiles(id)
);
create index if not exists market_study_review_history on public.market_study_reviews(observation_id,created_at desc,id);
alter table public.market_study_observations enable row level security;
alter table public.market_study_reviews enable row level security;
revoke all on public.market_study_observations, public.market_study_reviews from public,anon,authenticated,service_role;
grant select,insert on public.market_study_observations,public.market_study_reviews to service_role;
create or replace function public.market_study_immutable() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin raise exception 'Market research history is append-only'; end $$;
create trigger market_study_observations_immutable before update or delete on public.market_study_observations for each row execute function public.market_study_immutable();
create trigger market_study_reviews_immutable before update or delete on public.market_study_reviews for each row execute function public.market_study_immutable();

-- INVOKER: only the existing server service role can execute; it must pass an
-- authenticated active administrator, resolved by the Edge Function (never metadata).
create or replace function public.market_study_import(p_actor uuid,p_items jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item jsonb; existing public.market_study_observations%rowtype; latest integer; inserted integer:=0; duplicates integer:=0;
begin
 if not exists(select 1 from public.profiles where id=p_actor and role='administrador' and active is true) then raise exception 'Forbidden' using errcode='42501'; end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 200 then raise exception 'Invalid batch'; end if;
 for item in select value from jsonb_array_elements(p_items) order by value->>'provider',value->>'external_id',(value->>'revision')::integer loop
  if jsonb_typeof(item)<>'object' or coalesce(item->>'provider','')='' or coalesce(item->>'external_id','')='' or (item->>'revision')::integer<1 then raise exception 'Invalid observation'; end if;
  perform pg_advisory_xact_lock(hashtextextended((item->>'provider')||':'||(item->>'external_id'),0));
  select * into existing from public.market_study_observations where provider=item->>'provider' and external_id=item->>'external_id' and revision=(item->>'revision')::integer;
  if found then
   if existing.payload<>item then raise exception 'Idempotency conflict: same key with different payload' using errcode='23505'; end if;
   duplicates:=duplicates+1; continue;
  end if;
  select coalesce(max(revision),0) into latest from public.market_study_observations where provider=item->>'provider' and external_id=item->>'external_id';
  if (item->>'revision')::integer<>latest+1 then raise exception 'Expected next consecutive revision' using errcode='40001'; end if;
  insert into public.market_study_observations(provider,external_id,revision,payload,created_by) values(item->>'provider',item->>'external_id',(item->>'revision')::integer,item,p_actor);
  inserted:=inserted+1;
 end loop;
 return jsonb_build_object('inserted',inserted,'duplicates',duplicates);
end $$;
create or replace function public.market_study_review(p_actor uuid,p_review jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare existing public.market_study_reviews%rowtype; latest uuid; result jsonb; observation uuid:=(p_review->>'observation_id')::uuid;
begin
 if not exists(select 1 from public.profiles where id=p_actor and role='administrador' and active is true) then raise exception 'Forbidden' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(observation::text,1));
 perform 1 from public.market_study_observations where id=observation;
 if not found then raise exception 'Observation not found'; end if;
 select * into existing from public.market_study_reviews where request_id=(p_review->>'request_id')::uuid;
 if found then
  if existing.payload<>p_review then raise exception 'Review idempotency conflict' using errcode='23505'; end if;
  return to_jsonb(existing);
 end if;
 if coalesce(p_review->>'decision','') not in ('approved','pending','rejected') or length(coalesce(p_review->>'reason',''))<12 then raise exception 'Invalid review'; end if;
 if p_review->>'decision'='approved' and (coalesce((p_review->>'equivalence_confirmed')::boolean,false) is not true or (p_review->>'internal_quantity')::numeric is null or (p_review->>'internal_quantity')::numeric<=0 or coalesce(p_review->>'unit','') not in ('unit','kg','m','l')) then raise exception 'Equivalence must be confirmed'; end if;
 select id into latest from public.market_study_reviews where observation_id=observation order by created_at desc,id desc limit 1;
 if latest is distinct from (p_review->>'expected_review_id')::uuid then raise exception 'Review changed: refresh before editing' using errcode='40001'; end if;
 insert into public.market_study_reviews(observation_id,request_id,payload,created_by) values(observation,(p_review->>'request_id')::uuid,p_review,p_actor) returning to_jsonb(market_study_reviews.*) into result;
 return result;
end $$;
revoke all on function public.market_study_immutable(),public.market_study_import(uuid,jsonb),public.market_study_review(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.market_study_import(uuid,jsonb),public.market_study_review(uuid,jsonb) to service_role;
commit;
