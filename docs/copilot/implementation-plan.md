# Plan de implementacion del copiloto OpenAI

## Fase 0: descubrimiento y diseno

Entregables locales:

- `docs/copilot/architecture-discovery.md`
- `docs/copilot/implementation-plan.md`
- `supabase/openai_copilot.sql`

Criterios:

- Confirmar stack real del CRM.
- Identificar entidades y permisos existentes.
- Documentar riesgos: especialmente ausencia de tenant real.
- No desplegar ni migrar sin aprobacion.

## Fase 1: copiloto de texto solo lectura

Archivos previstos:

- `supabase/functions/crm-copilot/index.ts`
- `src/lib/copilotApi.ts`
- `src/modules/copilot/CopilotPage.tsx`
- `src/App.tsx`
- `src/modules/layout/AppLayout.tsx`
- `src/styles.css`
- `supabase/config.toml`
- `.env.example`

Capacidades:

- Chat protegido por sesion Supabase.
- Validacion de usuario activo y rol.
- Llamada server-side a OpenAI Responses API.
- Herramientas de lectura del CRM con esquemas internos tipados.
- Resumen de segmentos y metricas.
- Auditoria basica por conversacion, mensaje y tool run.
- Estados visibles de carga, exito y error.

Variables de entorno requeridas en la Edge Function:

- `OPENAI_API_KEY`
- `OPENAI_TEXT_MODEL`
- `OPENAI_REASONING_EFFORT`
- `OPENAI_STORE_RESPONSES`
- `OPENAI_REQUEST_TIMEOUT_MS`
- `OPENAI_MAX_TOOL_ROUNDS`
- `OPENAI_MAX_OUTPUT_TOKENS`
- `COPILOT_ENABLED`

Valor inicial recomendado:

- `OPENAI_TEXT_MODEL=gpt-4.1-mini` hasta verificar oficialmente el modelo final que se quiera contratar.
- `OPENAI_STORE_RESPONSES=false`

Nota: si se desea usar un modelo distinto, debe verificarse disponibilidad y costo antes de ponerlo en produccion.

## Fase 2: campanas y tareas gobernadas

No incluida en el MVP.

Pendiente:

- `create_campaign_draft`
- `validate_campaign_draft`
- `prepare_campaign_schedule`
- `commit_campaign_schedule`
- `prepare_task_assignment`
- `commit_task_assignment`

Criterios:

- Confirmaciones persistentes vinculadas a usuario, accion, parametros, cantidad y expiracion.
- Idempotencia obligatoria.
- Sin envios externos sin confirmacion visual.

## Fase 3: dashboards

No incluida en el MVP.

Pendiente:

- Catalogo completo de KPI.
- Especificacion analitica guardable.
- Graficos con libreria compatible.
- Trazabilidad de fuente, periodo y filtros.

## Fase 4: voz

No incluida en el MVP.

Primera version:

- Captura/transcripcion.
- Reutilizar el mismo endpoint y motor de politicas.
- Respuestas breves para modo conduccion.
- Acciones sensibles solo pendientes, nunca confirmadas por ruido o silencio.

## Fase 5: endurecimiento

Pendiente:

- Rate limits por usuario.
- Presupuesto de tokens/costo.
- Panel de auditoria.
- Evaluaciones automatizadas en espanol chileno.
- Runbook de apagado y rollback.
- Modelo de tenant real si CRM sera multiempresa.

## Criterios de aceptacion del MVP local

- `npm run build` pasa.
- El frontend compila sin exponer `OPENAI_API_KEY`.
- La Edge Function devuelve error claro si faltan secretos.
- El usuario debe estar autenticado.
- Usuarios inactivos o sin rol valido son rechazados.
- Solo herramientas de lectura estan registradas.
- No existe SQL generado por el modelo.
- Las tablas de auditoria usan RLS para usuarios propios y administradores.
