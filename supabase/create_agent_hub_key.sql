-- Ejecutar DESPUES de agent_api_keys.sql y agent_hub.sql.
-- La columna api_key se muestra una sola vez. Copiarla inmediatamente a
-- CRM_API_KEY en el Environment privado del Agent Hub en Dokploy.

select *
from public.create_agent_api_key(
  'Clima Activa Agent Hub',
  array['prospecting:execute','agent-hub:execute'],
  now() + interval '1 year'
);
