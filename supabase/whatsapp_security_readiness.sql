-- Clima Activa CRM - refuerzo seguridad/compliance WhatsApp para demo Meta.
-- Ejecutar en Supabase SQL Editor.

alter table public.companies
  add column if not exists whatsapp_opt_in boolean not null default false,
  add column if not exists whatsapp_status text not null default 'sin_consentimiento';

alter table public.companies
  drop constraint if exists companies_whatsapp_status_check;

alter table public.companies
  add constraint companies_whatsapp_status_check
  check (whatsapp_status in ('sin_consentimiento', 'opt_in', 'opt_out', 'bloqueado', 'invalido', 'no_contactar'));

update public.companies
set whatsapp_opt_in = false
where whatsapp_status in ('opt_out', 'bloqueado', 'invalido', 'no_contactar')
  and whatsapp_opt_in is true;

create index if not exists companies_whatsapp_status_idx on public.companies(whatsapp_status);
create index if not exists companies_last_whatsapp_message_idx on public.companies(last_whatsapp_message_at desc);

comment on column public.companies.whatsapp_status is
  'Estado comercial WhatsApp: sin_consentimiento, opt_in, opt_out, bloqueado, invalido o no_contactar. Campañas no deben enviar a opt_out/bloqueado/invalido/no_contactar.';

comment on table public.whatsapp_messages is
  'Registro auditable de mensajes WhatsApp entrantes y salientes procesados por Meta Cloud API.';
