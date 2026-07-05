# API keys para agentes

Este proyecto incluye `supabase/agent_api_keys.sql` para crear llaves API destinadas a agentes externos futuros.

## Activar el sistema

1. Ejecuta primero `supabase/setup_climactiva_crm_demo.sql`.
2. Crea tu usuario real en Supabase Auth.
3. Inserta tu perfil con rol `administrador`.
4. Ejecuta `supabase/agent_api_keys.sql` en Supabase SQL Editor.

## Crear una llave

Primero confirma que la funcion quedo instalada:

```sql
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name = 'create_agent_api_key';
```

Si no devuelve una fila, ejecuta completo `supabase/agent_api_keys.sql` antes de seguir.

Luego, en Supabase SQL Editor, ejecuta:

```sql
select *
from public.create_agent_api_key(
  'Agente CRM principal'::text,
  array['crm:read', 'crm:write']::text[],
  (now() + interval '180 days')::timestamptz
);
```

Copia el valor `api_key` inmediatamente. Supabase solo guarda el hash, asi que no se puede recuperar despues.

## Validar una llave desde un agente o backend

Tus agentes deberian enviar la llave en un header, por ejemplo:

```http
X-Climactiva-Api-Key: ca_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

El backend, Edge Function o servicio intermedio debe validar la llave antes de leer o escribir datos:

```sql
select *
from public.validate_agent_api_key(
  'ca_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'crm:read'
);
```

Si `valid` es `true`, la llave esta activa, no vencida y tiene el permiso requerido.

## Permisos sugeridos

- `crm:read`: leer empresas, contactos, interacciones, campanas y tareas.
- `crm:write`: crear o actualizar registros comerciales.
- `campaigns:send`: preparar o ejecutar envios de campanas.
- `admin:read`: consultar configuracion administrativa.

No uses la `service_role key` de Supabase en el navegador ni dentro de agentes que no controles completamente. Para integraciones publicas, crea una Edge Function o backend propio que reciba `X-Climactiva-Api-Key`, valide con `validate_agent_api_key` y recien despues ejecute la accion.

## Endpoint para agentes

Este repo incluye la Edge Function `supabase/functions/crm-agent/index.ts`.

Variables necesarias en Supabase Functions:

```bash
SUPABASE_URL=https://TU_PROYECTO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=TU_SERVICE_ROLE_KEY
```

En self-hosted usa la URL publica de tu Supabase como `SUPABASE_URL`.

Desplegar:

```bash
supabase functions deploy crm-agent --no-verify-jwt
```

Probar validacion:

```bash
curl -X GET "https://TU_SUPABASE/functions/v1/crm-agent/validate" \
  -H "X-Climactiva-Api-Key: ca_live_TU_LLAVE"
```

Leer empresas:

```bash
curl -X GET "https://TU_SUPABASE/functions/v1/crm-agent/companies?limit=20" \
  -H "X-Climactiva-Api-Key: ca_live_TU_LLAVE"
```

Crear una empresa:

```bash
curl -X POST "https://TU_SUPABASE/functions/v1/crm-agent/companies" \
  -H "Content-Type: application/json" \
  -H "X-Climactiva-Api-Key: ca_live_TU_LLAVE" \
  -d '{"name":"Nueva empresa agente","type":"otro","status":"prospecto","priority":"media"}'
```

Rutas incluidas:

- `GET /crm-agent/validate`
- `GET /crm-agent/companies`
- `GET /crm-agent/contacts`
- `GET /crm-agent/interactions`
- `GET /crm-agent/campaigns`
- `GET /crm-agent/message_templates`
- `GET /crm-agent/tasks`
- `GET /crm-agent/tags`
- `POST /crm-agent/companies`
- `POST /crm-agent/contacts`
- `POST /crm-agent/interactions`
- `POST /crm-agent/tasks`
- `PATCH /crm-agent/companies?id=...`
- `PATCH /crm-agent/contacts?id=...`
- `PATCH /crm-agent/interactions?id=...`
- `PATCH /crm-agent/tasks?id=...`
