-- Materializa las propuestas aprobadas por los agentes en trabajo real y trazable.
-- Ejecutar una vez en Supabase SQL Editor y luego redeploy del CRM.
-- Ninguna accion de este script envia mensajes, cobra clientes ni emite ordenes de compra.

begin;

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

alter table public.foreign_trade_purchase_drafts enable row level security;
alter table public.agent_action_items enable row level security;

drop policy if exists "authenticated read foreign trade purchase drafts" on public.foreign_trade_purchase_drafts;
create policy "authenticated read foreign trade purchase drafts"
on public.foreign_trade_purchase_drafts for select to authenticated using (true);

drop policy if exists "admins manage foreign trade purchase drafts" on public.foreign_trade_purchase_drafts;
create policy "admins manage foreign trade purchase drafts"
on public.foreign_trade_purchase_drafts for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

drop policy if exists "authenticated read agent action items" on public.agent_action_items;
create policy "authenticated read agent action items"
on public.agent_action_items for select to authenticated using (true);

drop policy if exists "admins manage agent action items" on public.agent_action_items;
create policy "admins manage agent action items"
on public.agent_action_items for all to authenticated
using (public.current_role() = 'administrador')
with check (public.current_role() = 'administrador');

grant select on public.foreign_trade_purchase_drafts, public.agent_action_items to authenticated;
grant all on public.foreign_trade_purchase_drafts, public.agent_action_items to service_role;

drop function if exists public.decide_action_proposal(uuid,text,text);

create function public.decide_action_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_proposal public.action_proposals%rowtype;
  v_campaign_id uuid;
  v_purchase_draft_id uuid;
  v_task_id uuid;
  v_action_item_id uuid;
  v_destination_module text;
  v_destination_path text;
  v_destination_record_id uuid;
  v_action_status text := 'pending_review';
  v_message text;
  v_channel text;
  v_campaign_type public.campaign_type;
  v_campaign_message text;
  v_product text;
  v_recipient_count integer := 0;
