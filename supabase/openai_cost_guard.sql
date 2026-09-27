-- Additive, isolated metering. Does not modify CRM business tables or their RLS.
begin;
create table if not exists public.openai_cost_policy (
  id boolean primary key default true check (id),
  mode text check (mode in ('luna_only','auto','sol_manual')),
  mode_expires_at timestamptz,
  quota_blocked boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into public.openai_cost_policy(id) values(true) on conflict do nothing;
create table if not exists public.openai_call_usage (
  id uuid primary key,
  created_at timestamptz not null default now(),
  business_day date not null default (now() at time zone 'America/Santiago')::date,
  request_id text not null,
  conversation_id text,
  user_id text,
  agent text not null,
  model text not null,
  tier text not null check (tier in ('luna','sol')),
  status text not null default 'reserved' check(status in ('reserved','succeeded','failed','unknown')),
  reserved_usd numeric not null check(reserved_usd >= 0),
  estimated_cost numeric not null check(estimated_cost >= 0),
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  latency_ms bigint not null default 0,
  tool_calls integer not null default 0,
  escalation_reason text,
  source_model text,
  estimated_complexity text,
  error_code text,
  finished_at timestamptz
);
create index if not exists openai_call_usage_day_idx on public.openai_call_usage(business_day, tier);
create index if not exists openai_call_usage_request_idx on public.openai_call_usage(request_id, tier);
create index if not exists openai_call_usage_session_idx on public.openai_call_usage(conversation_id, created_at desc);
alter table public.openai_cost_policy enable row level security;
alter table public.openai_call_usage enable row level security;
revoke all on public.openai_cost_policy, public.openai_call_usage from anon, authenticated;
grant all on public.openai_cost_policy, public.openai_call_usage to service_role;

create or replace function public.openai_cost_reserve(p jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  config public.openai_cost_policy;
  day date := (now() at time zone 'America/Santiago')::date;
  spent numeric; sol_spent numeric;
  budget numeric := nullif(p->>'budget','')::numeric;
  sol_budget numeric := coalesce(nullif(p->>'sol_budget','')::numeric,budget);
  amount numeric := (p->>'reservation')::numeric;
  selected_mode text := p->>'mode';
  sol_count int; call_count int;
begin
  -- Serializes reservations across users, workers and parallel specialists.
  select * into config from public.openai_cost_policy where id=true for update;
  if not found then
    return jsonb_build_object('allowed',false,'code','AI_COST_GUARD_UNAVAILABLE','message','Falta la politica central de gasto. Nuevas llamadas suspendidas.');
  end if;
  if config.quota_blocked then
    return jsonb_build_object('allowed',false,'code','AI_QUOTA_EXHAUSTED','message','OpenAI sin saldo/cuota. Nuevas llamadas suspendidas; Administracion debe revisar la facturacion antes de rehabilitar la API.');
  end if;
  if amount is null or amount < 0 or amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid reservation'; end if;
  if exists(select 1 from public.openai_call_usage where id=(p->>'id')::uuid) then
    return jsonb_build_object('allowed',false,'code','AI_DUPLICATE_CALL','message','La llamada ya fue reservada. No se repetira.');
  end if;
  if selected_mode <> 'luna_only' and config.mode_expires_at > now() and config.mode is not null then
    if selected_mode='sol_manual' and config.mode='auto' then null; else selected_mode:=config.mode; end if;
  end if;
  if p->>'tier'='sol' and (selected_mode='luna_only' or (selected_mode='sol_manual' and p->>'escalation_reason' is distinct from 'explicit_user')) then
    return jsonb_build_object('allowed',false,'code','AI_SOL_DISABLED','message','Sol deshabilitado por la politica actual. Se conserva la respuesta de Luna.');
  end if;
  select count(*), count(*) filter(where tier='sol') into call_count,sol_count from public.openai_call_usage where request_id=p->>'request_id';
  if call_count >= least(64,coalesce((p->>'max_calls')::int,32)) then
    return jsonb_build_object('allowed',false,'code','AI_REQUEST_LIMIT','message','Limite de llamadas por consulta alcanzado.');
  end if;
  if p->>'tier'='sol' and sol_count >= least(1,coalesce((p->>'max_sol')::int,1)) then
    return jsonb_build_object('allowed',false,'code','AI_SOL_LIMIT','message','La consulta ya uso su unico escalamiento a Sol.');
  end if;
  select coalesce(sum(estimated_cost),0),coalesce(sum(estimated_cost) filter(where tier='sol'),0) into spent,sol_spent from public.openai_call_usage where business_day=day;
  if coalesce((p->>'guard_enabled')::boolean,true) then
    if budget is null or budget <= 0 then
      return jsonb_build_object('allowed',false,'code','AI_BUDGET_UNCONFIGURED','message','Falta configurar DAILY_OPENAI_BUDGET_USD. No se consumiran creditos hasta autorizar un presupuesto.');
    end if;
    if spent+amount > budget then
      return jsonb_build_object('allowed',false,'code','AI_BUDGET_LIMIT','message','Presupuesto diario de OpenAI agotado o insuficiente para reservar esta llamada.');
    end if;
    if p->>'tier'='sol' and sol_spent+amount > sol_budget then
      return jsonb_build_object('allowed',false,'code','AI_SOL_BUDGET_LIMIT','message','Sol deshabilitado temporalmente por limite de presupuesto. Luna conserva su presupuesto restante.');
    end if;
  end if;
  -- Persists escalation reason BEFORE the provider request, not after success.
  insert into public.openai_call_usage(id,request_id,conversation_id,user_id,agent,model,tier,reserved_usd,estimated_cost,escalation_reason,source_model,estimated_complexity)
  values((p->>'id')::uuid,p->>'request_id',p->>'conversation_id',p->>'user_id',p->>'agent',p->>'model',p->>'tier',amount,amount,p->>'escalation_reason',p->>'source_model',p->>'estimated_complexity');
  return jsonb_build_object('allowed',true,'mode',selected_mode,'warning',case when budget > 0 and (spent+amount)/budget*100 >= coalesce((p->>'warning_percent')::numeric,70) then 'OpenAI cerca del presupuesto diario; incluye reservas de llamadas en curso.' end);
end $$;

create or replace function public.openai_cost_finish(p jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.openai_cost_policy where id=true for update;
  if p->>'error_code'='AI_QUOTA_EXHAUSTED' then
    update public.openai_cost_policy set quota_blocked=true,updated_at=now() where id=true;
  end if;
  update public.openai_call_usage set
    status=p->>'status', finished_at=now(),
    estimated_cost=greatest(0,(p->>'estimated_cost')::numeric),
    input_tokens=greatest(0,coalesce((p->>'input_tokens')::bigint,0)), output_tokens=greatest(0,coalesce((p->>'output_tokens')::bigint,0)),
    total_tokens=greatest(0,coalesce((p->>'total_tokens')::bigint,0)), reasoning_tokens=greatest(0,coalesce((p->>'reasoning_tokens')::bigint,0)),
    latency_ms=greatest(0,coalesce((p->>'latency_ms')::bigint,0)), tool_calls=greatest(0,coalesce((p->>'tool_calls')::int,0)), error_code=p->>'error_code'
  where id=(p->>'id')::uuid and status='reserved';
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.openai_cost_summary(p jsonb) returns jsonb
language sql security definer set search_path=public,pg_temp as $$
  with today as (select * from public.openai_call_usage where business_day=(now() at time zone 'America/Santiago')::date),
  totals as (select count(*) calls,coalesce(sum(estimated_cost),0) cost,count(*) filter(where status in ('reserved','unknown')) uncertain from today),
  models as (select tier,model,count(*) calls,coalesce(sum(estimated_cost),0) cost,coalesce(sum(total_tokens),0) tokens from today group by tier,model),
  agents as (select agent,count(*) calls,coalesce(sum(estimated_cost),0) cost from today group by agent),
  conversations as (select conversation_id,count(*) calls,coalesce(sum(estimated_cost),0) cost from today group by conversation_id order by cost desc limit 100)
  select jsonb_build_object('day',(now() at time zone 'America/Santiago')::date,'timezone','America/Santiago',
    'totals',(select to_jsonb(t) from totals t),'models',coalesce((select jsonb_agg(m) from models m),'[]'::jsonb),
    'agents',coalesce((select jsonb_agg(a) from agents a),'[]'::jsonb),'conversations',coalesce((select jsonb_agg(c) from conversations c),'[]'::jsonb),
    'policy',(select jsonb_build_object('mode',case when mode_expires_at>now() then mode end,'expires_at',mode_expires_at,'quota_blocked',quota_blocked) from public.openai_cost_policy where id),
    'budget',p->'budget','sol_budget',p->'sol_budget','warning_percent',p->'warning_percent',
    'warning',case when (p->>'budget')::numeric > 0 and (select cost from totals)/(p->>'budget')::numeric*100 >= (p->>'warning_percent')::numeric then 'Presupuesto diario cerca del limite o agotado.' end,
    'errors',coalesce((select jsonb_agg(e) from (select created_at,agent,model,error_code from public.openai_call_usage where error_code is not null order by created_at desc limit 10) e),'[]'::jsonb));
$$;

create or replace function public.openai_cost_set_mode(p jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p->>'mode' not in ('luna_only','auto','sol_manual','resume_after_quota') then raise exception 'Invalid mode'; end if;
  if p->>'mode'='resume_after_quota' then
    update public.openai_cost_policy set quota_blocked=false,updated_by=(p->>'actor')::uuid,updated_at=now() where id;
  else
    update public.openai_cost_policy set mode=p->>'mode',mode_expires_at=now()+make_interval(hours=>greatest(1,least(24,(p->>'hours')::int))),updated_by=(p->>'actor')::uuid,updated_at=now() where id;
  end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.openai_cost_reserve(jsonb), public.openai_cost_finish(jsonb), public.openai_cost_summary(jsonb), public.openai_cost_set_mode(jsonb) from public,anon,authenticated;
grant execute on function public.openai_cost_reserve(jsonb), public.openai_cost_finish(jsonb), public.openai_cost_summary(jsonb), public.openai_cost_set_mode(jsonb) to service_role;
commit;
notify pgrst,'reload schema';
