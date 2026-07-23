-- Clima Activa CRM - Configuracion de produccion WhatsApp Meta
-- Ejecutar despues de supabase/whatsapp_meta_integration.sql.
-- No guarda tokens secretos. Los secretos van como variables de entorno en Dokploy/Supabase.

do $$
begin
  if exists (
    select 1 from public.whatsapp_settings
    where phone_number_id = '1136734189534018'
  ) then
    update public.whatsapp_settings
    set business_account_id = '2282055142597894',
        official_phone_number = '+56940951484',
        active = true,
        last_connection_status = 'numero_registrado_pendiente_webhook',
        last_connection_checked_at = now(),
        updated_at = now()
    where phone_number_id = '1136734189534018';
  else
    insert into public.whatsapp_settings (
      phone_number_id,
      business_account_id,
      official_phone_number,
      active,
      last_connection_status,
      last_connection_checked_at,
      access_token_hint
    )
    values (
      '1136734189534018',
      '2282055142597894',
      '+56940951484',
      true,
      'numero_registrado_pendiente_webhook',
      now(),
      null
    );
  end if;
end $$;

-- Evita duplicar mensajes entrantes si Meta reintenta el webhook.
create unique index if not exists whatsapp_messages_meta_message_id_unique
on public.whatsapp_messages(meta_message_id)
where meta_message_id is not null;

-- Permite que el CRM encuentre rapido la conversación por numero.
create index if not exists contacts_whatsapp_idx on public.contacts(whatsapp);
create index if not exists contacts_phone_idx on public.contacts(phone);
