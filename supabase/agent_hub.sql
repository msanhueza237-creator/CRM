-- Clima Activa Agent Hub v1
-- Ejecutar una sola vez en Supabase SQL Editor antes del redeploy del CRM.
-- Las integraciones Facto/Tiendanube permanecen en modo lectura y sus secretos
-- nunca se almacenan en estas tablas.

create extension if not exists pgcrypto;

create table if not exists public.integration_connections (
  provider text primary key check (provider in ('facto','tiendanube','gmail','brave','meta_whatsapp')),
  enabled boolean not null default false,
  read_only boolean not null default true,
  status text not null default 'pending_configuration'
    check (status in ('pending_configuration','checking','connected','degraded','error','disabled')),
  message text,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.integration_connections(provider, enabled, read_only, status, message)
values
  ('facto', false, true, 'pending_configuration', 'Credenciales pendientes en Agent Hub'),
  ('tiendanube', false, true, 'pending_configuration', 'Credenciales pendientes en Agent Hub'),
  ('gmail', true, false, 'connected', 'Integracion existente'),
  ('brave', true, true, 'connected', 'Integracion existente'),
  ('meta_whatsapp', false, false, 'disabled', 'Pendiente de aprobacion de Meta')
on conflict (provider) do nothing;

create table if not exists public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null references public.integration_connections(provider),
  resource text not null,
  status text not null default 'pending'
    check (status in ('pending','running','completed','partial','failed')),
  read_count integer not null default 0 check (read_count >= 0),
  written_count integer not null default 0 check (written_count >= 0),
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.integration_records (
  id uuid primary key default gen_random_uuid(),
  provider text not null references public.integration_connections(provider),
  resource text not null,
  external_id text not null,
  payload jsonb not null,
  payload_hash text not null,
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, resource, external_id)
);

create index if not exists integration_records_resource_idx
  on public.integration_records(provider, resource, updated_at desc);

create table if not exists public.business_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_type text not null check (agent_type in
    ('commercial','marketing','finance','collections','foreign_trade','executive')),
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','in_progress','completed','failed','cancelled')),
  priority smallint not null default 50 check (priority between 0 and 100),
  requested_by uuid references auth.users(id),
  worker_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists business_agent_tasks_claim_idx
  on public.business_agent_tasks(status, priority desc, created_at);

create table if not exists public.agent_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.business_agent_tasks(id) on delete cascade,
  level text not null default 'info' check (level in ('debug','info','warning','error')),
  stage text not null,
  message text not null,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.action_proposals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.business_agent_tasks(id) on delete set null,
  kind text not null check (kind in
    ('campaign_draft','collection_reminder','purchase_order','commercial_follow_up','executive_alert')),
  title text not null,
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  risk_level text not null default 'medium' check (risk_level in ('low','medium','high','critical')),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','executed','cancelled')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  decision_note text
);

create table if not exists public.action_approvals (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.action_proposals(id) on delete cascade,
  decision text not null check (decision in ('approved','rejected')),
  decided_by uuid not null references auth.users(id),
  note text,
  decided_at timestamptz not null default now()
);

create unique index if not exists action_approvals_one_decision_idx
  on public.action_approvals(proposal_id);

create table if not exists public.foreign_trade_purchase_drafts (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null unique references public.action_proposals(id) on delete cascade,
  supplier text not null default 'Chinafore',
  title text not null,
  suggested_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'approved_for_preparation'
    check (status in ('approved_for_preparation','under_review','ready_to_order','cancelled','converted')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(suggested_snapshot) = 'object')
);

