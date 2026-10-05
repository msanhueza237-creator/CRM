-- LOCAL ONLY. Apply after market_research_api.sql. No integration/key activation.
begin;
create or replace function public.market_research_access(p_key_id uuid,p_scope text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare b public.market_research_integrations%rowtype;
begin
 if p_scope is null or p_scope not in ('market-research:catalog:read','market-research:observations:write','market-research:extract') then raise exception 'Forbidden' using errcode='42501'; end if;
 select i.* into b from public.market_research_integrations i
 join public.agent_api_keys k on k.id=i.api_key_id
 join public.profiles p on p.id=i.authorized_by
 where k.id=p_key_id and k.active is true and k.revoked_at is null
 and k.expires_at is not null and k.expires_at>clock_timestamp()
 and p_scope=any(k.scopes)
 and k.scopes <@ array['market-research:catalog:read','market-research:observations:write','market-research:extract']::text[]
 and i.active is true and i.authorized_at<=clock_timestamp() and i.expires_at>clock_timestamp()
 and p.role='administrador' and p.active is true;
 if not found then raise exception 'Forbidden' using errcode='42501'; end if;
 return jsonb_build_object('id',b.id,'provider',b.provider,'allowed_skus',b.allowed_skus);
end $$;

-- Explicit field projection. Do not expose descriptions/variants JSON, prices, costs,
-- inventory quantities, suppliers, unpublished items, or foreign-trade operation data.

create table public.market_extraction_policy (
 id boolean primary key default true check(id), revision integer not null default 1,
 choice text not null default 'deepseek:deepseek-flash', enabled boolean not null default false,
 approved_until timestamptz, daily_usd numeric not null default 1 check(daily_usd>0 and daily_usd<=5),
 pilot_usd numeric not null default 5 check(pilot_usd>0 and pilot_usd<=20),
 daily_jobs integer not null default 50 check(daily_jobs between 1 and 100),
 public_hosts text[] not null default '{}', updated_by uuid references public.profiles(id), updated_at timestamptz not null default now()
);
insert into public.market_extraction_policy(id) values(true);
create table public.market_extraction_batches (
 integration_id uuid not null references public.market_research_integrations(id), batch_id uuid not null,
 selection jsonb not null, created_at timestamptz not null default now(), primary key(integration_id,batch_id)
);
create table public.market_extraction_jobs (
 integration_id uuid not null, job_id uuid not null, batch_id uuid not null,
 request_hash text not null, sku text not null, source_url text not null,
 state text not null check(state in ('running','completed','failed','unknown')),
 ticket uuid not null default gen_random_uuid(), reserved_usd numeric not null check(reserved_usd>0),
 input_tokens integer, output_tokens integer, estimated_usd numeric,
 attributes jsonb not null default '[]', error_code text,
 created_at timestamptz not null default now(), finished_at timestamptz,
 primary key(integration_id,job_id), foreign key(integration_id,batch_id) references public.market_extraction_batches(integration_id,batch_id)
);
create table public.market_extraction_policy_history (
 id uuid primary key default gen_random_uuid(), actor uuid not null references public.profiles(id),
 revision integer not null, choice text not null, created_at timestamptz not null default now()
);
create index market_extraction_running on public.market_extraction_jobs(created_at) where state='running';
alter table public.market_extraction_policy enable row level security;
alter table public.market_extraction_batches enable row level security;
alter table public.market_extraction_jobs enable row level security;
alter table public.market_extraction_policy_history enable row level security;
revoke all on public.market_extraction_policy,public.market_extraction_batches,public.market_extraction_jobs,public.market_extraction_policy_history from public,anon,authenticated,service_role;
grant select,update on public.market_extraction_policy to service_role;
grant select,insert on public.market_extraction_batches,public.market_extraction_policy_history to service_role;
grant select,insert,update on public.market_extraction_jobs to service_role;

create function public.market_extraction_select(p_actor uuid,p_revision integer,p_choice text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c public.market_extraction_policy%rowtype;
begin
 if not exists(select 1 from profiles where id=p_actor and active and role::text='administrador') then raise exception 'Forbidden' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(81734001);
 select * into c from market_extraction_policy where id for update;
 if c.revision<>p_revision then raise exception 'Selection changed' using errcode='40001'; end if;
 if p_choice !~ '^(deepseek|openai):[a-zA-Z0-9._-]{1,100}$' then raise exception 'Invalid choice' using errcode='22023'; end if;
 update market_extraction_policy set choice=p_choice,revision=revision+1,updated_by=p_actor,updated_at=clock_timestamp() where id returning * into c;
 insert into market_extraction_policy_history(actor,revision,choice) values(p_actor,c.revision,c.choice);
 return to_jsonb(c)-'updated_by';
end $$;

create function public.market_extraction_reserve(p_key uuid,p_job uuid,p_batch uuid,p_revision integer,p_hash text,p_sku text,p_url text,p_host text,p_selection jsonb,p_input_bound integer) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare b jsonb; c public.market_extraction_policy%rowtype; j public.market_extraction_jobs%rowtype; s jsonb;
 iid uuid; reserve numeric; total numeric; today numeric; count_today integer;
begin
 perform pg_advisory_xact_lock(81734001);
 b:=market_research_access(p_key,'market-research:extract'); iid:=(b->>'id')::uuid;
 if not p_sku=any(array(select jsonb_array_elements_text(b->'allowed_skus'))) then raise exception 'Forbidden SKU' using errcode='42501'; end if;
 update market_extraction_jobs set state='unknown',error_code='LEASE_EXPIRED',finished_at=clock_timestamp() where state='running' and created_at<clock_timestamp()-interval '2 minutes';
 select * into j from market_extraction_jobs where integration_id=iid and job_id=p_job;
 if found then
  if j.request_hash<>p_hash then raise exception 'Job conflict' using errcode='23505'; end if;
  select selection into s from market_extraction_batches where integration_id=iid and batch_id=j.batch_id;
  return jsonb_build_object('created',false,'job',to_jsonb(j)-'ticket'-'request_hash'-'integration_id','selection',s);
 end if;
 select * into c from market_extraction_policy where id;
 if not c.enabled or c.approved_until is null or c.approved_until<=clock_timestamp() then raise exception 'Pilot disabled' using errcode='55000'; end if;
 if not p_host=any(c.public_hosts) then raise exception 'Source not authorized' using errcode='42501'; end if;
 select selection into s from market_extraction_batches where integration_id=iid and batch_id=p_batch;
 if not found then
  if c.revision<>p_revision or p_selection->>'choice'<>c.choice then raise exception 'Selection changed' using errcode='40001'; end if;
  s:=p_selection||jsonb_build_object('revision',c.revision);
 else
  if (s->>'revision')::integer<>p_revision then raise exception 'Batch selection conflict' using errcode='40001'; end if;
 end if;
 if p_input_bound not between 4096 and 28000 or (s->>'input_usd_per_million')::numeric<=0 or (s->>'output_usd_per_million')::numeric<=0 then raise exception 'Invalid reservation' using errcode='22023'; end if;
 reserve:=(p_input_bound*(s->>'input_usd_per_million')::numeric+1024*(s->>'output_usd_per_million')::numeric)/1000000;
 if reserve is null or reserve<=0 then raise exception 'Unknown tariff' using errcode='55000'; end if;
 if exists(select 1 from market_extraction_jobs where state='running') then raise exception 'Busy' using errcode='P0002'; end if;
 select coalesce(sum(coalesce(estimated_usd,reserved_usd)),0),coalesce(sum(coalesce(estimated_usd,reserved_usd)) filter(where created_at>=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')),0),count(*) filter(where created_at>=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')) into total,today,count_today from market_extraction_jobs;
 if total+reserve>c.pilot_usd or today+reserve>c.daily_usd or count_today>=c.daily_jobs then raise exception 'Pilot budget or quota exhausted' using errcode='P0002'; end if;
 insert into market_extraction_batches(integration_id,batch_id,selection) values(iid,p_batch,s) on conflict do nothing;
 insert into market_extraction_jobs(integration_id,job_id,batch_id,request_hash,sku,source_url,state,reserved_usd) values(iid,p_job,p_batch,p_hash,p_sku,p_url,'running',reserve) returning * into j;
 return jsonb_build_object('created',true,'ticket',j.ticket,'integration_id',iid,'job',to_jsonb(j)-'ticket'-'request_hash'-'integration_id','selection',s);
end $$;

create function public.market_extraction_finish(p_integration uuid,p_job uuid,p_ticket uuid,p_state text,p_attributes jsonb,p_input integer,p_output integer,p_cost numeric,p_error text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare j public.market_extraction_jobs%rowtype;
begin
 perform pg_advisory_xact_lock(81734001);
 select * into j from market_extraction_jobs where integration_id=p_integration and job_id=p_job for update;
 if not found or j.ticket<>p_ticket then raise exception 'Forbidden receipt' using errcode='42501'; end if;
 if j.state<>'running' then return to_jsonb(j)-'ticket'-'request_hash'-'integration_id'; end if;
 if p_state not in ('completed','failed','unknown') or jsonb_typeof(p_attributes)<>'array' or jsonb_array_length(p_attributes)>9 or p_input<0 or p_output<0 or p_cost<0 or p_cost>j.reserved_usd then raise exception 'Invalid outcome' using errcode='22023'; end if;
 -- Ambiguous and failed calls retain the complete reservation; no automatic refunds/retry.
 update market_extraction_jobs set state=p_state,attributes=case when p_state='completed' then p_attributes else '[]' end,
 input_tokens=p_input,output_tokens=p_output,estimated_usd=case when p_state='completed' then p_cost else null end,
 error_code=p_error,finished_at=clock_timestamp() where integration_id=p_integration and job_id=p_job returning * into j;
 return to_jsonb(j)-'ticket'-'request_hash'-'integration_id';
end $$;
revoke all on function public.market_extraction_select(uuid,integer,text),public.market_extraction_reserve(uuid,uuid,uuid,integer,text,text,text,text,jsonb,integer),public.market_extraction_finish(uuid,uuid,uuid,text,jsonb,integer,integer,numeric,text) from public,anon,authenticated;
grant execute on function public.market_extraction_select(uuid,integer,text),public.market_extraction_reserve(uuid,uuid,uuid,integer,text,text,text,text,jsonb,integer),public.market_extraction_finish(uuid,uuid,uuid,text,jsonb,integer,integer,numeric,text) to service_role;
-- Human administration only, through the authenticated market-study handler.
-- Reuses existing key lifecycle RPCs; never grants this operation to a worker.
grant execute on function public.create_agent_api_key(text,text[],timestamptz),public.revoke_agent_api_key(uuid) to service_role;
grant insert,update on public.market_research_integrations to service_role;
create function public.market_research_admin(p_actor uuid,p_action text,p_config jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare c public.market_extraction_policy%rowtype; k record; iid uuid; expiry timestamptz; skus text[]; items jsonb; snapshot jsonb; usage jsonb;
 scopes text[]:=array['market-research:catalog:read','market-research:extract','market-research:observations:write'];
begin
 perform pg_advisory_xact_lock(81734001);
 perform 1 from profiles where id=p_actor and role='administrador' and active;
 if not found then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into c from market_extraction_policy where id=true for update;
 snapshot:=jsonb_build_object('revision',c.revision,'choice',c.choice,'public_hosts',c.public_hosts,'daily_usd',c.daily_usd,'pilot_usd',c.pilot_usd,'daily_jobs',c.daily_jobs,'approved_until',c.approved_until);
 if p_action='list' then
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'provider',i.provider,'skus',i.allowed_skus,'expires_at',i.expires_at,'active',i.active and a.active and a.revoked_at is null and i.expires_at>clock_timestamp(),'key_prefix',a.key_prefix) order by i.authorized_at desc),'[]') into items from market_research_integrations i join agent_api_keys a on a.id=i.api_key_id;
  select jsonb_build_object('jobs',count(*),'unknown_jobs',count(*) filter(where state='unknown'),'estimated_usd',coalesce(sum(estimated_usd),0),'held_usd',coalesce(sum(case when estimated_usd is null then reserved_usd else 0 end),0),'last_job_at',max(created_at),'skus',coalesce(jsonb_agg(distinct sku),'[]')) into usage from market_extraction_jobs;
  return jsonb_build_object('schema_version',1,'policy',snapshot,'scopes',scopes,'integrations',items,'usage',usage);
 elsif p_action='revoke' then
  if p_config is null or p_config->>'confirm' is distinct from 'REVOKE' or (select count(*) from jsonb_object_keys(p_config))<>2 then raise exception 'Confirmation required'; end if;
  select api_key_id into iid from market_research_integrations where id=(p_config->>'id')::uuid for update;
  if not found then raise exception 'Unknown integration'; end if;
  perform public.revoke_agent_api_key(iid);
  update market_research_integrations set active=false where api_key_id=iid;
  return jsonb_build_object('revoked',true);
 elsif p_action='create' then
  if p_config is null or p_config->>'confirm' is distinct from 'CREATE' or p_config->>'secure_destination_ready' is distinct from 'true' or (select count(*) from jsonb_object_keys(p_config))<>7 then raise exception 'Explicit confirmation required'; end if;
  if p_config->'policy' is distinct from snapshot then raise exception 'Policy changed'; end if;
  if cardinality(c.public_hosts)=0 or c.daily_usd>0.25 or c.pilot_usd>0.25 or c.daily_jobs>10 or c.choice not like 'deepseek:%' then raise exception 'Approved pilot configuration missing'; end if;
  expiry:=(p_config->>'expires_at')::timestamptz;
  if expiry is null or expiry<=clock_timestamp() or expiry>clock_timestamp()+interval '1 hour' or expiry>((date_trunc('day',clock_timestamp() at time zone 'UTC')+interval '1 day') at time zone 'UTC') or c.approved_until is null or expiry>c.approved_until then raise exception 'Invalid expiry'; end if;
  if coalesce(p_config->>'provider','') !~ '^market-worker-[a-z0-9-]{1,50}$' then raise exception 'Invalid provider'; end if;
  select array_agg(v) into skus from jsonb_array_elements_text(p_config->'skus') v;
  if skus is null or cardinality(skus) not between 1 and 3 or (select count(distinct v) from unnest(skus) v)<>cardinality(skus) then raise exception 'Invalid SKUs'; end if;
  iid:=(p_config->>'request_id')::uuid;
  if iid is null or exists(select 1 from market_research_integrations where id=iid or provider=p_config->>'provider') then raise exception 'Already requested; list and revoke if needed'; end if;
  select * into k from public.create_agent_api_key(p_config->>'provider',scopes,expiry);
  insert into market_research_integrations(id,api_key_id,provider,allowed_skus,active,expires_at,authorized_by) values(iid,k.id,p_config->>'provider',skus,true,expiry,p_actor);
  -- Reuse the exact published catalog rules. A rejection rolls back key AND binding.
  if (public.market_research_catalog(k.id)->>'unavailable_skus')::integer<>0 then raise exception 'SKU missing or ambiguous'; end if;
  return jsonb_build_object('id',iid,'api_key',k.api_key,'expires_at',expiry);
 end if;
 raise exception 'Unknown action';
end $$;
revoke all on function public.market_research_admin(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.market_research_admin(uuid,text,jsonb) to service_role;
commit;
