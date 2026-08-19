-- CRM LatinChile - aumenta el limite diario interno de Gmail a 200.
-- Ejecutar una vez en Supabase SQL Editor para actualizar la integracion existente.

alter table public.gmail_integrations
alter column daily_limit set default 200;

update public.gmail_integrations
set daily_limit = 200,
    updated_at = now()
where daily_limit <> 200;

select id, connected_email, status, daily_limit, sent_today
from public.gmail_integrations;