create table if not exists public.agent_action_items (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null unique references public.action_proposals(id) on delete cascade,
  kind text not null,
  destination_module text not null
    check (destination_module in ('campaigns','collections','foreign_trade','commercial','executive')),
  destination_path text not null,
  destination_record_id uuid,
  title text not null,
  summary text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending_review'
    check (status in ('draft','pending_review','completed','cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(payload) = 'object')
);

create index if not exists agent_action_items_created_idx
  on public.agent_action_items(created_at desc);
create index if not exists agent_action_items_status_idx
  on public.agent_action_items(status, destination_module);
create index if not exists foreign_trade_purchase_drafts_created_idx
  on public.foreign_trade_purchase_drafts(created_at desc);

create table if not exists public.business_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

insert into public.business_settings(key,value,description) values
 ('foreign_trade.production_days','45','Dias de produccion en fabrica china'),
 ('foreign_trade.sea_travel_days','45','Dias de viaje internacional'),
 ('foreign_trade.customs_delay_days','5','Holgura de aduana y recepcion'),
 ('foreign_trade.safety_stock_days','30','Stock de seguridad'),
 ('foreign_trade.review_period_days','30','Periodo de revision de compra'),
 ('foreign_trade.target_coverage_days','155','Cobertura objetivo'),
 ('foreign_trade.factory_shutdown_months','[2]','Pausa productiva china configurable'),
 ('foreign_trade.high_season_months','[11,12,1,2]','Temporada alta de Clima Activa'),
 ('foreign_trade.purchase_target_min_usd','50000','Rango objetivo inferior por orden'),
 ('foreign_trade.purchase_hard_max_usd','70000','Maximo duro por orden'),
 ('foreign_trade.nearby_order_window_days','30','Ventana para detectar division de orden')
on conflict (key) do nothing;

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country_code text not null default 'CN',
  factory_city text,
  default_production_days integer not null default 45,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.supplier_products (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  sku text not null,
  supplier_sku text,
  unit_cost_usd numeric(14,4) not null default 0,
  minimum_order_qty numeric(14,2) not null default 0,
  production_days integer,
  active boolean not null default true,
  unique(supplier_id, sku)
);

create table if not exists public.import_shipments (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.suppliers(id),
  reference text not null unique,
  transport_type text not null default 'sea',
  origin_port text,
  destination_port text,
  order_date date,
  production_ready_date date,
  estimated_departure date,
  estimated_arrival date,
  customs_release_date date,
  warehouse_receipt_date date,
  status text not null default 'planned'
    check (status in ('planned','production','ready','in_transit','customs','received','delayed','cancelled')),
  value_usd numeric(14,2) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shipment_milestones (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.import_shipments(id) on delete cascade,
  milestone text not null,
  expected_at timestamptz,
  occurred_at timestamptz,
  status text not null default 'pending',
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.demand_forecasts (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  period_start date not null,
  period_end date not null,
  expected_units numeric(14,2) not null,
  source text not null default 'agent',
  confidence numeric(5,2),
  assumptions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(sku, period_start, period_end)
);

create table if not exists public.replenishment_recommendations (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.business_agent_tasks(id),
  sku text not null,
  available_units numeric(14,2) not null,
  committed_units numeric(14,2) not null default 0,
  confirmed_inbound_units numeric(14,2) not null default 0,
  reorder_point_units numeric(14,2) not null,
  target_units numeric(14,2) not null,
  recommended_units numeric(14,2) not null,
  recommended_value_usd numeric(14,2) not null,
  required_order_date date,
  projected_stockout_date date,
  severity text not null check (severity in ('low','medium','high','critical')),
  purchase_policy text not null,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_risk_alerts (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  severity text not null check (severity in ('low','medium','high','critical')),
  title text not null,
  detail text not null,
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  recommendation_id uuid references public.replenishment_recommendations(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create or replace function public.claim_business_agent_task(
  p_worker_id text, p_lease_seconds integer default 120
) returns table(task jsonb, lease_token uuid, lease_expires_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_task public.business_agent_tasks%rowtype; v_token uuid := gen_random_uuid();
begin
  select bat.* into v_task from public.business_agent_tasks as bat
   where bat.status='pending'
      or (bat.status='in_progress' and bat.lease_expires_at < now())
   order by bat.priority desc, bat.created_at
   for update skip locked limit 1;
  if not found then return; end if;
  update public.business_agent_tasks as bat set
    status='in_progress', worker_id=p_worker_id, lease_token=v_token,
    lease_expires_at=now()+make_interval(secs=>greatest(30,p_lease_seconds)),
    attempts=attempts+1, started_at=coalesce(started_at,now()), updated_at=now()
  where bat.id=v_task.id
  returning to_jsonb(bat.*), bat.lease_token, bat.lease_expires_at
  into task, lease_token, lease_expires_at;
  return next;
end $$;

create or replace function public.heartbeat_business_agent_task(
 p_task_id uuid,p_worker_id text,p_lease_token uuid,p_lease_seconds integer default 120
) returns timestamptz language plpgsql security definer set search_path=public,pg_temp as $$
declare v_expiry timestamptz;
begin
 update public.business_agent_tasks set
   lease_expires_at=now()+make_interval(secs=>greatest(30,p_lease_seconds)),updated_at=now()
 where id=p_task_id and status='in_progress' and worker_id=p_worker_id
   and lease_token=p_lease_token and lease_expires_at>now()
 returning lease_expires_at into v_expiry;
 if v_expiry is null then raise exception 'lease_lost'; end if;
 return v_expiry;
end $$;

create or replace function public.complete_business_agent_task(
 p_task_id uuid,p_worker_id text,p_lease_token uuid,p_result jsonb
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_proposal jsonb;
begin
 update public.business_agent_tasks set status='completed',result=p_result,
   completed_at=now(),updated_at=now(),lease_expires_at=null
 where id=p_task_id and status='in_progress' and worker_id=p_worker_id and lease_token=p_lease_token;
 if not found then raise exception 'lease_lost'; end if;
 for v_proposal in select value from jsonb_array_elements(coalesce(p_result->'proposals','[]'::jsonb))
 loop
   insert into public.action_proposals(task_id,kind,title,summary,payload,risk_level)
   values(p_task_id,v_proposal->>'kind',v_proposal->>'title',v_proposal->>'summary',
     coalesce(v_proposal->'payload','{}'::jsonb),coalesce(v_proposal->>'risk_level','medium'));
 end loop;
end $$;

create or replace function public.fail_business_agent_task(
 p_task_id uuid,p_worker_id text,p_lease_token uuid,p_error text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update public.business_agent_tasks set status='failed',error_code=left(p_error,200),
   completed_at=now(),updated_at=now(),lease_expires_at=null
 where id=p_task_id and status='in_progress' and worker_id=p_worker_id and lease_token=p_lease_token;
 if not found then raise exception 'lease_lost'; end if;
end $$;

drop function if exists public.decide_action_proposal(uuid,text,text);

create function public.decide_action_proposal(
 p_proposal_id uuid,p_decision text,p_note text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_proposal public.action_proposals%rowtype;
 v_campaign_id uuid; v_purchase_draft_id uuid; v_task_id uuid; v_action_item_id uuid;
 v_destination_module text; v_destination_path text; v_destination_record_id uuid;
 v_action_status text := 'pending_review'; v_message text; v_channel text;
 v_campaign_type public.campaign_type; v_campaign_message text; v_product text;
 v_recipient_count integer := 0;
begin
 if public.current_role() <> 'administrador' then raise exception 'forbidden'; end if;
 if p_decision not in ('approved','rejected') then raise exception 'invalid_decision'; end if;

 select * into v_proposal from public.action_proposals
 where id=p_proposal_id and status='pending' for update;
 if not found then raise exception 'proposal_not_pending'; end if;

 insert into public.action_approvals(proposal_id,decision,decided_by,note)
 values(p_proposal_id,p_decision,auth.uid(),p_note);
 update public.action_proposals set status=p_decision,decided_by=auth.uid(),
   decision_note=p_note,decided_at=now() where id=p_proposal_id;

 if p_decision='rejected' then
   return jsonb_build_object('decision','rejected','proposal_id',p_proposal_id,
     'message','Propuesta rechazada y registrada en el historial.');
 end if;

 if v_proposal.kind='campaign_draft' then
   v_channel := lower(coalesce(v_proposal.payload->>'channel','email'));
   v_campaign_type := case
     when v_channel like '%mixta%' or (v_channel like '%email%' and v_channel like '%whatsapp%') then 'mixta'::public.campaign_type
     when v_channel like '%whatsapp%' then 'whatsapp'::public.campaign_type
     else 'email'::public.campaign_type end;
   v_campaign_message := coalesce(nullif(v_proposal.payload->>'email_body',''),
     nullif(v_proposal.payload->>'whatsapp_body',''),nullif(v_proposal.payload->>'message',''),v_proposal.summary);
   v_product := case when jsonb_typeof(v_proposal.payload->'product')='object'
     then coalesce(v_proposal.payload->'product'->>'name',v_proposal.payload->'product'->>'sku')
     else nullif(v_proposal.payload->>'product','') end;

   insert into public.campaigns(name,type,segment,message,product,coupon,status,created_by)
   values(v_proposal.title,v_campaign_type,
     coalesce(v_proposal.payload->>'segment_name',v_proposal.payload->>'segment','Propuesta de agente'),
     v_campaign_message,v_product,coalesce(v_proposal.payload->>'benefit',v_proposal.payload->>'coupon'),
     'borrador',auth.uid()) returning id into v_campaign_id;

   insert into public.campaign_recipients(campaign_id,company_id,rendered_message)
   select v_campaign_id,c.id,v_campaign_message
   from jsonb_array_elements_text(coalesce(v_proposal.payload->'company_ids','[]'::jsonb)) ids(value)
   join public.companies c on c.id::text=ids.value
   on conflict do nothing;
   get diagnostics v_recipient_count=row_count;

   v_destination_module:='campaigns'; v_destination_path:='/campanas';
   v_destination_record_id:=v_campaign_id; v_action_status:='draft';
   v_message:=format('Borrador creado en Campanas con %s empresa(s) CRM. Debe revisarse antes de enviar.',v_recipient_count);
 elsif v_proposal.kind='purchase_order' then
   insert into public.foreign_trade_purchase_drafts(proposal_id,supplier,title,suggested_snapshot,created_by)
   values(v_proposal.id,coalesce(v_proposal.payload->>'supplier','Chinafore'),v_proposal.title,v_proposal.payload,auth.uid())
   returning id into v_purchase_draft_id;
   v_destination_module:='foreign_trade'; v_destination_path:='/agentes/foreign_trade/dashboard';
   v_destination_record_id:=v_purchase_draft_id;
   v_message:='Compra aprobada para preparacion en Comercio Exterior. No se emitio ninguna orden al proveedor.';
 elsif v_proposal.kind='collection_reminder' then
   insert into public.tasks(owner_id,title,description,due_date)
   values(auth.uid(),v_proposal.title,v_proposal.summary||E'\n\nEvidencia: '||v_proposal.payload::text,current_date+1)
   returning id into v_task_id;
   v_destination_module:='collections'; v_destination_path:='/agentes/collections/dashboard';
   v_destination_record_id:=v_task_id;
   v_message:='Seguimiento de cobranza creado como tarea para revision. No se envio ningun recordatorio.';
 elsif v_proposal.kind='commercial_follow_up' then
   insert into public.tasks(owner_id,title,description,due_date)
   values(auth.uid(),v_proposal.title,v_proposal.summary||E'\n\nEvidencia: '||v_proposal.payload::text,current_date+3)
   returning id into v_task_id;
   v_destination_module:='commercial'; v_destination_path:='/agentes/commercial/dashboard';
   v_destination_record_id:=v_task_id; v_message:='Seguimiento comercial creado como tarea pendiente.';
 elsif v_proposal.kind='executive_alert' then
   insert into public.tasks(owner_id,title,description,due_date)
   values(auth.uid(),v_proposal.title,v_proposal.summary||E'\n\nEvidencia: '||v_proposal.payload::text,current_date)
   returning id into v_task_id;
   v_destination_module:='executive'; v_destination_path:='/agentes/executive/dashboard';
   v_destination_record_id:=v_task_id; v_message:='Decision gerencial registrada como tarea prioritaria.';
 else
   raise exception 'unsupported_proposal_kind: %',v_proposal.kind;
 end if;

 insert into public.agent_action_items(proposal_id,kind,destination_module,destination_path,
   destination_record_id,title,summary,payload,status,created_by)
 values(v_proposal.id,v_proposal.kind,v_destination_module,v_destination_path,v_destination_record_id,
   v_proposal.title,v_message,v_proposal.payload,v_action_status,auth.uid())
 returning id into v_action_item_id;

 insert into public.activity_logs(actor_id,entity_type,entity_id,action,metadata)
 values(auth.uid(),'agent_action_item',v_action_item_id,'approved_and_materialized',
   jsonb_build_object('proposal_id',v_proposal.id,'kind',v_proposal.kind,
     'destination_module',v_destination_module,'destination_record_id',v_destination_record_id));

 return jsonb_build_object('decision','approved','proposal_id',p_proposal_id,
   'action_item_id',v_action_item_id,'destination_module',v_destination_module,
   'destination_path',v_destination_path,'destination_record_id',v_destination_record_id,'message',v_message);
end $$;

alter table public.integration_connections enable row level security;
alter table public.integration_sync_runs enable row level security;
alter table public.integration_records enable row level security;
alter table public.business_agent_tasks enable row level security;
alter table public.agent_task_events enable row level security;
alter table public.action_proposals enable row level security;
alter table public.action_approvals enable row level security;
alter table public.agent_action_items enable row level security;
alter table public.foreign_trade_purchase_drafts enable row level security;
alter table public.business_settings enable row level security;
alter table public.suppliers enable row level security;
alter table public.supplier_products enable row level security;
alter table public.import_shipments enable row level security;
alter table public.shipment_milestones enable row level security;
alter table public.demand_forecasts enable row level security;
alter table public.replenishment_recommendations enable row level security;
alter table public.inventory_risk_alerts enable row level security;

do $$ declare t text;
begin
 foreach t in array array[
  'integration_connections','integration_sync_runs','integration_records','business_agent_tasks','agent_task_events',
  'action_proposals','action_approvals','agent_action_items','foreign_trade_purchase_drafts',
  'business_settings','suppliers','supplier_products',
  'import_shipments','shipment_milestones','demand_forecasts','replenishment_recommendations',
  'inventory_risk_alerts'
 ] loop
  execute format('drop policy if exists "authenticated read %s" on public.%I',t,t);
  execute format('create policy "authenticated read %s" on public.%I for select to authenticated using (true)',t,t);
  execute format('drop policy if exists "admins manage %s" on public.%I',t,t);
  execute format('create policy "admins manage %s" on public.%I for all to authenticated using (public.current_role()=''administrador'') with check (public.current_role()=''administrador'')',t,t);
 end loop;
end $$;

grant select on public.integration_connections,public.integration_sync_runs,
 public.integration_records,public.business_agent_tasks,public.agent_task_events,public.action_proposals,
 public.action_approvals,public.agent_action_items,public.foreign_trade_purchase_drafts,
 public.business_settings,public.suppliers,public.supplier_products,
 public.import_shipments,public.shipment_milestones,public.demand_forecasts,
 public.replenishment_recommendations,public.inventory_risk_alerts to authenticated;
grant all on public.integration_connections,public.integration_sync_runs,
 public.integration_records,public.business_agent_tasks,public.agent_task_events,public.action_proposals,
 public.action_approvals,public.agent_action_items,public.foreign_trade_purchase_drafts,
 public.business_settings,public.suppliers,public.supplier_products,
 public.import_shipments,public.shipment_milestones,public.demand_forecasts,
 public.replenishment_recommendations,public.inventory_risk_alerts to service_role;
revoke all on function public.claim_business_agent_task(text,integer) from public;
revoke all on function public.heartbeat_business_agent_task(uuid,text,uuid,integer) from public;
revoke all on function public.complete_business_agent_task(uuid,text,uuid,jsonb) from public;
revoke all on function public.fail_business_agent_task(uuid,text,uuid,text) from public;
grant execute on function public.claim_business_agent_task(text,integer) to service_role;
grant execute on function public.heartbeat_business_agent_task(uuid,text,uuid,integer) to service_role;
grant execute on function public.complete_business_agent_task(uuid,text,uuid,jsonb) to service_role;
grant execute on function public.fail_business_agent_task(uuid,text,uuid,text) to service_role;
grant execute on function public.decide_action_proposal(uuid,text,text) to authenticated;
