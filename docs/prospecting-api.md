# API de prospeccion

La prospeccion es un modulo separado de las campanas de email/WhatsApp. El CRM
crea y revisa las ejecuciones; la Edge Function solo permite que un worker las
reclame y entregue resultados. Esta version no crea llaves API ni despliega la
funcion.

## Instalacion local

Ejecutar, en este orden, sobre una base que ya tenga el esquema del CRM:

1. `supabase/agent_api_keys.sql`
2. `supabase/prospecting.sql`

`prospecting.sql` es aditivo e idempotente. Incluye las 16 regiones y 346
comunas con CUT, agrega `region_code`/`comuna_code` sin eliminar los textos
historicos y solo hace backfill cuando la comuna se puede resolver sin
ambiguedad.

La futura llave del worker debe tener exclusivamente el scope
`prospecting:execute`. No usar `crm:write` ni una service-role fuera de la Edge
Function.

## Contrato del worker

Todas las rutas `POST` requieren:

```http
X-Climactiva-Api-Key: ca_live_...
Idempotency-Key: valor-unico-de-al-menos-8-caracteres
Content-Type: application/json
```

Una clave repetida en la misma operacion y con el mismo contenido devuelve la
respuesta original. La misma clave con contenido diferente responde `409`. Los
lotes aceptan entre 1 y 100 elementos y el cuerpo JSON completo no puede
superar 1 MB. Un request identico que todavia se esta procesando responde `425`
para que el outbox lo reintente; no se confunde con un conflicto permanente.

Rutas:

- `POST /crm-agent/prospecting-runs/claim`
- `POST /crm-agent/prospecting-runs/{runId}/heartbeat`
- `GET /crm-agent/prospecting-runs/{runId}`
- `POST /crm-agent/prospecting-runs/{runId}/events/batch`
- `POST /crm-agent/prospecting-runs/{runId}/candidates/batch`
- `POST /crm-agent/prospecting-runs/{runId}/complete`
- `POST /crm-agent/prospecting-runs/{runId}/fail`

Claim:

```json
{
  "worker_id": "worker-local-01",
  "lease_seconds": 120
}
```

Las demas escrituras incluyen `worker_id` y `lease_token`. Heartbeat admite
ademas `lease_seconds`; events usa `events`; candidates usa `candidates`;
complete usa `status` (`completed`, `partial` o `cancelled`) y `stats`; fail usa
`error`.

El snapshot de claim usa el contrato estable en snake_case:
`schema_version`, `crm_run_id`, `campaign_version`, `campaign` (con
`crm_campaign_id`, territorios CUT, keywords, fuentes y limites),
`requested_at` y `requested_by`. `official_website` habilita enriquecimiento,
pero no crea tareas territoriales; solo `google_places` y `brave_search` las
crean. Si una definicion habilita `brave_search`, debe habilitar tambien
`official_website`: el resultado de busqueda descubre el dominio, mientras que
el sitio oficial debe acreditar el contacto y la comuna antes de que el
candidato supere el filtro territorial.

Claim devuelve todas las tareas con su estado e intentos, ademas de
`candidates_found`. Esto permite reconstruir el worker aun si se pierde por
completo su base local. Un lease dura 120 segundos por defecto, se renueva cada
30 y ninguna escritura —incluidos complete/fail— se acepta despues de vencer.

Cada candidato debe incluir nombre, ubicacion con CUT, al menos un contacto y
evidencia fechada que coincida con cada campo externo informado. Cada evidencia necesita
`provider` y al menos `source_url` o `provider_record_id`. No se aceptan payloads
crudos de proveedores. Cada candidato admite hasta 100 evidencias y 50 sedes;
los textos y URLs tambien tienen limites defensivos. La evidencia de Google
Places se marca con vencimiento de 30 dias.

La aprobacion exige, dentro del mismo run, nombre, comuna y un contacto cuyo
valor este respaldado por Brave Search o por el sitio oficial. Un candidato
Google-only puede revisarse mientras su evidencia este vigente, pero nunca se
materializa permanentemente en `companies`. Los valores copiados al CRM son
exclusivamente los que coinciden con evidencia almacenable.

El payload puede enviar `locations` (hasta 50 sedes) o el campo legado
`location`. Cada sede se valida por CUT contra el snapshot y se conserva una
ubicacion principal. Para varias sedes, los campos de evidencia usan rutas
indexadas como `locations[1].comuna_code`; solo se importa una sucursal con
evidencia permanente atribuida a esa ubicacion. Para mostrar evidencia vigente, el frontend debe consultar
`active_prospect_source_records`, que usa RLS del registro base.

`prospecting.sql` programa diariamente la purga si `pg_cron` esta habilitado.
En proyectos sin esa extension se debe programar antes de produccion la llamada
interna `prospecting_purge_expired_source_records_internal()` con una identidad
de sistema; administradores pueden ejecutar manualmente
`purge_expired_prospect_source_records()`. La purga elimina snapshots Google-only,
rehidrata entidades mixtas desde fuentes permanentes y conserva en
`prospecting_retention_audits` solo conteos y ventanas de fechas.

## RPC del frontend

- `enqueue_prospecting_run(p_campaign_id, p_requested_by default auth.uid())`
- `request_prospecting_run_cancel(p_run_id)`
- `review_prospect_candidate(p_candidate_id, p_action, p_company_id default null, p_notes default null)`
- `approve_or_link_prospect_candidate(p_candidate_id, p_company_id default null, p_notes default null)`

`p_action` admite `approve`, `link` y `reject`. `link` exige una empresa
existente. Aprobar crea una empresa solo si no hay coincidencia exacta; solo
las ubicaciones del snapshot respaldadas permanentemente se materializan como
casa matriz/sucursales. Una entidad no puede vincularse a dos empresas. Ninguna
de estas operaciones crea destinatarios de campanas de mensajeria.

## Verificaciones recomendadas antes del despliegue

1. Encolar una campana con comunas parciales y comprobar que no se expande al
   resto de la region.
2. Verificar que una campana Brave-only se rechaza y que
   `official_website` no aumenta `total_tasks`.
3. Reclamar desde dos workers simultaneos: solo uno debe recibir cada run.
4. Repetir cada escritura con el mismo Idempotency-Key y luego con otro payload.
5. Enviar 101 eventos/candidatos, 101 evidencias o un cuerpo de mas de 1 MB y confirmar rechazo.
6. Probar lease vencido, heartbeat, cancelacion y recuperacion de run.
7. Rechazar candidatos fuera de CUT, sin contacto o sin evidencia minima.
8. Ingerir la misma empresa por RUT, provider ID, dominio, telefono y
   nombre+comuna; no debe duplicarse.
9. Vincular una entidad con varias sedes y comprobar que solo las respaldadas
   se copian una vez a `company_locations`.
10. Confirmar que `/campanas` y `campaign_recipients` no cambian.
11. Vencer evidencia Google, ejecutar el purge y comprobar que se elimina
    mientras la evidencia Brave/official_website sin vencimiento permanece.

Prueba automatizada local:

```powershell
npm run test:prospecting
```

Ejecuta el esquema en PostgreSQL WASM, lo repite, simula una migracion parcial
y cubre limites, historial por run, aprobacion, retencion, leases y sucursales.
