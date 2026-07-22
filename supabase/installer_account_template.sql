-- Ejecutar en Supabase SQL Editor.
-- Agrega una plantilla comercial para invitar a tecnicos/instaladores a crear cuenta en climactiva.cl.

insert into public.message_templates (
  id,
  name,
  category,
  body,
  active
)
values (
  '00000000-0000-4000-9000-000000000004',
  'Invitacion cuenta instalador Clima Activa',
  'Instaladores',
  'Hola {{nombre_contacto}}, desde Clima Activa queremos invitar a {{nombre_empresa}} a crear una cuenta de instalador. {{beneficio}} Tambien contamos con stock de {{producto_destacado}} para tus trabajos en {{ciudad}}. Si quieres, te ayudamos a activar la cuenta.',
  true
)
on conflict (id) do update
set
  name = excluded.name,
  category = excluded.category,
  body = excluded.body,
  active = excluded.active,
  updated_at = now();