begin
  if public.current_role() <> 'administrador' then
    raise exception 'forbidden';
  end if;
  if p_decision not in ('approved','rejected') then
    raise exception 'invalid_decision';
  end if;

  select * into v_proposal
  from public.action_proposals
  where id = p_proposal_id and status = 'pending'
  for update;

  if not found then
    raise exception 'proposal_not_pending';
  end if;

  insert into public.action_approvals(proposal_id,decision,decided_by,note)
  values(p_proposal_id,p_decision,auth.uid(),p_note);

  update public.action_proposals
  set status=p_decision, decided_by=auth.uid(), decision_note=p_note, decided_at=now()
  where id=p_proposal_id;

  if p_decision = 'rejected' then
    return jsonb_build_object(
      'decision','rejected',
      'proposal_id',p_proposal_id,
      'message','Propuesta rechazada y registrada en el historial.'
    );
  end if;

  if v_proposal.kind = 'campaign_draft' then
    v_channel := lower(coalesce(v_proposal.payload->>'channel', 'email'));
    v_campaign_type := case
      when v_channel like '%mixta%' or (v_channel like '%email%' and v_channel like '%whatsapp%') then 'mixta'::public.campaign_type
      when v_channel like '%whatsapp%' then 'whatsapp'::public.campaign_type
      else 'email'::public.campaign_type
    end;
    v_campaign_message := coalesce(
      nullif(v_proposal.payload->>'email_body',''),
      nullif(v_proposal.payload->>'whatsapp_body',''),
      nullif(v_proposal.payload->>'message',''),
      v_proposal.summary
    );
    v_product := case
      when jsonb_typeof(v_proposal.payload->'product') = 'object' then
        coalesce(v_proposal.payload->'product'->>'name', v_proposal.payload->'product'->>'sku')
      else nullif(v_proposal.payload->>'product','')
    end;

    insert into public.campaigns(
      name,type,segment,message,product,coupon,status,created_by
    ) values (
      v_proposal.title,
      v_campaign_type,
      coalesce(v_proposal.payload->>'segment_name',v_proposal.payload->>'segment','Propuesta de agente'),
      v_campaign_message,
      v_product,
      coalesce(v_proposal.payload->>'benefit',v_proposal.payload->>'coupon'),
      'borrador',
      auth.uid()
    ) returning id into v_campaign_id;

    insert into public.campaign_recipients(campaign_id,company_id,rendered_message)
    select v_campaign_id,c.id,v_campaign_message
    from jsonb_array_elements_text(coalesce(v_proposal.payload->'company_ids','[]'::jsonb)) as ids(value)
    join public.companies c on c.id::text = ids.value
    on conflict do nothing;
    get diagnostics v_recipient_count = row_count;

    v_destination_module := 'campaigns';
    v_destination_path := '/campanas';
    v_destination_record_id := v_campaign_id;
    v_action_status := 'draft';
    v_message := format(
      'Borrador creado en Campanas con %s empresa(s) CRM. Debe revisarse antes de enviar.',
      v_recipient_count
    );

  elsif v_proposal.kind = 'purchase_order' then
    insert into public.foreign_trade_purchase_drafts(
      proposal_id,supplier,title,suggested_snapshot,created_by
    ) values (
      v_proposal.id,
      coalesce(v_proposal.payload->>'supplier','Chinafore'),
      v_proposal.title,
      v_proposal.payload,
      auth.uid()
    ) returning id into v_purchase_draft_id;

    v_destination_module := 'foreign_trade';
    v_destination_path := '/agentes/foreign_trade/dashboard';
    v_destination_record_id := v_purchase_draft_id;
    v_message := 'Compra aprobada para preparacion en Comercio Exterior. No se emitio ninguna orden al proveedor.';

  elsif v_proposal.kind = 'collection_reminder' then
    insert into public.tasks(owner_id,title,description,due_date)
    values(auth.uid(),v_proposal.title,v_proposal.summary || E'\n\nEvidencia: ' || v_proposal.payload::text,current_date + 1)
    returning id into v_task_id;

    v_destination_module := 'collections';
    v_destination_path := '/agentes/collections/dashboard';
    v_destination_record_id := v_task_id;
    v_message := 'Seguimiento de cobranza creado como tarea para revision. No se envio ningun recordatorio.';

  elsif v_proposal.kind = 'commercial_follow_up' then
    insert into public.tasks(owner_id,title,description,due_date)
    values(auth.uid(),v_proposal.title,v_proposal.summary || E'\n\nEvidencia: ' || v_proposal.payload::text,current_date + 3)
    returning id into v_task_id;

    v_destination_module := 'commercial';
    v_destination_path := '/agentes/commercial/dashboard';
    v_destination_record_id := v_task_id;
    v_message := 'Seguimiento comercial creado como tarea pendiente.';

  elsif v_proposal.kind = 'executive_alert' then
    insert into public.tasks(owner_id,title,description,due_date)
    values(auth.uid(),v_proposal.title,v_proposal.summary || E'\n\nEvidencia: ' || v_proposal.payload::text,current_date)
    returning id into v_task_id;

    v_destination_module := 'executive';
    v_destination_path := '/agentes/executive/dashboard';
    v_destination_record_id := v_task_id;
    v_message := 'Decision gerencial registrada como tarea prioritaria.';
  else
    raise exception 'unsupported_proposal_kind: %', v_proposal.kind;
  end if;

  insert into public.agent_action_items(
    proposal_id,kind,destination_module,destination_path,destination_record_id,
    title,summary,payload,status,created_by
  ) values (
    v_proposal.id,v_proposal.kind,v_destination_module,v_destination_path,v_destination_record_id,
    v_proposal.title,v_message,v_proposal.payload,v_action_status,auth.uid()
  ) returning id into v_action_item_id;

  insert into public.activity_logs(actor_id,entity_type,entity_id,action,metadata)
  values(
    auth.uid(),'agent_action_item',v_action_item_id,'approved_and_materialized',
    jsonb_build_object(
      'proposal_id',v_proposal.id,
      'kind',v_proposal.kind,
      'destination_module',v_destination_module,
      'destination_record_id',v_destination_record_id
    )
  );

  return jsonb_build_object(
    'decision','approved',
    'proposal_id',p_proposal_id,
    'action_item_id',v_action_item_id,
    'destination_module',v_destination_module,
    'destination_path',v_destination_path,
    'destination_record_id',v_destination_record_id,
    'message',v_message
  );
end $$;

revoke all on function public.decide_action_proposal(uuid,text,text) from public;
grant execute on function public.decide_action_proposal(uuid,text,text) to authenticated;

comment on table public.agent_action_items is
  'Resultado trazable de aprobar una propuesta. Nunca implica envio, cobro ni compra automatica.';
comment on table public.foreign_trade_purchase_drafts is
  'Compras sugeridas aprobadas para preparacion humana antes de emitir una orden real.';

commit;

select
  to_regclass('public.agent_action_items') as action_items,
  to_regclass('public.foreign_trade_purchase_drafts') as purchase_drafts,
  to_regprocedure('public.decide_action_proposal(uuid,text,text)') as approval_dispatcher;
