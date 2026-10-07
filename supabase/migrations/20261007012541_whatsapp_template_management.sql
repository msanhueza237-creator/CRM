begin;

alter table public.whatsapp_settings add column management_policy jsonb not null default '{"revision":"2026-10-06","verifiedAt":"2026-10-06","graphVersion":"v26.0","categories":["MARKETING","UTILITY","AUTHENTICATION"],"languages":["es_CL","es","es_AR","es_CO","es_MX","es_PE","es_ES","en_US","en_GB","pt_BR"],"limits":{"name":512,"body":1024,"header":60,"footer":60,"buttonText":25,"buttons":10,"urlButtons":2,"phoneButtons":1},"source":"https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview"}'::jsonb;

alter table public.whatsapp_templates
  add column waba_id text,
  add column meta_template_id text,
  add column components jsonb not null default '[]'::jsonb,
  add column variable_bindings jsonb not null default '[]'::jsonb,
  add column description text not null default '',
  add column parameter_format text not null default 'POSITIONAL',
  add column draft jsonb,
  add column local_state text not null default 'DRAFT',
  add column rejected_reason text,
  add column last_synced_at timestamptz,
  add column meta_updated_at timestamptz,
  add column meta_snapshot jsonb,
  add column revision integer not null default 1,
  add column submission_id uuid,
  add column updated_by uuid references public.profiles(id) on delete set null;

create unique index whatsapp_templates_meta_identity on public.whatsapp_templates(waba_id,meta_template_id) where meta_template_id is not null;
create unique index whatsapp_templates_named_identity on public.whatsapp_templates(waba_id,meta_template_name,language) where waba_id is not null;
alter table public.whatsapp_templates add constraint whatsapp_template_local_state check(local_state in ('DRAFT','SUBMITTING','SYNCED','UNCERTAIN','ARCHIVED'));

alter table public.companies add column whatsapp_opt_in_date timestamptz, add column whatsapp_opt_in_source text, add column whatsapp_opt_in_phone text;
alter table public.contacts add column whatsapp_opt_in boolean not null default false, add column whatsapp_opt_in_date timestamptz, add column whatsapp_opt_in_source text, add column whatsapp_opt_in_phone text, add column whatsapp_status text;
alter table public.whatsapp_messages add column template_meta_id text, add column template_language text, add column template_category text,
  add column actor_id uuid references public.profiles(id) on delete set null, add column recipient_country text,
  add column pricing jsonb, add column provider_response jsonb, add column provider_error jsonb;
alter table public.whatsapp_webhook_events add column event_key text;
create unique index whatsapp_webhook_event_identity on public.whatsapp_webhook_events(event_key) where event_key is not null;

-- Template writes and raw webhook/audit data are served through the role-checked backend.
revoke all on public.whatsapp_templates from anon, authenticated;
grant all on public.whatsapp_templates to service_role;
revoke all on public.whatsapp_messages from authenticated, anon;
grant select(id,company_id,contact_id,whatsapp_campaign_id,recipient_id,direction,phone_number,meta_message_id,message_type,template_name,body,status,occurred_at,raw_payload,created_at) on public.whatsapp_messages to authenticated;

-- Extend only the two previously deployed, service-role-only inbox RPC guards.
do $$
declare signature text; definition text; old_guard text := 'role = ''administrador'' and active is true';
begin
  foreach signature in array array['public.crm_whatsapp_inbox(uuid,text,text,integer,integer)','public.crm_whatsapp_set_read(uuid,uuid,text,uuid[],boolean)'] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if strpos(definition,old_guard) = 0 then raise exception 'Unexpected inbox authorization definition'; end if;
    execute replace(definition,old_guard,'role in (''administrador'',''vendedor'') and active is true');
  end loop;
end $$;

