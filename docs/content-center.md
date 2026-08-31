# Centro de Contenido Inteligente

Módulo nativo del CRM para catálogo Tiendanube, generación fundamentada con IA, calendario editorial, aprobación, publicación en Instagram/Facebook, piloto automático, historial y métricas.

## Arquitectura

- `content_products` normaliza `integration_records` sin reemplazar Tiendanube como fuente oficial.
- La Edge Function `content-center` concentra autenticación, permisos, OpenAI, Meta y trabajos privilegiados.
- `content_jobs` es una cola con lease, reintentos exponenciales e idempotencia por operación.
- `SocialChannelAdapter` desacopla los canales. Las primeras implementaciones son Instagram y Facebook.
- El scheduler se activa desde Dokploy; no depende de una pestaña abierta.
- El Copiloto usa la misma Edge Function con el JWT del usuario y solo crea borradores pendientes de aprobación.

## Instalación

1. Ejecutar `supabase/content_center.sql` después de `schema.sql` y `agent_hub.sql`.
2. Desplegar completa la carpeta `supabase/functions/content-center`, incluidos `content-logic.ts` y `social-adapters.ts`.
3. Volver a desplegar `supabase/functions/crm-copilot` para habilitar sus herramientas del Centro de Contenido.
4. Confirmar que `supabase/config.toml` contiene `verify_jwt = false` para `content-center`. La función valida el JWT y los permisos internamente.
5. Volver a desplegar el frontend del CRM.

Antes del despliegue ejecutar:

```bash
npm run lint
npm run test:content
npm run build
```

## Secretos del backend

Configurar en el servicio de Edge Functions de Supabase dentro de Dokploy. Nunca usar nombres `VITE_*` para estos valores.

```dotenv
CRM_APP_URL=https://crm.latinchile.cl
OPENAI_API_KEY=...
OPENAI_CONTENT_MODEL=gpt-4.1-mini
OPENAI_REQUEST_TIMEOUT_MS=45000

META_GRAPH_API_VERSION=v25.0
META_SOCIAL_ACCESS_TOKEN=...
META_FACEBOOK_PAGE_ID=...
META_INSTAGRAM_BUSINESS_ACCOUNT_ID=...

CONTENT_SCHEDULER_SECRET=una-cadena-aleatoria-larga-y-privada
```

El token de Meta debe pertenecer a una aplicación autorizada para administrar la página y la cuenta profesional de Instagram asociada. La pantalla `Administración > Instagram y Facebook` valida la conexión sin mostrar secretos.

Para publicar en Facebook, el token de usuario debe incluir `pages_show_list`, `pages_read_engagement` y `pages_manage_posts`. Después se debe consultar `/me/accounts?fields=id,name,access_token,tasks,instagram_business_account` y guardar en `META_SOCIAL_ACCESS_TOKEN` el `access_token` de la página, no el token de usuario temporal. La página debe incluir la tarea `CREATE_CONTENT`. Si Meta no permite solicitar `pages_manage_posts`, habilitar ese permiso o caso de uso en el panel de la aplicación y completar App Review cuando la aplicación vaya a ser usada por personas que no tengan un rol en ella.

El catálogo conserva la galería completa de cada producto como información de origen, pero cada publicación utiliza únicamente la imagen principal. La diagramación, la vista previa y los adaptadores de Instagram/Facebook reciben una sola URL HTTPS, incluso cuando un borrador anterior conserva varias imágenes en sus datos históricos.

No usar el token temporal de una hora generado por Graph API Explorer para automatizaciones. Un token de larga duración también debe supervisarse y reemplazarse cuando Meta lo invalide. Si el Centro de Contenido detecta el error 190 o el mensaje `Session has expired`, deshabilita ambos canales, detiene nuevas consultas de métricas y muestra una alerta en el calendario. Después de actualizar el secreto:

1. Volver a desplegar el servicio de Edge Functions para aplicar el nuevo secreto.
2. Entrar a `Administración > Instagram y Facebook` y ejecutar `Probar conexión real`.
3. Comprobar que ambos canales aparezcan conectados.
4. Revisar las publicaciones fallidas y usar `Publicar` manualmente. El sistema no publica contenido vencido de forma silenciosa.

## Scheduler en Dokploy

Crear una tarea cada minuto que realice una solicitud `POST` a:

```text
https://supabase.latinchile.cl/functions/v1/content-center/worker/run
```

Cabeceras:

```text
Content-Type: application/json
x-content-scheduler-secret: EL_MISMO_VALOR_DE_CONTENT_SCHEDULER_SECRET
```

Cuerpo:

```json
{"limit":10}
```

La ejecución puede repetirse sin duplicar publicaciones: los trabajos usan claves idempotentes y leases. Existe una ventana residual propia de APIs externas si Meta publica correctamente y el proceso se interrumpe antes de guardar el ID externo; revisar el historial antes de reintentar manualmente un caso incierto.

Los eventos `metrics_sync_*` son consultas diarias sobre publicaciones ya existentes. No representan intentos de publicar contenido en una fecha sin programación.

## Operación inicial

1. Entrar en `Administración` y probar Tiendanube, Instagram y Facebook.
2. Abrir `Centro de Contenido`.
3. Sincronizar el catálogo si la primera sincronización no se inicia automáticamente.
4. Completar `Personalidad de Marca`.
5. Revisar las plantillas iniciales.
6. Generar un borrador y comprobar los hechos del producto.
7. Aprobar y programar una prueba.
8. Activar Piloto Automático solo después de validar una publicación real por canal.

## Seguridad y observabilidad

- RLS reutiliza los roles `administrador`, `vendedor` y `visualizador`.
- Solo un administrador aprueba, publica, modifica marca/plantillas o activa el piloto automático.
- Los textos generados pasan control de cifras y una segunda auditoría factual antes de guardarse.
- `content_history` registra sincronización, generación, aprobación, programación, publicación, métricas y errores con correlation/job IDs.
- No se guardan access tokens, claves OpenAI ni secretos del scheduler en tablas o frontend.

## Recuperación

Para detener la automatización sin borrar datos, desactivar las reglas en `Piloto Automático` y pausar el cron de Dokploy. No eliminar tablas ni recrear servicios. Los borradores, historial y métricas quedan disponibles para diagnóstico.