-- Consent changes and audit are atomic. A purchase/phone alone is never evidence.
create function public.crm_whatsapp_consent(p_user_id uuid,p_company_id uuid,p_contact_id uuid,p_phone text,p_allowed boolean,p_source text,p_evidence text)
returns void language plpgsql security invoker set search_path = '' as $$
declare target_phone text;
begin
  if not exists(select 1 from public.profiles where id=p_user_id and active is true and role in ('administrador','vendedor')) then raise exception 'Access denied' using errcode='42501'; end if;
  if p_allowed is null or p_source is null or p_phone is null or p_phone !~ '^[1-9][0-9]{7,14}$' or p_source not in ('WEB','CLIENTE','VENDEDOR','FORMULARIO','COMPRA','IMPORTACION','OTRO') or length(trim(coalesce(p_evidence,''))) < 5 or length(p_evidence)>2000 then raise exception 'Consent evidence required'; end if;
  if p_contact_id is null then
    select public.crm_whatsapp_inbox_phone(coalesce(nullif(whatsapp_number,''),nullif(whatsapp,''),phone)) into target_phone from public.companies where id=p_company_id for update;
    if target_phone is distinct from p_phone then raise exception 'Recipient changed'; end if;
    update public.companies set whatsapp_opt_in=p_allowed,whatsapp_status=case when p_allowed then 'opt_in' else 'opt_out' end,
      whatsapp_opt_in_date=now(),whatsapp_opt_in_source=p_source,whatsapp_opt_in_phone=p_phone where id=p_company_id;
  else
    select public.crm_whatsapp_inbox_phone(coalesce(nullif(whatsapp,''),phone)) into target_phone from public.contacts where id=p_contact_id and company_id=p_company_id for update;
    if target_phone is distinct from p_phone then raise exception 'Recipient changed'; end if;
    update public.contacts set whatsapp_opt_in=p_allowed,whatsapp_status=case when p_allowed then 'opt_in' else 'opt_out' end,
      whatsapp_opt_in_date=now(),whatsapp_opt_in_source=p_source,whatsapp_opt_in_phone=p_phone where id=p_contact_id;
  end if;
  insert into public.activity_logs(actor_id,entity_type,entity_id,action,metadata) values(p_user_id,'whatsapp_consent',p_company_id,'consent_recorded',jsonb_build_object('phone',p_phone,'contactId',p_contact_id,'allowed',p_allowed,'source',p_source,'evidence',p_evidence,'at',now()));
end $$;
revoke all on function public.crm_whatsapp_consent(uuid,uuid,uuid,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.crm_whatsapp_consent(uuid,uuid,uuid,text,boolean,text,text) to service_role;

-- Persist explicit opt-outs by exact number, including contacts and future messages.
create function public.crm_whatsapp_record_opt_out() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_phone text := public.crm_whatsapp_inbox_phone(new.phone_number);
begin
  if new.direction <> 'inbound' or trim(coalesce(new.body,'')) !~* '^(salir|stop|baja|no m[aá]s mensajes)$' then return new; end if;
  update public.companies set whatsapp_opt_in=false,whatsapp_status='opt_out',whatsapp_opt_in_phone=v_phone,whatsapp_opt_in_date=new.occurred_at,whatsapp_opt_in_source='CLIENTE'
    where public.crm_whatsapp_inbox_phone(coalesce(nullif(whatsapp_number,''),nullif(whatsapp,''),companies.phone))=v_phone;
  update public.contacts set whatsapp_opt_in=false,whatsapp_status='opt_out',whatsapp_opt_in_phone=v_phone,whatsapp_opt_in_date=new.occurred_at,whatsapp_opt_in_source='CLIENTE'
    where public.crm_whatsapp_inbox_phone(coalesce(nullif(whatsapp,''),contacts.phone))=v_phone;
  insert into public.activity_logs(entity_type,entity_id,action,metadata) values('whatsapp_consent',new.company_id,'customer_opt_out',jsonb_build_object('phone',v_phone,'messageId',new.meta_message_id,'at',new.occurred_at));
  return new;
end $$;
revoke all on function public.crm_whatsapp_record_opt_out() from public,anon,authenticated;
create trigger whatsapp_persist_opt_out after insert on public.whatsapp_messages for each row execute function public.crm_whatsapp_record_opt_out();

create function public.crm_whatsapp_message_status(p_meta_id text,p_payload jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare v jsonb := p_payload#>'{entry,0,changes,0,value,statuses,0}'; old_status text; incoming_status text := v->>'status'; event_at timestamptz;
begin
  if v->>'id' is distinct from p_meta_id or incoming_status not in ('sent','delivered','read','failed') then raise exception 'Invalid status event'; end if;
  select status into old_status from public.whatsapp_messages where meta_message_id=p_meta_id for update;
  if old_status is null then return; end if;
  event_at := case when coalesce(v->>'timestamp','') ~ '^[0-9]{1,12}$' then to_timestamp((v->>'timestamp')::double precision) else now() end;
  if old_status='read' or (old_status='delivered' and incoming_status in ('sent','failed')) or (old_status='failed' and incoming_status='sent') then return; end if;
  update public.whatsapp_messages set status=incoming_status,pricing=coalesce(v->'pricing',pricing),provider_error=coalesce(v->'errors',provider_error),
    provider_response=jsonb_build_object('status',v,'received_at',now()) where meta_message_id=p_meta_id;
  update public.whatsapp_campaign_recipients set status=incoming_status,
    sent_at=case when incoming_status='sent' then event_at else sent_at end,
    delivered_at=case when incoming_status='delivered' then event_at else delivered_at end,
    read_at=case when incoming_status='read' then event_at else read_at end,
    failed_at=case when incoming_status='failed' then event_at else failed_at end where meta_message_id=p_meta_id;
end $$;
revoke all on function public.crm_whatsapp_message_status(text,jsonb) from public,anon,authenticated;
grant execute on function public.crm_whatsapp_message_status(text,jsonb) to service_role;

-- Fictional examples only. No Meta calls or customer messages are made by this migration.
with seeds(name,title,category,body,description,bindings) as (values
 ('cobranza_factura_pendiente','Cobranza de factura','UTILITY','Hola {{1}}, en Clima Activa registramos la factura {{2}} por {{3}} con vencimiento el {{4}} pendiente de pago. Si ya pagaste o necesitas revisar el detalle, responde este mensaje.','Aviso exclusivamente transaccional sobre una factura real, sin promociones.','[{"key":"1","field":"nombre_cliente","example":"Cliente de ejemplo"},{"key":"2","field":"numero_factura","example":"12345"},{"key":"3","field":"monto","example":"$450.000 CLP"},{"key":"4","field":"fecha_vencimiento","example":"15-10-2026"}]'::jsonb),
 ('pedido_confirmado','Confirmación de pedido','UTILITY','Hola {{1}}, Clima Activa confirma la recepción de tu pedido {{2}}. Responde este mensaje si necesitas revisar sus datos.','Confirmación de un pedido previamente realizado; no confirma pago.','[{"key":"1","field":"nombre_cliente","example":"Cliente de ejemplo"},{"key":"2","field":"numero_pedido","example":"PED-100"}]'::jsonb),
 ('pedido_preparado','Pedido preparado','UTILITY','Hola {{1}}, tu pedido {{2}} de Clima Activa está preparado. Responde este mensaje para coordinar la entrega acordada.','Actualización operativa de un pedido real.','[{"key":"1","field":"nombre_cliente","example":"Cliente de ejemplo"},{"key":"2","field":"numero_pedido","example":"PED-100"}]'::jsonb),
 ('pedido_despachado','Despacho realizado','UTILITY','Hola {{1}}, despachamos tu pedido {{2}} de Clima Activa mediante {{3}}. El número de seguimiento es {{4}}. Responde si necesitas ayuda con la entrega.','Notificación de despacho efectivamente realizado.','[{"key":"1","field":"nombre_cliente","example":"Cliente de ejemplo"},{"key":"2","field":"numero_pedido","example":"PED-100"},{"key":"3","field":"transportista","example":"Transportista de ejemplo"},{"key":"4","field":"tracking","example":"ENV-100"}]'::jsonb),
 ('cotizacion_disponible','Cotización solicitada disponible','UTILITY','Hola {{1}}, la cotización {{2}} que solicitaste a Clima Activa ya está disponible. Responde este mensaje para recibirla o aclarar sus detalles.','Solo respuesta a una solicitud específica y vigente del cliente. Sin venta cruzada ni promoción.','[{"key":"1","field":"nombre_cliente","example":"Cliente de ejemplo"},{"key":"2","field":"numero_cotizacion","example":"COT-100"}]'::jsonb),
 ('seguimiento_cotizacion','Seguimiento de cotización','MARKETING','Hola {{1}}, te contactamos de Clima Activa por la cotización {{2}}. ¿Te gustaría retomarla o resolver alguna duda? Para dejar de recibir comunicaciones comerciales, responde SALIR.','Seguimiento comercial; no se clasifica como Utility para reducir costos.','[{"key":"1","field":"nombre_cliente","example":"Cliente de ejemplo"},{"key":"2","field":"numero_cotizacion","example":"COT-100"}]'::jsonb),
 ('producto_disponible','Disponibilidad de producto','MARKETING','Hola {{1}}, en Clima Activa tenemos disponibilidad de {{2}}. Responde si te interesa consultar sus condiciones. Para dejar de recibir comunicaciones comerciales, responde SALIR.','Aviso comercial de disponibilidad; exige autorización vigente.','[{"key":"1","field":"nombre_cliente","example":"Cliente de ejemplo"},{"key":"2","field":"producto","example":"Producto de ejemplo"}]'::jsonb),
 ('informacion_comercial','Información comercial','MARKETING','Hola {{1}}, somos Clima Activa. Podemos ayudarte con información de nuestros productos de climatización. Responde si deseas asesoría. Para dejar de recibir comunicaciones comerciales, responde SALIR.','Comunicación comercial; no constituye autorización para contactar números importados.','[{"key":"1","field":"nombre_cliente","example":"Cliente de ejemplo"}]'::jsonb)
), account as (select business_account_id waba from public.whatsapp_settings where active is true order by updated_at desc limit 1)
insert into public.whatsapp_templates(internal_name,meta_template_name,language,category,preview_body,description,variable_bindings,draft,waba_id,local_state,status,active)
select title,name,'es_CL',category,body,description,bindings,
  jsonb_build_object('internalName',title,'name',name,'language','es_CL','category',category,'header','','body',body,'footer','Clima Activa','description',description,'bindings',bindings,'buttons','[]'::jsonb,'purposeConfirmed',false),
  waba,'DRAFT','DRAFT',true from seeds cross join account
where waba is not null
on conflict(waba_id,meta_template_name,language) where waba_id is not null do nothing;

notify pgrst,'reload schema';
commit;
